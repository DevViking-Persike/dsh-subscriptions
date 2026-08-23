// PKCE mechanics and the loopback callback, offline.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { authorizeUrl, decodeJwtPayload, pkce, tokenRequest, waitForBrowserCallback } = require('../dsh/oauth.js')

const SPEC = {
  label: 'Test',
  clientId: 'client-x',
  authorizeUrl: 'https://auth.example.com/oauth/authorize',
  tokenUrl: 'https://auth.example.com/oauth/token',
  scope: 'openid profile',
  redirectUri: 'http://localhost:54999/callback',
}

test('the challenge hashes the verifier text, not its decoded bytes', () => {
  // Hashing the bytes yields a challenge the endpoint rejects with an opaque
  // invalid_grant, which is why this is asserted explicitly.
  const { verifier, challenge } = pkce()

  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.notEqual(challenge, createHash('sha256').update(Buffer.from(verifier, 'base64url')).digest('base64url'))
})

test('each flow gets fresh secrets', () => {
  const a = pkce()
  const b = pkce()

  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(a.state, b.state)
})

test('the authorize URL carries every required parameter', () => {
  const url = new URL(authorizeUrl(SPEC, { challenge: 'c', state: 's' }))

  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'client-x')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), 'c')
  assert.equal(url.searchParams.get('state'), 's')
  assert.equal(url.searchParams.get('redirect_uri'), SPEC.redirectUri)
})

test('provider-specific authorize parameters are carried through', () => {
  // Codex needs id_token_add_organizations=true, without which the account
  // claim never appears and requests reach the wrong workspace.
  const url = new URL(authorizeUrl(
    { ...SPEC, extraAuthorizeParams: { id_token_add_organizations: 'true' } },
    { challenge: 'c', state: 's' },
  ))

  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true')
})

test('the callback resolves only for a matching state', async () => {
  const wait = waitForBrowserCallback(SPEC, 'expected', new AbortController().signal)
  await new Promise(r => setTimeout(r, 40))

  const wrong = await fetch('http://127.0.0.1:54999/callback?state=forged&code=evil')
  assert.equal(wrong.status, 400)

  await fetch('http://127.0.0.1:54999/callback?state=expected&code=good')
  assert.equal(await wait, 'good')
})

test('a cancelled sign-in stops waiting', async () => {
  const controller = new AbortController()
  const wait = waitForBrowserCallback({ ...SPEC, redirectUri: 'http://localhost:54998/callback' }, 's', controller.signal)
  await new Promise(r => setTimeout(r, 40))

  controller.abort()

  await assert.rejects(wait, err => err.code === 'ABORTED')
})

test('a JWT payload is read without verifying it', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'a@b.c' })).toString('base64url')

  assert.deepEqual(decodeJwtPayload(`header.${payload}.signature`), { email: 'a@b.c' })
})

test('an unreadable JWT costs a label, not a token', () => {
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined)
  assert.equal(decodeJwtPayload('a.!!!.c'), undefined)
})

test('a token error body is redacted before it is quoted', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(new Response('{"error":"bad sk-ant-oat01-SECRET"}', { status: 400 }))
  try {
    await tokenRequest(SPEC, new URLSearchParams())
    assert.fail('expected a rejection')
  } catch (error) {
    assert.equal(error.message.includes('SECRET'), false, 'the token leaked into the message')
    assert.ok(error.message.includes('sk-ant-***'))
  } finally { globalThis.fetch = original }
})

test('a token response without an access token is refused', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(Response.json({ token_type: 'bearer' }))
  try {
    await assert.rejects(tokenRequest(SPEC, new URLSearchParams()), err => err.code === 'INVALID_CREDENTIAL')
  } finally { globalThis.fetch = original }
})

test('expiry is computed locally, since the response carries a duration', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
  try {
    const before = Date.now()
    const result = await tokenRequest(SPEC, new URLSearchParams())

    assert.ok(result.expires >= before + 3_600_000)
    assert.ok(result.expires <= Date.now() + 3_600_000)
  } finally { globalThis.fetch = original }
})
