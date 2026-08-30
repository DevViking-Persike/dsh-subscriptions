// The adapters refuse an image a model cannot see before the credential, the
// attachment read, or the network — so the operator can still pick a model
// that takes images.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createClaudeAdapter } = require('../dsh/claude/adapter.js')
const { createCodexAdapter } = require('../dsh/codex/adapter.js')
const { resolveConfig } = require('../dsh/config.js')

const image = { type: 'image', attachment: { id: 'a1', mediaType: 'image/png' } }
const request = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: [image] }] }

/** Drain one adapter stream so its first thrown error surfaces. */
async function drain(stream) {
  for await (const chunk of stream) void chunk
}

test('Claude: an image on a text-only model is refused before the credential', async () => {
  let credentialRead = false
  const adapter = createClaudeAdapter({
    config: resolveConfig({ claudeModels: [{ id: 'claude-sonnet-5' }] }),
    resolveAccessToken: async () => { credentialRead = true; return 't' },
    resolveAttachments: () => ({ readImage: async () => { throw new Error('must not be read') } }),
  })
  await assert.rejects(
    () => drain(adapter.stream({ ...request, provider: 'claude-code-oauth' })),
    /does not accept image input/,
  )
  assert.equal(credentialRead, false)
})

test('Claude: an image without the attachment service is refused', async () => {
  const adapter = createClaudeAdapter({
    config: resolveConfig({}),
    resolveAccessToken: async () => 't',
  })
  await assert.rejects(
    () => drain(adapter.stream({ ...request, provider: 'claude-code-oauth' })),
    /requires the durable attachment service/,
  )
})

test('Codex: an image on a text-only model is refused before the credential', async () => {
  let credentialRead = false
  const adapter = createCodexAdapter({
    config: resolveConfig({ codexModels: [{ id: 'gpt-5.5' }] }),
    resolveAccess: async () => { credentialRead = true; return { token: 't', accountId: 'a' } },
    resolveAttachments: () => ({ readImage: async () => { throw new Error('must not be read') } }),
  })
  await assert.rejects(
    () => drain(adapter.stream({ ...request, model: 'gpt-5.5', provider: 'codex-oauth' })),
    /does not accept image input/,
  )
  assert.equal(credentialRead, false)
})

test('catalog defaults declare image input where the vendor documents it', async () => {
  const config = resolveConfig({})
  const claude = createClaudeAdapter({ config, resolveAccessToken: async () => 't' })
  const codex = createCodexAdapter({ config, resolveAccess: async () => ({ token: 't', accountId: 'a' }) })
  const claudeModel = await claude.resolveModel('claude-code-oauth', 'claude-sonnet-5')
  const codexModel = await codex.resolveModel('codex-oauth', 'gpt-5.5')
  const spark = await codex.resolveModel('codex-oauth', 'gpt-5.3-codex-spark')
  assert.deepEqual(claudeModel.inputModalities, ['text', 'image'])
  assert.deepEqual(codexModel.inputModalities, ['text', 'image'])
  assert.deepEqual(spark.inputModalities, ['text'])
})
