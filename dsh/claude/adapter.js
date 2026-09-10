// The Claude subscription adapter.
//
// A plain object, not a subclass: the registry validates the metadata this
// returns, never the class it came from, so a standalone plugin can supply
// the same surface without importing the harness.

const { SubscriptionError, httpErrorCode, redact, retryAfterMs } = require('../errors.js')
const { idleWatchdog } = require('../watchdog.js')
const { parseSse } = require('./sse.js')
const { contentHasImage, serializeRequest, serializeRequestWithImages } = require('./serialize.js')
const { translate } = require('./translate.js')
const { claudeCodeUserAgent, claudeCodeVersionResolver } = require('../client-version.js')

/** The provider route this adapter serves. */
const PROVIDER = 'claude-code-oauth'
const { reasoningMetadata, assertReasoningEffort } = require('../reasoning.js')

/**
 * The beta features the Claude Code client identifies with, in wire order.
 *
 * The subscription backend gates on this list together with the user agent
 * and the system preamble; a request without them is answered
 * `rate_limit_error` even on models the subscription serves.
 */
const OAUTH_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
  'extended-cache-ttl-2025-04-11',
].join(',')

/** Project one catalog entry onto the harness model-info entry. */
function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    // The catalog states this per model, not per route, and the composer gates
    // attachment on exactly this field.
    inputModalities: [...model.inputModalities ?? ['text']],
  }
}

/**
 * Build the Claude adapter.
 *
 * @param {object} deps - `config` (resolved), `resolveAccessToken()`, and an
 *   optional `resolveAttachments()` for image input.
 * @returns {object} the adapter the registry accepts.
 */
function createClaudeAdapter({ config, resolveAccessToken, resolveAttachments }) {
  // Resolved per request, not at build: the installed CLI may auto-update while
  // the Host runs, and the backend rejects models newer than the version sent.
  const clientVersion = claudeCodeVersionResolver(config)
  async function* request(options, signal, accessToken, attachments, onActivity) {
    // Serialized outside the try: refusing unsupported content is a statement
    // about the request, and the transport's catch would report it as an
    // unreachable endpoint.
    const body = JSON.stringify(attachments === undefined
      ? serializeRequest(options, { maxTokens: config.maxTokens })
      : await serializeRequestWithImages(options, { maxTokens: config.maxTokens }, attachments, signal))
    let response
    try {
      response = await fetch(`${config.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          // The bearer never appears in any error this function raises.
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': OAUTH_BETAS,
          'x-app': 'cli',
          'user-agent': claudeCodeUserAgent(clientVersion().version),
        },
        body,
        signal,
      })
    } catch (error) {
      throw new SubscriptionError(`Claude at ${config.baseURL} is unreachable`, 'TRANSPORT', { cause: error })
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
      const detail = [wire?.type, wire?.message].filter(part => typeof part === 'string').join(' ') || text
      throw new SubscriptionError(
        `Claude API error (HTTP ${String(response.status)}): ${redact(detail)}`,
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
      throw new SubscriptionError('Claude API returned no response body', 'TRANSPORT')
    }
    yield* translate(parseSse(response.body, onActivity))
  }

  return {
    providerInfo(provider) {
      // Called synchronously inside registerAdapter for every requested route,
      // so it must never throw, for any argument.
      return { id: provider, name: 'Claude (subscription)' }
    },

    providerRetryPolicy(_provider) {
      return config.retryPolicy
    },

    imageRequestPricing(_provider, _model) {
      return undefined
    },

    /** Bind model metadata and dispatch to this adapter's fixed configuration. */
    async prepareCall(provider, model, signal) {
      const stream = this.stream.bind(this)
      return { model: await this.resolveModel(provider, model, signal), stream }
    },

    listModels(provider) {
      return Promise.resolve(config.claudeModels.map(model => modelInfo(provider, model)))
    },

    resolveModel(provider, model) {
      const configured = config.claudeModels.find(entry => entry.id === model)
      return Promise.resolve({
        // An uncatalogued model is treated as text-only: declaring unverified
        // image capability would let the host persist input the endpoint
        // refuses on every later turn.
        ...configured === undefined
          ? { provider, id: model, name: model, inputModalities: ['text'] }
          : modelInfo(provider, configured),
        context: { contextWindow: configured?.contextWindow ?? config.defaultContextWindow },
        defaultMaxTokens: configured?.maxTokens ?? config.maxTokens,
        ...reasoningMetadata('claude', model),
      })
    },

    async * stream(options) {
      assertReasoningEffort('claude', options.model, options.reasoningEffort)
      // Image capability is checked before the credential, the attachment
      // read, and the network: a model that cannot see the image must refuse
      // it here, while the operator can still pick another model.
      const hasImages = options.messages.some(message => contentHasImage(message.content))
      let attachments
      if (hasImages) {
        const model = config.claudeModels.find(entry => entry.id === options.model)
        if (model?.inputModalities?.includes('image') !== true) {
          throw new SubscriptionError(
            `Model "${options.model}" does not accept image input.`,
            'UNSUPPORTED_CONTENT',
          )
        }
        // Resolved per request, not at load: Cordis load order must not
        // decide whether images work for the whole process.
        attachments = resolveAttachments?.()
        if (attachments === undefined) {
          throw new SubscriptionError(
            'Image input requires the durable attachment service.',
            'UNSUPPORTED_CONTENT',
          )
        }
      }
      const accessToken = await resolveAccessToken()
      if (accessToken === undefined) {
        throw new SubscriptionError(
          `Claude subscription is not connected; open http://127.0.0.1:${String(config.controlPort)}/claude/start to sign in`,
          'MISSING_CREDENTIAL',
        )
      }
      const consumer = new AbortController()
      const upstream = options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])
      const watchdog = idleWatchdog(upstream, config.streamIdleTimeoutMs)
      const iterator = request(options, watchdog.signal, accessToken, attachments, () => { watchdog.pulse() })[Symbol.asyncIterator]()
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
            `Claude stream idle timeout after ${String(config.streamIdleTimeoutMs)}ms`,
            'TIMEOUT',
            { cause: error },
          )
        }
        if (options.signal?.aborted === true) {
          throw new SubscriptionError('Claude request aborted by caller', 'ABORTED', { cause: error })
        }
        if (error instanceof SubscriptionError) throw error
        throw new SubscriptionError(`Claude stream from ${config.baseURL} failed`, 'TRANSPORT', { cause: error })
      } finally {
        watchdog.dispose()
        consumer.abort('Claude stream consumer stopped')
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

module.exports = { OAUTH_BETAS, PROVIDER, createClaudeAdapter }
