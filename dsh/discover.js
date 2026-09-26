// Live model discovery for both subscription routes.
//
// The catalogs in config.js are curated snapshots: they name the models of the
// CLIs that shipped them, so a vendor-side release adds models before any
// plugin update can name them. Both backends answer a model-list endpoint
// under the subscription's own credential, so each route refreshes its catalog
// from that answer — at mount, on a timer, and through the control port —
// while curated entries keep their hand-verified metadata.

const { codexUserAgent } = require('./client-version.js')
const { setLiveEfforts, resetLiveEfforts } = require('./reasoning.js')

/** Text and image, the only modalities a catalog entry may declare. */
const VISION = ['text', 'image']

/**
 * Compare two dotted numeric versions.
 *
 * @param {string} left - first version, e.g. "0.153.0".
 * @param {string} right - second version.
 * @returns {number} negative when left is older, positive when newer, 0 on a tie.
 */
function compareVersions(left, right) {
  const parse = (value) => value.split('.').map(part => Number.parseInt(part, 10))
  const [a, b] = [parse(left), parse(right)]
  const width = Math.max(a.length, b.length)
  for (let at = 0; at < width; at += 1) {
    const delta = (a[at] ?? 0) - (b[at] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * Read Anthropic's model list under the Claude Code OAuth identity.
 *
 * @param {object} deps - `baseURL`, `accessToken`, `clientVersion`, `signal`.
 * @returns {Promise<object[]>} live entries with `id` and optional `name`.
 * @throws {Error} when the endpoint is unreachable or refuses the credential.
 */
async function fetchClaudeModels({ baseURL, accessToken, clientVersion, signal }) {
  const response = await fetch(`${baseURL}/v1/models?limit=1000`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219',
      'x-app': 'cli',
      'user-agent': clientVersion.userAgent,
    },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Claude model list at ${baseURL} answered ${String(response.status)}`)
  }
  const wire = await response.json()
  if (!Array.isArray(wire?.data)) throw new Error('Claude model list has no "data" array')
  return wire.data
    .filter(entry => typeof entry?.id === 'string' && entry.id.length > 0)
    .map(entry => ({
      id: entry.id,
      ...typeof entry.display_name === 'string' && entry.display_name.length > 0
        ? { name: entry.display_name }
        : {},
    }))
}

/**
 * Read the Codex backend's model list under the CLI's own identity.
 *
 * Entries the installed CLI is too old for are dropped: the backend refuses
 * them on inference with a version error, so listing one would advertise a
 * model every request then fails to reach.
 *
 * @param {object} deps - `codexBaseURL`, `accessToken`, `accountId`,
 *   `clientVersion` (the version string), `signal`.
 * @returns {Promise<object[]>} live entries with vendor metadata.
 * @throws {Error} when the endpoint is unreachable or refuses the credential.
 */
async function fetchCodexModels({ codexBaseURL, accessToken, accountId, clientVersion, signal }) {
  const response = await fetch(`${codexBaseURL}/codex/models?client_version=${encodeURIComponent(clientVersion)}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'user-agent': codexUserAgent(clientVersion),
      ...accountId.length === 0 ? {} : { 'chatgpt-account-id': accountId },
    },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Codex model list at ${codexBaseURL} answered ${String(response.status)}`)
  }
  const wire = await response.json()
  if (!Array.isArray(wire?.models)) throw new Error('Codex model list has no "models" array')
  return wire.models
    .filter(entry => typeof entry?.slug === 'string' && entry.slug.length > 0)
    .filter(entry => entry.supported_in_api !== false)
    .filter(entry => typeof entry.minimal_client_version !== 'string'
      || compareVersions(clientVersion, entry.minimal_client_version) >= 0)
    .map(entry => ({
      id: entry.slug,
      ...typeof entry.display_name === 'string' && entry.display_name.length > 0
        ? { name: entry.display_name }
        : {},
      ...Number.isSafeInteger(entry.max_context_window) ? { contextWindow: entry.max_context_window } : {},
      ...Array.isArray(entry.input_modalities) && entry.input_modalities.includes('image')
        ? { inputModalities: VISION }
        : {},
      ...Array.isArray(entry.supported_reasoning_levels) && entry.supported_reasoning_levels.length > 0
        ? { efforts: entry.supported_reasoning_levels.map(level => level?.effort).filter(id => typeof id === 'string') }
        : {},
    }))
    .filter(entry => entry.efforts === undefined || entry.efforts.length > 0)
}

/**
 * Merge live entries over the configured catalog.
 *
 * Configured entries keep their curated metadata untouched — hand-verified
 * context windows and modalities outrank an endpoint's self-description — and
 * live-only models append in endpoint order with vendor metadata filling what
 * it states and the configured defaults covering the rest.
 *
 * @param {object[]} configured - the catalog as resolved from config.
 * @param {object[]} live - normalized live entries.
 * @param {object} defaults - `contextWindow` and `maxTokens` for live-only models.
 * @returns {object[]} the merged catalog, configured order first.
 */
function mergeCatalog(configured, live, { contextWindow, maxTokens }) {
  const known = new Set(configured.map(entry => entry.id))
  const merged = configured.map(entry => ({ ...entry, inputModalities: [...entry.inputModalities] }))
  for (const entry of live) {
    if (known.has(entry.id)) continue
    known.add(entry.id)
    merged.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      contextWindow: entry.contextWindow ?? contextWindow,
      maxTokens: entry.maxTokens ?? maxTokens,
      inputModalities: [...(entry.inputModalities ?? ['text'])],
      ...entry.efforts === undefined ? {} : { efforts: [...entry.efforts] },
    })
  }
  return merged
}

/**
 * Own one route's live refresh cycle.
 *
 * The merged catalog replaces the target array's contents in place, because
 * the adapters read that same array per request; a failed refresh leaves the
 * previous list standing.
 *
 * @param {object} deps - `route`, `label`, `target` (the mutable catalog array),
 *   `configured` (its curated starting contents), `defaults`, `fetchLive`
 *   (resolves live entries, may reject), `refreshMs`, `log`.
 * @returns {{ refresh: (signal?: AbortSignal) => Promise<object[]>, start: () => void, stop: () => void, list: () => object[] }}
 */
function createModelRefresher({ route, label, target, configured, defaults, fetchLive, refreshMs, log }) {
  let timer = undefined
  let refreshedAt = undefined

  async function refresh(signal) {
    const live = await fetchLive(signal)
    const merged = mergeCatalog(configured, live, defaults)
    target.length = 0
    target.push(...merged)
    resetLiveEfforts(route)
    for (const entry of merged) {
      if (entry.efforts !== undefined) setLiveEfforts(route, entry.id, entry.efforts)
    }
    refreshedAt = new Date().toISOString()
    log?.info?.(`dsh-subscriptions: ${label} model list refreshed (${String(merged.length)} models)`)
    return merged
  }

  return {
    refresh,
    start() {
      const attempt = () => { void refresh().catch(error => { log?.warn?.(`dsh-subscriptions: ${label} model refresh failed: ${error.message}`) }) }
      attempt()
      timer = setInterval(attempt, refreshMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
    list() {
      return {
        models: target.map(({ id, name }) => ({ id, name })),
        ...refreshedAt === undefined ? {} : { refreshedAt },
      }
    },
  }
}

module.exports = { compareVersions, fetchClaudeModels, fetchCodexModels, mergeCatalog, createModelRefresher }
