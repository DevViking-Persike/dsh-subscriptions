const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveConfig } = require('../dsh/config.js')
const { createClaudeAdapter } = require('../dsh/claude/adapter.js')
const { createCodexAdapter } = require('../dsh/codex/adapter.js')

for (const [provider, model, createAdapter, credentialKey] of [
  ['claude-code-oauth', 'claude-fable-5-1', createClaudeAdapter, 'resolveAccessToken'],
  ['codex-oauth', 'gpt-6-astra', createCodexAdapter, 'resolveAccess'],
]) {
  test(`${provider} prepares metadata without credentials and dispatches through its captured adapter`, async () => {
    let credentialReads = 0
    const adapter = createAdapter({
      config: resolveConfig({}),
      [credentialKey]: async () => { credentialReads++; return undefined },
    })
    const prepared = await adapter.prepareCall(provider, model)
    assert.deepEqual(prepared.model, await adapter.resolveModel(provider, model))
    assert.equal(credentialReads, 0)
    assert.equal(adapter.imageRequestPricing(provider, model), undefined)
    adapter.stream = () => { throw new Error('Replaced stream must not run') }
    await assert.rejects(async () => {
      for await (const chunk of prepared.stream({ provider, model, messages: [] })) {
        assert.fail(`Unexpected chunk: ${chunk.type}`)
      }
    }, error => error.code === 'MISSING_CREDENTIAL')
    assert.equal(credentialReads, 1)
  })
}
