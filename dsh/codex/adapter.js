// The Codex subscription adapter.
//
// A plain object, like the Claude route: the registry validates the metadata
// this returns, never the class it came from.

const { randomUUID } = require('node:crypto')
const { SubscriptionError, httpErrorCode, redact, retryAfterMs } = require('../errors.js')
const { idleWatchdog } = require('../watchdog.js')
const { parseSse } = require('./sse.js')
const { serializeRequest } = require('./serialize.js')
const { translate } = require('./translate.js')

/** The provider route this adapter serves. */
const PROVIDER = 'codex-oauth'

/**
 * The Codex CLI identity the backend gates on.
 *
 * The subscription endpoint classifies traffic by these, the same way the
 * Anthropic route depends on its system preamble.
 */
const ORIGINATOR = 'codex-tui'
const USER_AGENT = 'codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)'

/** Project one catalog entry onto the harness model-info entry. */
function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

/**
 * Build the Codex adapter.
 *
 * @param {object} deps - `config` (resolved) and `resolveAccess()` returning
 *   the access token plus the account id the backend routes on.
 * @returns {object} the adapter the registry accepts.
 */
function createCodexAdapter({ config, resolveAccess }) {
  async function* request(options, signal, access, onActivity) {
    // Serialized outside the try so an unsupported-content refusal is never
    // reported as an unreachable endpoint.
    const body = JSON.stringify(serializeRequest(options, {}))
    let response
    try {
      response = await fetch(`${config.codexBaseURL}/codex/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access.token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'openai-beta': 'responses=experimental',
          originator: ORIGINATOR,
          'user-agent': USER_AGENT,
          session_id: randomUUID(),
          // Absent when the credential carries no account: sending an empty
          // header routes the request to the wrong workspace.
          ...access.accountId.length === 0 ? {} : { 'chatgpt-account-id': access.accountId },
        },
        body,
        signal,
      })
    } catch (error) {
      throw new SubscriptionError(`Codex at ${config.codexBaseURL} is unreachable`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let wire
      try {
        wire = JSON.parse(text)?.error
      } catch {
        // A non-JSON error body still describes the failure; the status code
        // carries the classification either way.
      }
      const detail = [wire?.type, wire?.code, wire?.message].filter(part => typeof part === 'string').join(' ') || text
      throw new SubscriptionError(
        `Codex API error (HTTP ${String(response.status)}): ${redact(detail)}`,
        httpErrorCode(response.status, detail),
        {
          status: response.status,
          ...retryAfterMs(response.headers.get('retry-after')) === undefined
            ? {}
            : { providerRetryAfterMs: retryAfterMs(response.headers.get('retry-after')) },
        },
      )
    }
    if (response.body === null) {
      throw new SubscriptionError('Codex API returned no response body', 'TRANSPORT')
    }
    yield* translate(parseSse(response.body, onActivity))
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: 'Codex (subscription)' }
    },

    providerRetryPolicy(_provider) {
      return config.retryPolicy
    },

    listModels(provider) {
      return Promise.resolve(config.codexModels.map(model => modelInfo(provider, model)))
    },

    resolveModel(provider, model) {
      const configured = config.codexModels.find(entry => entry.id === model)
      return Promise.resolve({
        ...configured === undefined
          ? { provider, id: model, name: model, inputModalities: ['text'] }
          : modelInfo(provider, configured),
        context: { contextWindow: configured?.contextWindow ?? config.defaultContextWindow },
        defaultMaxTokens: configured?.maxTokens ?? config.maxTokens,
      })
    },

    async * stream(options) {
      const access = await resolveAccess()
      if (access === undefined) {
        throw new SubscriptionError(
          `Codex subscription is not connected; open http://127.0.0.1:${String(config.controlPort)}/codex/start to sign in`,
          'MISSING_CREDENTIAL',
        )
      }
      const consumer = new AbortController()
      const upstream = options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])
      const watchdog = idleWatchdog(upstream, config.streamIdleTimeoutMs)
      const iterator = request(options, watchdog.signal, access, () => { watchdog.pulse() })[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done === true) {
            exhausted = true
            return
          }
          yield result.value
        }
      } catch (error) {
        if (watchdog.timedOut) {
          throw new SubscriptionError(
            `Codex stream idle timeout after ${String(config.streamIdleTimeoutMs)}ms`,
            'TIMEOUT',
            { cause: error },
          )
        }
        if (options.signal?.aborted === true) {
          throw new SubscriptionError('Codex request aborted by caller', 'ABORTED', { cause: error })
        }
        if (error instanceof SubscriptionError) throw error
        throw new SubscriptionError(`Codex stream from ${config.codexBaseURL} failed`, 'TRANSPORT', { cause: error })
      } finally {
        watchdog.dispose()
        consumer.abort('Codex stream consumer stopped')
        if (!exhausted && iterator.return !== undefined) {
          try {
            await iterator.return()
          } catch {
            // The consumer controller already owns termination; a return-time
            // abort cannot add a second outcome.
          }
        }
      }
    },
  }
}

module.exports = { ORIGINATOR, PROVIDER, USER_AGENT, createCodexAdapter }
