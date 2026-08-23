// Plugin registration, sign-in server, and credential lifecycle.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, existsSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const plugin = require('../dsh/index.js')
const { createSession } = require('../dsh/session.js')
const { readCredential, writeCredential } = require('../dsh/credential.js')

/** A context that records registrations and effects. */
function fakeCtx() {
  const registered = []
  const disposers = []
  return {
    registered,
    disposers,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push({ providers, adapter })
        return () => { registered.splice(registered.findIndex(r => r.adapter === adapter), 1) }
      },
    },
    effect: (fn) => { disposers.push(fn()) },
  }
}

/** A scratch DSH home. */
function scratchHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-subs-'))
}

test('both routes register by default', async () => {
  const ctx = fakeCtx()

  await plugin.apply(ctx, { dshHome: scratchHome(), controlPort: 0 })

  assert.deepEqual(ctx.registered.flatMap(r => r.providers).sort(), ['claude-code-oauth', 'codex-oauth'])
  for (const dispose of ctx.disposers) dispose?.()
})

test('a single route can be enabled alone', async () => {
  const ctx = fakeCtx()

  await plugin.apply(ctx, { dshHome: scratchHome(), controlPort: 0, routes: ['claude'] })

  assert.deepEqual(ctx.registered.flatMap(r => r.providers), ['claude-code-oauth'])
  for (const dispose of ctx.disposers) dispose?.()
})

test('an unknown route is refused at load', async () => {
  await assert.rejects(
    plugin.apply(fakeCtx(), { dshHome: scratchHome(), routes: ['gemini'] }),
    /unknown route "gemini"/,
  )
})

test('the plugin declares only the service it uses', () => {
  assert.deepEqual(plugin.inject, ['llm'])
})

test('mounting reads no credential and touches no network', async () => {
  // A subscription that is not connected must still let the harness boot.
  const home = scratchHome()
  const ctx = fakeCtx()
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('the network must not be touched at load') }
  try {
    await plugin.apply(ctx, { dshHome: home, controlPort: 0 })
    assert.equal(ctx.registered.length, 2)
  } finally {
    globalThis.fetch = originalFetch
    for (const dispose of ctx.disposers) dispose?.()
  }
})

test('a bad configuration fails at load', async () => {
  await assert.rejects(plugin.apply(fakeCtx(), { streamIdleTimeoutMs: -1 }), /positive integer/)
  await assert.rejects(plugin.apply(fakeCtx(), { baseURL: 'ftp://x' }), /http\(s\) URL/)
})

test('a CLIProxyAPI document converts, and anything else is refused', () => {
  const converted = plugin.claudeImport({
    access_token: 'a', refresh_token: 'r', expired: '2030-01-01T00:00:00Z', email: 'x@y.z',
  })

  assert.equal(converted.access, 'a')
  assert.equal(converted.email, 'x@y.z')
  assert.ok(converted.expires > 0)
  assert.equal(plugin.claudeImport({ nope: true }), undefined)
})

test('an unparseable expiry becomes zero, so the first use refreshes', () => {
  // That also proves the imported refresh token is live.
  assert.equal(plugin.claudeImport({ access_token: 'a', refresh_token: 'r', expired: 'lixo' }).expires, 0)
})

describe_session()

