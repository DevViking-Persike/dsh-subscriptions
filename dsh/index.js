// dsh-subscriptions — DeepSeek Harness plugin: use your own Claude and
// ChatGPT/Codex subscriptions as model providers.
//
// One package, two routes. The wire formats have nothing in common, but the
// credential machinery — the cross-process writer lock, the PKCE flow, the
// refresh cycle — is identical, and that is the code where a bug corrupts a
// real token. Keeping one copy means one place to fix it.
//
// Plain JavaScript with no build step and no dependency on any harness
// package: the adapters are plain objects, because `registerAdapter` validates
// the metadata they return rather than the class they came from.

const { createServer } = require('node:http')
const { createClaudeAdapter, PROVIDER: CLAUDE_PROVIDER } = require('./claude/adapter.js')
const { createCodexAdapter, PROVIDER: CODEX_PROVIDER } = require('./codex/adapter.js')
const { resolveConfig } = require('./config.js')
const { claudeCodeUserAgent, claudeCodeVersionResolver, codexUserAgent, codexVersionResolver } = require('./client-version.js')
const { redact } = require('./errors.js')
const { createSession } = require('./session.js')
const { translate: claudeTranslate } = require('./claude/translate.js')

/** Anthropic's public Claude Code client. */
const CLAUDE_SPEC = {
  label: 'Claude',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  // The claude.ai subscription flow (Pro/Max accounts), whose tokens carry
  // user:inference. The console flow at platform.claude.com/oauth/authorize
  // grants org credentials without it and the API refuses those for
  // inference with a scope permission_error.
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  scope: 'user:profile user:inference user:sessions:claude_code',
  // Fixed by the registered public client; it cannot be reconfigured.
  redirectUri: 'http://localhost:54545/callback',
  // Mirrors the official client exactly: `code=true` on the authorize URL,
  // and a JSON token request whose body carries the flow's `state`.
  extraAuthorizeParams: { code: 'true' },
  tokenBody: 'json',
}

/** OpenAI's public Codex CLI client. */
const CODEX_SPEC = {
  label: 'Codex',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  redirectUri: 'http://localhost:1455/auth/callback',
  extraAuthorizeParams: {
    // Without this the id_token carries no organization claim, the account id
    // comes back empty, and requests reach the wrong workspace.
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'deepseek-harness',
  },
}

/**
 * The chunk field names the harness assembler reads.
 *
 * This plugin lives outside the harness repository, which makes no
 * compatibility promise before its first release. A renamed field raises
 * nothing — `argumentsDelta` becoming `arguments` would append the string
 * "undefined" to every tool call — so the vocabulary is checked once at load
 * and a mismatch refuses to mount.
 */
const EXPECTED_CHUNK_KEYS = {
  'block-start': ['type', 'index', 'blockType'],
  'text-delta': ['type', 'index', 'text'],
  'tool-call-delta': ['type', 'index', 'id', 'name', 'argumentsDelta'],
  'block-end': ['type', 'index', 'block'],
  usage: ['type', 'usage'],
  finish: ['type', 'reason'],
}

/**
 * Prove the emitted chunk vocabulary still matches what this plugin expects.
 * @throws {Error} when a chunk type or field set has drifted.
 */
async function assertChunkVocabulary() {
  async function* events() {
    yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c', name: 'f' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }
    yield { type: 'message_stop' }
  }
  const seen = new Map()
  for await (const chunk of claudeTranslate(events())) {
    if (!seen.has(chunk.type)) seen.set(chunk.type, Object.keys(chunk).sort())
  }
  for (const [type, keys] of Object.entries(EXPECTED_CHUNK_KEYS)) {
    const actual = seen.get(type)
    if (actual === undefined) continue
    const expected = [...keys].sort()
    if (actual.join(',') !== expected.join(',')) {
      throw new Error(
        `dsh-subscriptions: "${type}" chunk fields changed (expected ${expected.join(',')}, got ${actual.join(',')}); `
        + 'the plugin needs updating before it can be trusted',
      )
    }
  }
}

/** Convert a CLIProxyAPI Claude auth document, or undefined when it is not one. */
function claudeImport(source) {
  if (typeof source?.access_token !== 'string' || typeof source.refresh_token !== 'string') return undefined
  const parsed = Date.parse(source.expired ?? '')
  return {
    access: source.access_token,
    refresh: source.refresh_token,
    // A missing expiry becomes 0 on purpose: the first use then refreshes,
    // which also proves the imported refresh token is live.
    expires: Number.isFinite(parsed) ? parsed : 0,
    accountId: typeof source.account_id === 'string' ? source.account_id : '',
    email: typeof source.email === 'string' ? source.email : '',
  }
}

