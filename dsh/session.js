// One subscription's credential lifecycle: read, refresh, sign in, sign out.
//
// Both routes use this with different protocol constants. The refresh holds
// the writer lock across the whole read-check-POST-write cycle, which is what
// stops a second process from burning the refresh token: it blocks, then
// re-reads and finds the token already fresh.

const { SubscriptionError, redact } = require('./errors.js')
const { withFileLock } = require('./lock.js')
const {
  clearCredential,
  needsRefresh,
  readCredential,
  warnOnLoosePermissions,
  writeCredential,
} = require('./credential.js')
const { authorizeUrl, decodeJwtPayload, pkce, tokenRequest, waitForBrowserCallback } = require('./oauth.js')

/** How often the warm-up timer renews a token nobody has asked for. */
const REFRESH_INTERVAL_MS = 300_000

/**
 * How long a terminally rejected refresh blocks later attempts.
 *
 * The model-call retry policy treats a failed refresh as one more attempt to
 * redo; without a cooldown, three retries mean three refresh POSTs against an
 * endpoint that just said the grant is dead, and enough of those earn a
 * rate limit that also blocks the next real sign-in.
 */
const REFRESH_COOLDOWN_MS = 60_000

/**
 * Create one subscription session.
 *
 * @param {object} deps - `spec` (protocol constants), `filename`, `log`, and
 *   an optional `accountFrom(idToken, payload)` that extracts the account id.
 * @returns {object} the session API.
 */
