// The OAuth mechanics both subscriptions share.
//
// Both providers use the same public-client PKCE flow with different
// endpoints and client ids, so the mechanism lives here once and each route
// supplies its own protocol constants. Keeping one copy is the point: this is
// the code that decides whether a token refresh corrupts a credential, and a
// bug fixed in one duplicate and missed in the other is a real hazard.

const { createHash, randomBytes } = require('node:crypto')
const { createServer } = require('node:http')
const { SubscriptionError, redact } = require('./errors.js')

/** Budget for one token-endpoint round trip. */
const TOKEN_TIMEOUT_MS = 30_000

/**
 * Mint a PKCE challenge.
 *
 * The challenge hashes the base64url TEXT of the verifier, not the bytes it
 * decodes to. Hashing the bytes produces a challenge the endpoint rejects
 * with an opaque `invalid_grant`.
 *
 * @returns {{verifier: string, challenge: string, state: string}}
 */
function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(16).toString('hex'),
  }
}

/**
 * Build the authorize URL for one provider.
 * @param {object} spec - the provider's OAuth constants.
 * @param {{challenge: string, state: string}} challenge - the minted PKCE values.
 * @returns {string} the URL the operator opens.
 */
function authorizeUrl(spec, challenge) {
  const url = new URL(spec.authorizeUrl)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: spec.clientId,
    redirect_uri: spec.redirectUri,
    scope: spec.scope,
    code_challenge: challenge.challenge,
    code_challenge_method: 'S256',
    state: challenge.state,
    ...spec.extraAuthorizeParams,
  })) url.searchParams.set(key, String(value))
  return url.toString()
}

/**
 * POST the token endpoint and normalize the response.
 *
 * Neither the request body nor any token text enters a thrown message; an
 * upstream error body is redacted and capped before being quoted.
 *
 * @param {object} spec - the provider's OAuth constants.
 * @param {URLSearchParams} body - the grant parameters.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{access: string, refresh: string, expires: number, idToken: string}>}
 */
async function tokenRequest(spec, body, signal) {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  let response
  try {
    response = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
  } catch (error) {
    throw new SubscriptionError(`${spec.label} token endpoint is unreachable`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    const detail = redact(await response.text().catch(() => ''))
    // A rejected grant answers HTTP 400, not 401: status alone would classify
    // a revoked refresh token as a retryable transport fault, and every model
    // call would then re-attempt the refresh three times — a storm that ends
    // with the endpoint rate-limiting the address. The error code names the
    // terminal cases; everything else keeps its transport classification.
    let grant = ''
    try {
      grant = String(JSON.parse(detail)?.error ?? '')
    } catch {
      // A non-JSON body keeps the transport classification.
    }
    const terminal = response.status === 401 || response.status === 403
      || ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(grant)
    throw new SubscriptionError(
      `${spec.label} token request failed (HTTP ${String(response.status)}): ${detail}`,
      terminal ? 'AUTH' : 'TRANSPORT',
      { status: response.status },
    )
  }
  const value = await response.json().catch(() => undefined)
  if (typeof value?.access_token !== 'string' || value.access_token.length === 0) {
    throw new SubscriptionError(`${spec.label} token response carries no access_token`, 'INVALID_CREDENTIAL')
  }
  return {
    access: value.access_token,
    refresh: typeof value.refresh_token === 'string' ? value.refresh_token : '',
    expires: Date.now() + (typeof value.expires_in === 'number' ? value.expires_in : 3600) * 1000,
    idToken: typeof value.id_token === 'string' ? value.id_token : '',
  }
}

/**
 * Decode a JWT payload without verifying it.
 *
 * The token was just received over TLS from the endpoint that issued it, and
 * the payload is read only for display labels — never for authorization — so
 * signature verification would add a dependency without adding a decision.
 *
 * @param {string} token - the JWT.
 * @returns {object|undefined} the payload, or undefined when unreadable.
 */
function decodeJwtPayload(token) {
  const segments = token.split('.')
  const payload = segments.length === 3 ? segments[1] : undefined
  if (payload === undefined) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    // An unreadable payload costs a display label, never a working token.
    return undefined
  }
}

/**
 * Wait for the browser to deliver an authorization code.
 *
 * A one-shot loopback listener that accepts only the expected path and a
 * matching `state`, so a stray request cannot inject a code.
 *
 * @param {object} spec - the provider's OAuth constants.
 * @param {string} state - the state minted for this flow.
 * @param {AbortSignal} signal - cancellation for the wait.
 * @returns {Promise<string>} the authorization code.
 */
function waitForBrowserCallback(spec, state, signal) {
  const { pathname, port } = new URL(spec.redirectUri)
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== pathname || url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`Unexpected ${spec.label} OAuth callback.`)
        return
      }
      const code = url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(code === null
        ? `${spec.label} sign-in failed. You can close this tab.`
        : `${spec.label} is connected. You can close this tab.`)
      server.close()
      if (code === null) reject(new SubscriptionError(`${spec.label} callback carried no code`, 'AUTH'))
      else resolve(code)
    })
    server.on('error', error => { reject(new SubscriptionError(
      // Port 1455/54545 is fixed by the provider's registered redirect, so a
      // conflict cannot be worked around by choosing another.
      `${spec.label} cannot listen on port ${port} for the sign-in callback`,
      'TRANSPORT',
      { cause: error },
    )) })
    // The redirect says `localhost` but the bind is explicit: on a host where
    // `localhost` resolves to ::1 first, a v6 bind never receives the callback.
    server.listen(Number(port), '127.0.0.1')
    signal.addEventListener('abort', () => {
      server.close()
      reject(new SubscriptionError(`${spec.label} sign-in was cancelled`, 'ABORTED'))
    }, { once: true })
  })
}

module.exports = {
  TOKEN_TIMEOUT_MS,
  authorizeUrl,
  decodeJwtPayload,
  pkce,
  tokenRequest,
  waitForBrowserCallback,
}
