// Live model discovery: endpoint parsing, version gating, catalog merge, and
// the refresher's in-place replacement contract. All endpoints are local
// node:http servers, matching the suite's no-vendor-network policy.

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

const {
  compareVersions,
  createModelRefresher,
  fetchClaudeModels,
  fetchCodexModels,
  mergeCatalog,
} = require('../dsh/discover.js')
const { reasoningMetadata } = require('../dsh/reasoning.js')

/** Start one loopback server answering every request with `handle`. */
function serve(handle) {
  const server = createServer(handle)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve(server) })
  })
}

const close = (server) => new Promise((resolve) => { server.close(() => { resolve(undefined) }) })
const port = (server) => server.address().port

test('compareVersions orders dotted numerics', () => {
  assert.equal(Math.sign(compareVersions('0.153.4', '0.157.1')), -1)
  assert.equal(Math.sign(compareVersions('0.157.1', '0.153.0')), 1)
  assert.equal(compareVersions('2.1.283', '2.1.283'), 0)
  assert.equal(Math.sign(compareVersions('1.2', '1.2.1')), -1)
})

test('fetchClaudeModels reads the data array', async () => {
  const server = await serve((req, res) => {
    assert.equal(req.url, '/v1/models?limit=1000')
    assert.equal(req.headers.authorization, 'Bearer tok')
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-x' }] }))
  })
  try {
    const live = await fetchClaudeModels({ baseURL: `http://127.0.0.1:${String(port(server))}`, accessToken: 'tok', clientVersion: { userAgent: 'claude-cli/2.1.283' } })
    assert.deepEqual(live, [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-x' }])
  } finally {
    await close(server)
  }
})

test('fetchCodexModels gates on client version and maps metadata', async () => {
  const server = await serve((req, res) => {
    assert.equal(req.url, '/codex/models?client_version=0.157.1')
    res.end(JSON.stringify({ models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', max_context_window: 872000, input_modalities: ['text', 'image'],
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }], minimal_client_version: '0.156.0' },
      { slug: 'gpt-7-future', minimal_client_version: '0.160.0' },
      { slug: 'gpt-hidden', supported_in_api: false },
      { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', minimal_client_version: '0.150.0' },
    ] }))
  })
  try {
    const live = await fetchCodexModels({ codexBaseURL: `http://127.0.0.1:${String(port(server))}`, accessToken: 'tok', accountId: 'acct', clientVersion: '0.157.1' })
    assert.deepEqual(live.map(entry => entry.id), ['gpt-6-luna', 'gpt-6-sol'])
    assert.equal(live[0].contextWindow, 872000)
    assert.deepEqual(live[0].inputModalities, ['text', 'image'])
    assert.deepEqual(live[0].efforts, ['low', 'high', 'ultra'])
    assert.equal(live[1].inputModalities, undefined)
  } finally {
    await close(server)
  }
})

test('mergeCatalog keeps curated metadata and appends live-only models', () => {
  const configured = [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_050_000, maxTokens: 128_000, inputModalities: ['text', 'image'] }]
  const merged = mergeCatalog(configured, [
    { id: 'gpt-6-astra', name: 'ignored' },
    { id: 'gpt-6-luna', contextWindow: 872000, inputModalities: ['text', 'image'], efforts: ['low', 'ultra'] },
    { id: 'gpt-6-sol' },
  ], { contextWindow: 200_000, maxTokens: 32_000 })
  assert.deepEqual(merged, [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_050_000, maxTokens: 128_000, inputModalities: ['text', 'image'] },
    { id: 'gpt-6-luna', name: 'gpt-6-luna', contextWindow: 872000, maxTokens: 32_000, inputModalities: ['text', 'image'], efforts: ['low', 'ultra'] },
    { id: 'gpt-6-sol', name: 'gpt-6-sol', contextWindow: 200_000, maxTokens: 32_000, inputModalities: ['text'] },
  ])
})

test('a refresher replaces the target in place and reports vendor efforts', async () => {
  const target = [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_050_000, maxTokens: 128_000, inputModalities: ['text', 'image'] }]
  const configured = [{ ...target[0], inputModalities: [...target[0].inputModalities] }]
  let fail = false
  const refresher = createModelRefresher({
    route: 'codex',
    label: 'Codex',
    target,
    configured,
    defaults: { contextWindow: 200_000, maxTokens: 32_000 },
    fetchLive: async () => {
      if (fail) throw new Error('endpoint down')
      return [{ id: 'gpt-6-luna', efforts: ['low', 'ultra'] }]
    },
    refreshMs: 3_600_000,
    log: {},
  })
  await refresher.refresh()
  assert.deepEqual(target.map(entry => entry.id), ['gpt-6-astra', 'gpt-6-luna'])
  assert.deepEqual(reasoningMetadata('codex', 'gpt-6-luna').reasoning.efforts.map(e => e.id), ['low', 'ultra'])
  assert.deepEqual(reasoningMetadata('codex', 'gpt-6-luna').reasoning.efforts.map(e => e.name), ['Low', 'Ultra'])

  // A failed refresh leaves the previous list and efforts standing.
  fail = true
  await assert.rejects(() => { return refresher.refresh() }, /endpoint down/)
  assert.deepEqual(target.map(entry => entry.id), ['gpt-6-astra', 'gpt-6-luna'])
  assert.deepEqual(reasoningMetadata('codex', 'gpt-6-luna').reasoning.efforts.map(e => e.id), ['low', 'ultra'])

  fail = false
  const list = refresher.list()
  assert.deepEqual(list.models, [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }, { id: 'gpt-6-luna', name: 'gpt-6-luna' }])
  assert.equal(typeof list.refreshedAt, 'string')
})
