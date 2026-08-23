// The Anthropic translator, checked against output recorded from the harness's
// own implementation over the same events.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { translate } = require('../dsh/claude/translate.js')

const EXPECTED = JSON.parse(readFileSync(join(__dirname, 'expected-claude-chunks.json'), 'utf8'))

const start = usage => ({ type: 'message_start', message: { usage } })
const stop = (reason, output) => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: output } },
  { type: 'message_stop' },
]

const FIXTURES = {
  texto: [
    start({ input_tokens: 10, output_tokens: 0 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Oi' } },
    { type: 'content_block_stop', index: 0 },
    ...stop('end_turn', 5),
  ],
  thinking: [
    start({ input_tokens: 3, output_tokens: 0 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'penso' } },
    { type: 'content_block_stop', index: 0 },
    ...stop('end_turn', 2),
  ],
  tool_use: [
    start({ input_tokens: 4, output_tokens: 0 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'f' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
    { type: 'content_block_stop', index: 0 },
    ...stop('tool_use', 7),
  ],
  'cache read': [
    start({ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    ...stop('end_turn', 1),
  ],
  'sem conteudo': [start({ input_tokens: 1, output_tokens: 0 }), ...stop('end_turn', 0)],
  max_tokens: [
    start({ input_tokens: 1, output_tokens: 0 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    ...stop('max_tokens', 9),
  ],
}

/** Run the port over one fixture. */
async function run(events) {
  async function* source() { for (const event of events) yield event }
  const chunks = []
  for await (const chunk of translate(source())) chunks.push(chunk)
  return chunks
}

for (const [label, events] of Object.entries(FIXTURES)) {
  test(`matches the harness translator: ${label}`, async () => {
    assert.deepEqual(await run(events), EXPECTED[label])
  })
}

test('cache reads are NOT subtracted, unlike the OpenAI family', async () => {
  // The single most dangerous difference between the two protocols: applying
  // the OpenAI rule here would report inputTokens as -800 and raise nothing.
  const usage = (await run(FIXTURES['cache read'])).find(c => c.type === 'usage').usage

  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.cacheReadTokens, 900)
})

test('output tokens are assigned, not accumulated', async () => {
  // Anthropic sends a running total; adding them inflates every turn.
  const chunks = await run([
    start({ input_tokens: 1, output_tokens: 0 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ])

  assert.equal(chunks.find(c => c.type === 'usage').usage.outputTokens, 9)
})

test('a tool delta carries argumentsDelta, and the closed block carries arguments', async () => {
  const chunks = await run(FIXTURES.tool_use)
  const delta = chunks.find(c => c.type === 'tool-call-delta')
  const end = chunks.find(c => c.type === 'block-end')

  assert.ok(Object.hasOwn(delta, 'argumentsDelta'))
  assert.equal(Object.hasOwn(delta, 'arguments'), false)
  assert.equal(end.block.arguments, '{"a":1}')
  assert.equal(end.block.id, 'tu_1')
})

test('a thinking delta reads .thinking, not .text', async () => {
  const chunks = await run(FIXTURES.thinking)

  assert.equal(chunks.find(c => c.type === 'reasoning-delta').text, 'penso')
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'penso')
})

test('a completed response with no content is a retryable error', async () => {
  const finish = (await run(FIXTURES['sem conteudo'])).at(-1)

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('an unmapped stop reason keeps its raw word', async () => {
  const finish = (await run([
    start({ input_tokens: 1 }),
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    ...stop('refusal', 1),
  ])).at(-1)

  assert.equal(finish.reason.failure.code, 'REFUSAL')
})

test('a keepalive never fails a stream', async () => {
  const chunks = await run([start({ input_tokens: 1 }), { type: 'ping' }, ...stop('end_turn', 0)])

  assert.equal(chunks.at(-1).type, 'finish')
})

test('a delta for an unopened block is refused', async () => {
  await assert.rejects(
    run([start({}), { type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: 'x' } }]),
    err => err.code === 'MALFORMED_RESPONSE',
  )
})

test('a stream ending without message_stop is refused', async () => {
  // A truncated response must never be mistaken for a complete one.
  await assert.rejects(
    run([start({ input_tokens: 1 }), { type: 'content_block_start', index: 0, content_block: { type: 'text' } }]),
    err => err.code === 'STREAM_CLOSED',
  )
})

test('an error event carries its wire type as the code', async () => {
  await assert.rejects(
    run([start({}), { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]),
    err => err.code === 'OVERLOADED_ERROR',
  )
})

test('finish is always last', async () => {
  for (const events of Object.values(FIXTURES)) {
    const chunks = await run(events)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  }
})