function createSession({ spec, filename, log, accountFrom }) {
  let loginFlow
  let lastLoginError
  let refreshRejectedAt
  let lastRefreshError

  /**
   * Return a usable access token, refreshing near expiry.
   *
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object|undefined>} the access facts, or undefined when
   *   no credential is stored.
   */
  async function access(signal) {
    // A refresh rejected moments ago is still rejected: re-raise without
    // touching the endpoint, so the model-call retry policy cannot turn one
    // dead grant into a request storm.
    if (refreshRejectedAt !== undefined && Date.now() - refreshRejectedAt < REFRESH_COOLDOWN_MS) {
      throw lastRefreshError
    }
    return withFileLock(filename, async () => {
      const current = await readCredential(filename)
      if (current === undefined) return undefined
      await warnOnLoosePermissions(filename, log)
      if (!needsRefresh(current)) {
        return { token: current.access, accountId: current.accountId, email: current.email }
      }
      let next
      try {
        next = await tokenRequest(spec, new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refresh,
          client_id: spec.clientId,
        }), signal)
      } catch (error) {
        // A terminal rejection (revoked grant, bad client) repeats identically
        // on the next call, so it enters the cooldown; anything transport-side
        // may clear on its own and does not.
        if (error?.code === 'AUTH') {
          refreshRejectedAt = Date.now()
          lastRefreshError = error
        }
        throw error
      }
      // A success clears any recorded rejection.
      refreshRejectedAt = undefined
      lastRefreshError = undefined
      const stored = {
        access: next.access,
        // The endpoint may omit a rotated refresh token; the old one stays
        // valid, and discarding it would force a full re-login.
        refresh: next.refresh || current.refresh,
        expires: next.expires,
        // Neither label is carried by a token response, so both survive from
        // the previous document.
        accountId: current.accountId || accountId(next.idToken),
        email: current.email,
      }
      await writeCredential(filename, stored)
      return { token: stored.access, accountId: stored.accountId, email: stored.email }
    })
  }

  /** Read the account id an id_token carries, when this route uses one. */
  function accountId(idToken) {
    if (accountFrom === undefined || typeof idToken !== 'string' || idToken.length === 0) return ''
    const payload = decodeJwtPayload(idToken)
    return payload === undefined ? '' : (accountFrom(payload) ?? '')
  }

  /**
   * Begin a browser sign-in.
   *
   * One flow at a time: a second attempt while one is pending would mint a
   * second state and leave the first listener orphaned on the callback port.
   *
   * @returns {{url: string, completion: Promise<void>, cancel: () => void}}
   *   `cancel` stops the callback listener, which otherwise waits forever.
   */
  function beginLogin() {
    if (loginFlow !== undefined) {
      throw new SubscriptionError(`a ${spec.label} sign-in is already in progress`, 'INVALID_REQUEST')
    }
    const challenge = pkce()
    const abort = new AbortController()
    loginFlow = { abort }
    const completion = (async () => {
      try {
        const code = await waitForBrowserCallback(spec, challenge.state, abort.signal)
        const credential = await tokenRequest(spec, new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: spec.clientId,
          code,
          code_verifier: challenge.verifier,
          redirect_uri: spec.redirectUri,
          // Anthropic's endpoint validates the flow's state in the token
          // body; the official client sends it, and omitting it is answered
          // as an invalid request format.
          state: challenge.state,
        }), abort.signal)
        // A credential with no refresh token expires within the hour and has
        // no path back except a full re-login, so it is refused outright.
        if (credential.refresh.length === 0) {
          throw new SubscriptionError(`${spec.label} returned no refresh token`, 'INVALID_CREDENTIAL')
        }
        await withFileLock(filename, () => writeCredential(filename, {
          access: credential.access,
          refresh: credential.refresh,
          expires: credential.expires,
          accountId: accountId(credential.idToken),
          email: '',
        }))
        lastLoginError = undefined
        log?.info?.(`dsh-subscriptions: ${spec.label} is connected`)
      } catch (error) {
        // The verifier, code, and state never reach this string.
        lastLoginError = redact(error instanceof Error ? error.message : String(error))
      } finally {
        loginFlow = undefined
      }
    })()
    return { url: authorizeUrl(spec, challenge), completion, cancel: () => { abort.abort() } }
  }

  /** Remove the stored credential. */
  async function logout() {
    await clearCredential(filename)
    log?.info?.(`dsh-subscriptions: ${spec.label} is disconnected`)
  }

  /**
   * Report connection state for the control page.
   * No token text is included — only whether one exists and when it expires.
   */
  async function status() {
    let credential
    try {
      credential = await readCredential(filename)
    } catch (error) {
      return { connected: false, pending: loginFlow !== undefined, error: redact(error.message) }
    }
    return {
      connected: credential !== undefined,
      // A document can exist while its access token is already expired. The
      // route may still refresh it, but the status page must not present that
      // state as healthy — especially after an invalid_grant proves the
      // refresh token is gone too.
      expired: credential !== undefined && credential.expires <= Date.now(),
      pending: loginFlow !== undefined,
      ...credential === undefined ? {} : { expiresAt: new Date(credential.expires).toISOString() },
      ...credential?.email ? { email: credential.email } : {},
      ...lastLoginError === undefined ? {} : { error: lastLoginError },
    }
  }

  /**
   * Seed from another tool's credential file, once.
   *
   * Never overwrites a live credential: the import is a convenience for a
   * first run, not a synchronization.
   *
   * @param {string|undefined} path - the file to import.
   * @param {(doc: object) => object} convert - maps that format onto ours.
   */
  async function seedFrom(path, convert) {
    if (path === undefined) return
    await withFileLock(filename, async () => {
      if (await readCredential(filename).catch(() => undefined) !== undefined) return
      const { readFile } = require('node:fs/promises')
      let source
      try {
        source = JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw new SubscriptionError(`${path} is not a readable credential file`, 'INVALID_CREDENTIAL', { cause: error })
      }
      const converted = convert(source)
      if (converted === undefined) {
        throw new SubscriptionError(`${path} is not a ${spec.label} credential document`, 'INVALID_CREDENTIAL')
      }
      await writeCredential(filename, converted)
      log?.info?.(`dsh-subscriptions: seeded ${spec.label} from ${path}`)
    })
  }

  /**
   * Start the warm-up timer.
   * @returns {() => void} the disposer.
   */
  function startRefreshTimer() {
    const timer = setInterval(() => {
      // Failures are ignored on purpose: this only keeps a token warm, and a
      // real failure surfaces on the request that needs it.
      void access().catch(() => undefined)
    }, REFRESH_INTERVAL_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      loginFlow?.abort.abort()
    }
  }

  return { access, beginLogin, logout, status, seedFrom, startRefreshTimer, spec }
}

module.exports = { REFRESH_INTERVAL_MS, createSession }
