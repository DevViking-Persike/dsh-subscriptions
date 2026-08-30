// The Anthropic request body, checked against output recorded from the
// harness's own serializer.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { CLAUDE_CODE_PREAMBLE, serializeRequest, toJsonSchema } = require('../dsh/claude/serialize.js')

const EXPECTED = JSON.parse(readFileSync(join(__dirname, 'expected-claude-requests.json'), 'utf8'))

const CASES = {
  texto: { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] },
  'com system': { model: 'm', system: 'seja breve', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] },
  'tool call vazio': { model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '' }] },
  ] },
  'tool result vazio': { model: 'm', messages: [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
  ] },
  'reasoning descartado': { model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'pensei' }, { type: 'text', text: 'resposta' }] },
  ] },
  'com ferramentas': { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] },
}

for (const [label, options] of Object.entries(CASES)) {
  test(`matches the harness serializer: ${label}`, () => {
    assert.deepEqual(serializeRequest(options, { maxTokens: 4096 }), EXPECTED[label])
  })
}

test('the Claude Code preamble occupies its own system block', () => {
  // The backend classifies OAuth traffic by this block and answers
  // rate_limit_error without it, even on models the subscription serves.
  const body = serializeRequest(CASES['com system'], { maxTokens: 100 })

  assert.equal(body.system[0].text, CLAUDE_CODE_PREAMBLE)
  assert.equal(body.system[1].text, 'seja breve')
  assert.equal(body.system.length, 2)
})

test('the preamble is present even with no caller prompt', () => {
  const body = serializeRequest(CASES.texto, { maxTokens: 100 })

  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, CLAUDE_CODE_PREAMBLE)
})

test('a harness system message folds into the same slot', () => {
  const body = serializeRequest({
    model: 'm',
    system: 'B',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'A' }] },
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
    ],
  }, { maxTokens: 100 })

  assert.equal(body.system[1].text, 'A\n\nB')
  // System messages never appear in the message list on this protocol.
  assert.equal(body.messages.every(m => m.role !== 'system'), true)
})

test('empty tool-call arguments become an empty object, not an empty string', () => {
  const body = serializeRequest(CASES['tool call vazio'], { maxTokens: 100 })

  assert.deepEqual(body.messages[0].content[0].input, {})
})

test('malformed tool-call arguments are refused with a named tool', () => {
  assert.throws(
    () => serializeRequest({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'busca', arguments: '{nao json' }] },
    ] }, { maxTokens: 100 }),
    err => err.code === 'INVALID_REQUEST' && err.message.includes('busca'),
  )
})

test('reasoning is dropped, since only signed thinking blocks are accepted', () => {
  const body = serializeRequest(CASES['reasoning descartado'], { maxTokens: 100 })

  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'resposta' }])
})

test('an empty tool result still carries content', () => {
  const body = serializeRequest(CASES['tool result vazio'], { maxTokens: 100 })

  assert.equal(body.messages[0].content[0].content, '(no output)')
})

test('an empty tool schema receives the Anthropic-required object root', () => {
  const body = serializeRequest({
    ...CASES.texto,
    tools: [{ name: 'docker_images', description: 'list images', parameters: {} }],
  }, { maxTokens: 100 })

  assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: {} })
})

test('a bare Harness property map becomes JSON Schema', () => {
  assert.deepEqual(toJsonSchema({
    container: { type: 'string', required: true, description: 'name' },
    tail: { type: 'number', description: 'lines' },
  }), {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'name' },
      tail: { type: 'number', description: 'lines' },
    },
    required: ['container'],
  })
})

test('an object schema passes through and a properties-only schema gains its type', () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }
  assert.equal(toJsonSchema(schema), schema)
  assert.deepEqual(
    toJsonSchema({ properties: { x: { type: 'string' } } }),
    { type: 'object', properties: { x: { type: 'string' } } },
  )
})

test('invalid tool parameters become an empty object schema', () => {
  assert.deepEqual(toJsonSchema(undefined), { type: 'object', properties: {} })
  assert.deepEqual(toJsonSchema([]), { type: 'object', properties: {} })
})

test('max_tokens is required by this protocol', () => {
  // Anthropic rejects a request without it, so an absent cap fails here rather
  // than as an opaque 400.
  assert.throws(() => serializeRequest(CASES.texto, {}), err => err.code === 'INVALID_REQUEST')
})

test('an explicit request cap wins over the configured default', () => {
  assert.equal(serializeRequest({ ...CASES.texto, maxTokens: 55 }, { maxTokens: 4096 }).max_tokens, 55)
})

test('image content is refused before any body is produced', () => {
  assert.throws(
    () => serializeRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/png' }] },
    ] }, { maxTokens: 100 }),
    err => err.code === 'UNSUPPORTED_CONTENT',
  )
})

test('an image nested in a tool result is refused too', () => {
  assert.throws(
    () => serializeRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [
        { type: 'image', data: 'x', mediaType: 'image/png' },
      ] }] },
    ] }, { maxTokens: 100 }),
    err => err.code === 'UNSUPPORTED_CONTENT',
  )
})
