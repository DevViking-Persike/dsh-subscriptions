// The Responses translator, checked against output recorded from the harness's
// own implementation.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { translate } = require('../dsh/codex/translate.js')
const { translate: claudeTranslate } = require('../dsh/claude/translate.js')

const EXPECTED = JSON.parse(readFileSync(join(__dirname, 'expected-codex-chunks.json'), 'utf8'))

const FIXTURES = {
  texto: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Oi' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ],
  reasoning: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'penso' },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
  ],
  function_call: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'fc_1', name: 'f' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"a":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
    { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 7 } } },
  ],
  'cache subtraido': [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'x' },
    { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } } } },
  ],
  incomplete: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'x' },
    { type: 'response.incomplete', response: { usage: { input_tokens: 1, output_tokens: 9 } } },
  ],
  failed: [{ type: 'response.failed', response: { error: { message: 'boom', code: 'server_error' } } }],
}

/** Run one fixture through a translator. */
async function run(events, fn = translate) {
  async function* source() { for (const event of events) yield event }
  const chunks = []
  for await (const chunk of fn(source())) chunks.push(chunk)
  return chunks
}

for (const [label, events] of Object.entries(FIXTURES)) {
  test(`matches the harness translator: ${label}`, async () => {
    assert.deepEqual(await run(events), EXPECTED[label])
  })
}

test('cache reads ARE subtracted here, unlike the Claude route', async () => {
  // The two routes in this same package use opposite conventions, and neither
  // raises when it is wrong, so both directions are pinned.
  const codex = (await run(FIXTURES['cache subtraido'])).find(c => c.type === 'usage').usage

  assert.equal(codex.inputTokens, 100)
  assert.equal(codex.cacheReadTokens, 900)
})

test('the two routes really do disagree about cache accounting', async () => {
  const claude = (await run([
    { type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 900 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ], claudeTranslate)).find(c => c.type === 'usage').usage
  const codex = (await run(FIXTURES['cache subtraido'])).find(c => c.type === 'usage').usage

  // Same wire numbers, deliberately different answers.
  assert.equal(claude.inputTokens, 1000)
  assert.equal(codex.inputTokens, 100)
})

test('a tool call is inferred as the finish reason, since Responses reports none', async () => {
  const finish = (await run(FIXTURES.function_call)).at(-1)

  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
})

test('an incomplete response is reported as max-tokens', async () => {
  assert.deepEqual((await run(FIXTURES.incomplete)).at(-1).reason, { kind: 'max-tokens' })
})

test('a failed response carries the wire code', async () => {
  const finish = (await run(FIXTURES.failed)).at(-1)

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'server_error')
})

test('a tool delta carries argumentsDelta, and the closed block carries arguments', async () => {
  const chunks = await run(FIXTURES.function_call)
  const delta = chunks.find(c => c.type === 'tool-call-delta')
  const end = chunks.find(c => c.type === 'block-end')

  assert.ok(Object.hasOwn(delta, 'argumentsDelta'))
  assert.equal(Object.hasOwn(delta, 'arguments'), false)
  assert.equal(end.block.arguments, '{"a":1}')
  assert.equal(end.block.id, 'fc_1')
})

test('a completed response with no content is a retryable error', async () => {
  const finish = (await run([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } }])).at(-1)

  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('an unknown event never fails a stream', async () => {
  const chunks = await run([
    { type: 'response.created' },
    { type: 'response.in_progress' },
    ...FIXTURES.texto,
  ])

  assert.equal(chunks.at(-1).type, 'finish')
})

test('a stream ending without a terminal event is refused', async () => {
  await assert.rejects(
    run([{ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }]),
    err => err.code === 'STREAM_CLOSED',
  )
})

test('block indices stay dense even when the wire skips output indices', async () => {
  // The assembler expects a dense sequence; the wire numbers items its own way.
  const chunks = await run([
    { type: 'response.output_item.added', output_index: 5, item: { type: 'reasoning' } },
    { type: 'response.output_item.added', output_index: 9, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 9, delta: 'x' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ])

  assert.deepEqual(chunks.filter(c => c.type === 'block-start').map(c => c.index), [0, 1])
})

test('finish is always last', async () => {
  for (const events of Object.values(FIXTURES)) {
    const chunks = await run(events)
    assert.equal(chunks.at(-1).type, 'finish')
  }
})
