// The Codex adapter against a local endpoint. No network, no credential.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { PROVIDER, createCodexAdapter } = require('../dsh/codex/adapter.js')
const { resolveConfig } = require('../dsh/config.js')

/** Start a scripted endpoint; returns its base URL and recorded requests. */
async function endpoint(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      handler(req, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() }
}

/** An SSE responder writing Responses events. */
function sse(events, { delayMs = 0, terminate = true } = {}) {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const write = async () => {
      for (const event of events) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (terminate) {
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`)
      }
      res.end()
    }
    void write()
  }
}

const TEXT_TURN = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'oi' },
]

/** An adapter pointed at one endpoint. */
function adapterFor(base, extra = {}, access = { token: 'tok', accountId: 'acc_1' }) {
  return createCodexAdapter({
    config: resolveConfig({ codexBaseURL: base, ...extra }),
    resolveAccess: () => Promise.resolve(access),
  })
}

/** Drive one stream to completion. */
async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'gpt-5.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }], ...options,
  })) chunks.push(chunk)
  return chunks
}

test('provider metadata passes the registry gate', () => {
  const info = adapterFor('http://x').providerInfo(PROVIDER)

  assert.equal(info.id, PROVIDER)
  assert.ok(info.name.length > 0)
})

test('model entries satisfy the catalog gate', async () => {
  const models = await adapterFor('http://x').listModels(PROVIDER)
  const ids = new Set()

  for (const model of models) {
    assert.equal(model.provider, PROVIDER)
    assert.ok(model.id.length > 0 && model.name.length > 0)
    assert.equal(ids.has(model.id), false)
    ids.add(model.id)
  }
})

test('prepareCall binds the resolved model to a one-shot stream', async () => {
  // The harness calls adapter.prepareCall on every model call and reads
  // .model and .stream from the result; a plain-object adapter has no base
  // class to inherit it from, so the contract is pinned here.
  const server = await endpoint(sse(TEXT_TURN))
  try {
    const adapter = adapterFor(server.base)
    const call = await adapter.prepareCall(PROVIDER, 'gpt-5.5')

    assert.deepEqual(call.model, await adapter.resolveModel(PROVIDER, 'gpt-5.5'))
    const chunks = await collect({ stream: call.stream })
    assert.equal(chunks.at(-1).type, 'finish')
  } finally { server.close() }
})

test('a normal stream yields chunks and finishes', async () => {
  const server = await endpoint(sse(TEXT_TURN))
  try {
    const chunks = await collect(adapterFor(server.base))

    assert.equal(chunks.at(-1).type, 'finish')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  } finally { server.close() }
})

test('the request carries the Codex CLI identity the backend gates on', async () => {
  const server = await endpoint(sse(TEXT_TURN))
  try {
    await collect(adapterFor(server.base))
    const sent = server.requests[0]

    assert.equal(sent.headers.authorization, 'Bearer tok')
    assert.equal(sent.headers['openai-beta'], 'responses=experimental')
    assert.equal(sent.headers.originator, 'codex-tui')
    assert.ok(sent.headers['user-agent'].startsWith('codex-tui/'))
    assert.equal(sent.headers['chatgpt-account-id'], 'acc_1')
  } finally { server.close() }
})

test('an absent account id omits the header rather than sending it empty', async () => {
  // An empty header routes the request to the wrong workspace.
  const server = await endpoint(sse(TEXT_TURN))
  try {
    await collect(adapterFor(server.base, {}, { token: 'tok', accountId: '' }))

    assert.equal(Object.hasOwn(server.requests[0].headers, 'chatgpt-account-id'), false)
  } finally { server.close() }
})

test('each request carries its own session id', async () => {
  const server = await endpoint(sse(TEXT_TURN))
  try {
    await collect(adapterFor(server.base))
    await collect(adapterFor(server.base))

    assert.notEqual(server.requests[0].headers.session_id, server.requests[1].headers.session_id)
  } finally { server.close() }
})

test('a missing credential names the sign-in route', async () => {
  const adapter = createCodexAdapter({ config: resolveConfig({}), resolveAccess: () => Promise.resolve(undefined) })

  await assert.rejects(collect(adapter), err => err.code === 'MISSING_CREDENTIAL' && err.message.includes('/codex/start'))
})

test('HTTP statuses map onto the harness vocabulary', async () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER']]) {
    const server = await endpoint((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"nope"}}')
    })
    try {
      await assert.rejects(collect(adapterFor(server.base)), err => err.code === code, `status ${status}`)
    } finally { server.close() }
  }
})

test('a provider retry-after reaches the failure the retry plugin reads', async () => {
  const server = await endpoint((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '4' })
    res.end('{"error":{"message":"slow"}}')
  })
  try {
    await collect(adapterFor(server.base))
    assert.fail('expected a rejection')
  } catch (error) {
    assert.equal(error.failure.providerRetryAfterMs, 4000)
  } finally { server.close() }
})

test('an error body carrying a JWT is redacted before it is quoted', async () => {
  const server = await endpoint((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"bad eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln"}}')
  })
  try {
    await collect(adapterFor(server.base))
    assert.fail('expected a rejection')
  } catch (error) {
    assert.equal(error.message.includes('cGF5bG9hZA'), false, 'the token leaked into the message')
  } finally { server.close() }
})

test('a truncated stream fails instead of looking complete', async () => {
  const server = await endpoint(sse(TEXT_TURN, { terminate: false }))
  try {
    await assert.rejects(collect(adapterFor(server.base)), err => err.code === 'STREAM_CLOSED')
  } finally { server.close() }
})

test('an idle stream times out on its own budget', async () => {
  const server = await endpoint(sse(TEXT_TURN, { delayMs: 400 }))
  try {
    await assert.rejects(collect(adapterFor(server.base, { streamIdleTimeoutMs: 60 })), err => err.code === 'TIMEOUT')
  } finally { server.close() }
})

test('image content is refused before any request is sent', async () => {
  const server = await endpoint(sse(TEXT_TURN))
  try {
    await assert.rejects(
      collect(adapterFor(server.base), {
        messages: [{ role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/png' }] }],
      }),
      err => err.code === 'UNSUPPORTED_CONTENT',
    )
    assert.equal(server.requests.length, 0)
  } finally { server.close() }
})
