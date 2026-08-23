// The Responses request body, checked against output recorded from the
// harness's own serializer.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { serializeRequest } = require('../dsh/codex/serialize.js')

const EXPECTED = JSON.parse(readFileSync(join(__dirname, 'expected-codex-requests.json'), 'utf8'))

const CASES = {
  texto: { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] },
  'com system': { model: 'm', system: 'seja breve', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] },
  'tool call': { model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{"a":1}' }] },
  ] },
  'tool result vazio': { model: 'm', messages: [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
  ] },
  'com ferramentas': { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] },
}

for (const [label, options] of Object.entries(CASES)) {
  test(`matches the harness serializer: ${label}`, () => {
    assert.deepEqual(serializeRequest(options, { maxTokens: 4096 }), EXPECTED[label])
  })
}

test('the system prompt is a top-level instructions string, not a message', () => {
  const body = serializeRequest(CASES['com system'], {})

  assert.equal(body.instructions, 'seja breve')
  assert.equal(body.input.every(item => item.role !== 'system'), true)
})

test('a harness system message joins the same instructions slot', () => {
  const body = serializeRequest({
    model: 'm',
    system: 'B',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'A' }] },
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
    ],
  }, {})

  assert.equal(body.instructions, 'A\n\nB')
})

test('conversations are not retained server-side', () => {
  // `store: false` is what keeps the subscription from persisting the
  // conversation on OpenAI's side.
  assert.equal(serializeRequest(CASES.texto, {}).store, false)
})

test('encrypted reasoning is requested, or a reasoning model loses its thinking', () => {
  assert.deepEqual(serializeRequest(CASES.texto, {}).include, ['reasoning.encrypted_content'])
})

test('user and assistant text use different content types', () => {
  const body = serializeRequest({
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'p' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'r' }] },
    ],
  }, {})

  assert.equal(body.input[0].content[0].type, 'input_text')
  assert.equal(body.input[1].content[0].type, 'output_text')
})

test('tool-call arguments stay a raw string, unlike the Anthropic route', () => {
  const body = serializeRequest(CASES['tool call'], {})

  assert.equal(body.input[0].arguments, '{"a":1}')
  assert.equal(typeof body.input[0].arguments, 'string')
})

test('an empty tool result still carries output', () => {
  assert.equal(serializeRequest(CASES['tool result vazio'], {}).input[0].output, '(no output)')
})

test('stop sequences are refused rather than dropped', () => {
  // Ignoring one would let the model run past a boundary the caller relied on.
  assert.throws(
    () => serializeRequest({ ...CASES.texto, stop: ['END'] }, {}),
    err => err.code === 'UNSUPPORTED',
  )
})

test('reasoning effort reaches the wire vocabulary', () => {
  assert.deepEqual(serializeRequest({ ...CASES.texto, reasoningEffort: 'high' }, {}).reasoning,
    { effort: 'high', summary: 'auto' })
  // The harness spells "no reasoning" as off; the wire spells it minimal.
  assert.equal(serializeRequest({ ...CASES.texto, reasoningEffort: 'off' }, {}).reasoning.effort, 'minimal')
})

test('image content is refused before any body is produced', () => {
  assert.throws(
    () => serializeRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/png' }] },
    ] }, {}),
    err => err.code === 'UNSUPPORTED_CONTENT',
  )
})