/** Session-level behavior, exercised without the plugin wrapper. */
function describe_session() {
  const SPEC = {
    label: 'Test',
    clientId: 'c',
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scope: 'openid',
    redirectUri: 'http://localhost:54997/callback',
  }

  test('a fresh token is returned without contacting the endpoint', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'live', refresh: 'r', expires: Date.now() + 3_600_000, accountId: '', email: '' })
    const session = createSession({ spec: SPEC, filename: file })
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = () => { calls += 1; throw new Error('should not refresh') }
    try {
      assert.equal((await session.access()).token, 'live')
      assert.equal(calls, 0)
    } finally { globalThis.fetch = original }
  })

  test('a near-expiry token refreshes and persists', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'old', refresh: 'r1', expires: Date.now() + 60_000, accountId: 'acc', email: 'e@x' })
    const session = createSession({ spec: SPEC, filename: file })
    const original = globalThis.fetch
    globalThis.fetch = () => Promise.resolve(Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }))
    try {
      assert.equal((await session.access()).token, 'new')
      const stored = await readCredential(file)

      assert.equal(stored.access, 'new')
      assert.equal(stored.refresh, 'r2')
      // Labels survive a refresh: no token response carries them.
      assert.equal(stored.accountId, 'acc')
      assert.equal(stored.email, 'e@x')
      assert.equal(statSync(file).mode & 0o777, 0o600)
    } finally { globalThis.fetch = original }
  })

  test('an omitted rotated refresh token keeps the old one', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'old', refresh: 'keep-me', expires: Date.now() + 60_000, accountId: '', email: '' })
    const session = createSession({ spec: SPEC, filename: file })
    const original = globalThis.fetch
    globalThis.fetch = () => Promise.resolve(Response.json({ access_token: 'new', expires_in: 3600 }))
    try {
      await session.access()

      assert.equal((await readCredential(file)).refresh, 'keep-me')
    } finally { globalThis.fetch = original }
  })

  test('a failed refresh leaves the credential in place', async () => {
    // A transient outage must not force a full re-login.
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'old', refresh: 'r', expires: Date.now() + 60_000, accountId: '', email: '' })
    const session = createSession({ spec: SPEC, filename: file })
    const original = globalThis.fetch
    globalThis.fetch = () => Promise.resolve(new Response('{"error":"nope"}', { status: 401 }))
    try {
      await assert.rejects(session.access(), err => err.code === 'AUTH')

      assert.equal((await readCredential(file)).access, 'old')
    } finally { globalThis.fetch = original }
  })

  test('concurrent readers refresh exactly once', async () => {
    // The lock spans the whole read-check-POST-write cycle, so the second and
    // third callers find the token already fresh instead of burning it again.
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'old', refresh: 'r', expires: Date.now() + 60_000, accountId: '', email: '' })
    const session = createSession({ spec: SPEC, filename: file })
    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = async () => {
      calls += 1
      await new Promise(r => setTimeout(r, 40))
      return Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 })
    }
    try {
      const results = await Promise.all([session.access(), session.access(), session.access()])

      assert.equal(calls, 1)
      assert.deepEqual(results.map(r => r.token), ['new', 'new', 'new'])
    } finally { globalThis.fetch = original }
  })

  test('an absent credential reports undefined rather than failing', async () => {
    const session = createSession({ spec: SPEC, filename: join(scratchHome(), 'missing.json') })

    assert.equal(await session.access(), undefined)
  })

  test('a corrupt document is refused by name', async () => {
    const file = join(scratchHome(), 'cred.json')
    writeFileSync(file, '{"version":2}')
    const session = createSession({ spec: SPEC, filename: file })

    await assert.rejects(session.access(), err => err.code === 'INVALID_CREDENTIAL')
  })

  test('status flags an expired token instead of presenting it as healthy', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'a', refresh: 'r', expires: Date.now() - 1000, accountId: '', email: '' })
    const session = createSession({ spec: SPEC, filename: file })

    const status = await session.status()

    assert.equal(status.connected, true)
    assert.equal(status.expired, true)
  })

  test('status reports connection without exposing the token', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'secret-token', refresh: 'r', expires: Date.now() + 3_600_000, accountId: '', email: 'a@b' })
    const session = createSession({ spec: SPEC, filename: file })

    const status = await session.status()

    assert.equal(status.connected, true)
    // A stored-but-expired token reports as such, not as healthy.
    assert.equal(status.expired, false)
    assert.equal(status.email, 'a@b')
    assert.equal(JSON.stringify(status).includes('secret-token'), false, 'the token leaked into status')
  })

  test('sign-out removes the credential', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'a', refresh: 'r', expires: Date.now() + 1000, accountId: '', email: '' })
    const session = createSession({ spec: SPEC, filename: file })

    await session.logout()

    assert.equal(existsSync(file), false)
  })

  test('a second sign-in is refused while one is pending', async () => {
    const session = createSession({ spec: SPEC, filename: join(scratchHome(), 'cred.json') })
    const first = session.beginLogin()
    try {
      assert.throws(() => session.beginLogin(), err => err.code === 'INVALID_REQUEST')
    } finally {
      // The pending flow owns a loopback listener; cancelling releases it.
      first.cancel()
      await first.completion
    }
  })

  test('an import never overwrites a live credential', async () => {
    const file = join(scratchHome(), 'cred.json')
    await writeCredential(file, { access: 'live', refresh: 'r', expires: Date.now() + 3_600_000, accountId: '', email: '' })
    const source = join(scratchHome(), 'other.json')
    writeFileSync(source, JSON.stringify({ access_token: 'imported', refresh_token: 'r2' }))
    const session = createSession({ spec: SPEC, filename: file })

    await session.seedFrom(source, plugin.claudeImport)

    assert.equal((await readCredential(file)).access, 'live')
  })

  test('an absent import file is not an error', async () => {
    const session = createSession({ spec: SPEC, filename: join(scratchHome(), 'cred.json') })

    await session.seedFrom(join(scratchHome(), 'nao-existe.json'), plugin.claudeImport)
  })
}