/**
 * Serve the sign-in control pages on loopback.
 *
 * A busy port must not take the model routes down with it, so a listen failure
 * is reported and the routes still register.
 *
 * @param {object} sessions - the enabled sessions by route name.
 * @param {number} port - the loopback port.
 * @param {object} log - where to report.
 * @returns {Promise<() => void>} the disposer.
 */
async function startControlServer(sessions, port, log) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`)
    const [, route, action] = url.pathname.split('/')
    const session = sessions[route]
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (session === undefined) {
      reply(404, { error: `unknown route "${String(route)}"`, routes: Object.keys(sessions) })
      return
    }
    if (action === 'start') {
      try {
        const flow = session.beginLogin()
        void flow.completion
        res.writeHead(302, { location: flow.url })
        res.end()
      } catch (error) {
        reply(409, { error: redact(error.message) })
      }
      return
    }
    if (action === 'status') {
      void session.status().then(value => { reply(200, value) })
      return
    }
    if (action === 'logout' && req.method === 'POST') {
      void session.logout().then(() => { reply(200, { connected: false }) })
      return
    }
    reply(404, { error: 'expected /<route>/start, /<route>/status, or POST /<route>/logout' })
  })

  await new Promise((resolve) => {
    server.on('error', (error) => {
      log?.error?.(`dsh-subscriptions: sign-in server unavailable on port ${String(port)}: ${error.message}`)
      resolve()
    })
    // Loopback only: these endpoints start and end sign-in flows.
    server.listen(port, '127.0.0.1', resolve)
  })
  return () => { server.close() }
}

module.exports = {
  name: 'dsh-subscriptions',
  inject: ['llm'],
  async apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig)
    // Both checks run before anything registers, so drift or misconfiguration
    // fails where the operator is looking rather than on the first model call.
    await assertChunkVocabulary()
    const log = ctx.logger ?? console

    const sessions = {}
    const disposers = []

    if (config.routes.includes('claude')) {
      const session = createSession({ spec: CLAUDE_SPEC, filename: config.claudeCredentialPath, log })
      sessions.claude = session
      await session.seedFrom(config.claudeImportFrom, claudeImport).catch((error) => {
        log.error?.(`dsh-subscriptions: Claude import failed: ${redact(error.message)}`)
      })
      const adapter = createClaudeAdapter({
        config,
        resolveAccess: () => session.access(),
        resolveAccessToken: async () => (await session.access())?.token,
        // Optional and resolved per request: a deployment without the
        // attachment service still serves every text request, and mounting
        // that service later starts image input without a restart.
        resolveAttachments: () => ctx.get('attachments'),
      })
      ctx.effect(() => ctx.llm.registerAdapter([CLAUDE_PROVIDER], adapter), 'dsh-subscriptions: Claude route')
      const identity = claudeCodeVersionResolver(config)()
      log.info?.(`dsh-subscriptions: Claude route identifies as ${claudeCodeUserAgent(identity.version)} (${identity.source})`)
      disposers.push(session.startRefreshTimer())
    }

    if (config.routes.includes('codex')) {
      const session = createSession({
        spec: CODEX_SPEC,
        filename: config.codexCredentialPath,
        log,
        // The organization claim names the workspace the backend serves.
        accountFrom: payload => payload?.['https://api.openai.com/auth']?.chatgpt_account_id,
      })
      sessions.codex = session
      await session.seedFrom(config.codexImportFrom, claudeImport).catch((error) => {
        log.error?.(`dsh-subscriptions: Codex import failed: ${redact(error.message)}`)
      })
      const adapter = createCodexAdapter({
        config,
        resolveAccess: () => session.access(),
        resolveAttachments: () => ctx.get('attachments'),
      })
      ctx.effect(() => ctx.llm.registerAdapter([CODEX_PROVIDER], adapter), 'dsh-subscriptions: Codex route')
      const identity = codexVersionResolver(config)()
      log.info?.(`dsh-subscriptions: Codex route identifies as ${codexUserAgent(identity.version)} (${identity.source})`)
      disposers.push(session.startRefreshTimer())
    }

    const closeControl = await startControlServer(sessions, config.controlPort, log)
    disposers.push(closeControl)

    for (const [route, session] of Object.entries(sessions)) {
      const state = await session.status()
      if (!state.connected) {
        log.info?.(
          `dsh-subscriptions: ${session.spec.label} is not connected — `
          + `open http://127.0.0.1:${String(config.controlPort)}/${route}/start to sign in`,
        )
      }
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-subscriptions: credential lifecycle')
  },
}

module.exports.CLAUDE_SPEC = CLAUDE_SPEC
module.exports.CODEX_SPEC = CODEX_SPEC
module.exports.claudeImport = claudeImport
