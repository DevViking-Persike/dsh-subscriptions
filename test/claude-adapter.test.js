// The Claude adapter against a local endpoint. No network, no credential.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { PROVIDER, createClaudeAdapter } = require('../dsh/claude/adapter.js')
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

/** An SSE responder writing Anthropic events. */
function sse(events, { delayMs = 0, terminate = true } = {}) {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const write = async () => {
      for (const event of events) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (terminate) res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      res.end()
    }
    void write()
  }
}

const TEXT_TURN = [
  { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'oi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
]

/** An adapter pointed at one endpoint. */
function adapterFor(base, extra = {}, token = 'test-token') {
  return createClaudeAdapter({
    config: resolveConfig({ baseURL: base, ...extra }),
    resolveAccessToken: () => Promise.resolve(token),
  })
}

/** Drive one stream to completion. */
async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'claude-opus-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }], ...options,
  })) chunks.push(chunk)
  return chunks
}

test('provider metadata passes the registry gate', () => {
  const info = adapterFor('http://x').providerInfo(PROVIDER)

  assert.equal(info.id, PROVIDER)
  assert.ok(info.name.length > 0)
})

test('providerInfo never throws, even for an unknown route', () => {
  assert.doesNotThrow(() => adapterFor('http://x').providerInfo('outra'))
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

test('reasoning is omitted from a resolved model, never sent empty', async () => {
  const resolved = await adapterFor('http://x').resolveModel(PROVIDER, 'claude-opus-5')

  assert.equal(Object.hasOwn(resolved, 'reasoning'), false)
  assert.equal(resolved.id, 'claude-opus-5')
  assert.ok(resolved.context.contextWindow > 0)
})

test('prepareCall binds the resolved model to a one-shot stream', async () => {
  // The harness calls adapter.prepareCall on every model call and reads
  // .model and .stream from the result; a plain-object adapter has no base
  // class to inherit it from, so the contract is pinned here.
  const server = await endpoint(sse(TEXT_TURN))
  try {
    const adapter = adapterFor(server.base)
    const call = await adapter.prepareCall(PROVIDER, 'claude-opus-5')

    assert.deepEqual(call.model, await adapter.resolveModel(PROVIDER, 'claude-opus-5'))
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

test('the request carries the Claude Code identity the backend gates on', async () => {
  const server = await endpoint(sse(TEXT_TURN))
  try {
    await collect(adapterFor(server.base))
    const sent = server.requests[0]
    const body = JSON.parse(sent.body)

    assert.equal(sent.headers.authorization, 'Bearer test-token')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    assert.ok(sent.headers['anthropic-beta'].includes('oauth-2025-04-20'))
    assert.ok(sent.headers['user-agent'].startsWith('claude-cli/'))
    assert.equal(body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.")
  } finally { server.close() }
})

test('a missing credential names the sign-in route rather than failing opaquely', async () => {
  const adapter = createClaudeAdapter({
    config: resolveConfig({}),
    resolveAccessToken: () => Promise.resolve(undefined),
  })

  await assert.rejects(collect(adapter), err => err.code === 'MISSING_CREDENTIAL' && err.message.includes('/claude/start'))
})

test('HTTP statuses map onto the harness vocabulary', async () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER']]) {
    const server = await endpoint((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"x","message":"nope"}}')
    })
    try {
      await assert.rejects(collect(adapterFor(server.base)), err => err.code === code, `status ${status}`)
    } finally { server.close() }
  }
})

test('a provider retry-after reaches the failure the retry plugin reads', async () => {
  const server = await endpoint((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
    res.end('{"error":{"type":"rate_limit_error","message":"slow down"}}')
  })
  try {
    await collect(adapterFor(server.base))
    assert.fail('expected a rejection')
  } catch (error) {
    assert.equal(error.failure.status, 429)
    assert.equal(error.failure.providerRetryAfterMs, 3000)
  } finally { server.close() }
})

test('an error body carrying a token is redacted before it is quoted', async () => {
  const server = await endpoint((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":{"type":"invalid_request_error","message":"bad sk-ant-oat01-SECRET"}}')
  })
  try {
    await collect(adapterFor(server.base))
    assert.fail('expected a rejection')
  } catch (error) {
    assert.equal(error.message.includes('SECRET'), false, 'the token leaked into the message')
  } finally { server.close() }
})

test('a truncated stream fails instead of looking complete', async () => {
  const server = await endpoint(sse(TEXT_TURN, { terminate: false }))
  try {
    await assert.rejects(collect(adapterFor(server.base)), err => err.code === 'STREAM_CLOSED')
  } finally { server.close() }
})

test('an unreachable endpoint reports TRANSPORT and keeps the cause', async () => {
  await assert.rejects(collect(adapterFor('http://127.0.0.1:1')), err => err.code === 'TRANSPORT' && err.cause !== undefined)
})

test('a caller abort is reported as ABORTED', async () => {
  const server = await endpoint(sse(TEXT_TURN, { delayMs: 60 }))
  const controller = new AbortController()
  try {
    setTimeout(() => { controller.abort() }, 25)
    await assert.rejects(collect(adapterFor(server.base), { signal: controller.signal }), err => err.code === 'ABORTED')
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
