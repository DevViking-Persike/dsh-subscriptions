const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveConfig } = require('../dsh/config.js')
const { createClaudeAdapter } = require('../dsh/claude/adapter.js')
const { createCodexAdapter } = require('../dsh/codex/adapter.js')
const claude = require('../dsh/claude/serialize.js')
const codex = require('../dsh/codex/serialize.js')
const { reasoningMetadata } = require('../dsh/reasoning.js')

for (const [route, model, create, serializer] of [
  ['claude', 'claude-fable-5-1', createClaudeAdapter, claude],
  ['codex', 'gpt-6-astra', createCodexAdapter, codex],
]) {
  test(`${model} is discoverable with all five effort choices and image support`, async () => {
    const adapter = create({ config: resolveConfig() })
    assert.ok((await adapter.listModels(`${route}-oauth`)).some(entry => entry.id === model))
    const resolved = await adapter.resolveModel(`${route}-oauth`, model)
    assert.deepEqual(resolved.inputModalities, ['text', 'image'])
    assert.deepEqual(resolved.reasoning.efforts.map(entry => entry.id), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(resolved.reasoning.efforts.at(-1).name, 'Ultra Code (max)')
    assert.equal(resolved.reasoning.defaultEffort, undefined)
    resolved.reasoning.efforts[0].id = 'tampered'
    assert.equal((await adapter.resolveModel(`${route}-oauth`, model)).reasoning.efforts[0].id, 'low')
  })
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    test(`${model} sends ${effort} unchanged on text and image paths`, async () => {
      const request = { model, messages: [], reasoningEffort: effort }
      for (const body of [serializer.serializeRequest(request, { maxTokens: 128000 }),
        await serializer.serializeRequestWithImages(request, { maxTokens: 128000 }, {})]) {
        assert.equal((body.output_config ?? body.reasoning).effort, effort)
      }
    })
  }
  test(`${model} rejects invalid effort before reading credentials`, async () => {
    let reads = 0
    const read = async () => { reads++; throw new Error('credential must not be read') }
    const adapter = create({ config: resolveConfig(), resolveAccess: read, resolveAccessToken: read })
    await assert.rejects(adapter.stream({ model, messages: [], reasoningEffort: 'ultracode' }).next(),
      error => error.code === 'UNSUPPORTED_REASONING_EFFORT')
    assert.equal(reads, 0)
    assert.throws(() => serializer.serializeRequest({ model, messages: [], reasoningEffort: 'ultracode' }, { maxTokens: 128000 }),
      error => error.code === 'UNSUPPORTED_REASONING_EFFORT')
  })
}

test('capabilities remain model-specific and custom catalogs replace defaults', () => {
  assert.deepEqual(reasoningMetadata('claude', 'claude-haiku-4-5-20251001'), {})
  assert.deepEqual(reasoningMetadata('codex', 'custom-model'), {})
  assert.deepEqual(reasoningMetadata('claude', 'claude-sonnet-4-6').reasoning.efforts.map(entry => entry.id), ['low', 'medium', 'high', 'max'])
  assert.deepEqual(reasoningMetadata('codex', 'gpt-5.6-sol').reasoning.efforts.map(entry => entry.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(resolveConfig({ claudeModels: [{ id: 'custom' }] }).claudeModels.map(entry => entry.id), ['custom'])
})
