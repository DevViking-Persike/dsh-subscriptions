// Plugin configuration for both subscription routes.
//
// Validation is by hand so the plugin carries no schema dependency, and every
// bound is checked at load: a misconfiguration is self-contained, so it must
// fail where the operator can see it rather than on the first model call.

const { join } = require('node:path')
const { resolveDshHome } = require('./paths.js')

/** Idle budget between stream reads before the transport gives up. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Context window assumed for a model absent from the catalog. */
const DEFAULT_CONTEXT_WINDOW = 200_000
/** Output cap applied when neither request nor catalog states one. */
const DEFAULT_MAX_TOKENS = 32_000
/** Node's largest usable timer delay; a longer one fires immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Modalities a catalog entry may declare.
 *
 * Only image is added here: the serializers resolve image attachments into
 * wire parts, and declaring a modality the adapter cannot send would admit
 * input it then drops.
 */
const MODEL_MODALITIES = ['text', 'image']

/** Text and image, for the models whose vendor documents image input. */
const VISION = ['text', 'image']

/** Claude models the subscription serves, when the operator configures none. */
const DEFAULT_CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxTokens: 64_000, inputModalities: VISION },
]

/** Codex models the subscription serves, when the operator configures none. */
const DEFAULT_CODEX_MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_050_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  // Codex Spark serves text only, so over-claiming would admit an image the
  // endpoint refuses after the message is durable.
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 400_000, maxTokens: 128_000 },
]

/** Retry policy matching the harness's own normal-mode defaults. */
const DEFAULT_RETRY_POLICY = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'STREAM_CLOSED'],
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
}

/**
 * Require a positive integer within the timer-safe range.
 * @param {unknown} value - the configured value.
 * @param {string} field - field name, for the message.
 * @param {number} fallback - value used when unset.
 * @returns {number}
 */
function positiveInteger(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-subscriptions: ${field} must be a positive integer`)
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-subscriptions: ${field} must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return value
}

/**
 * Validate one entry's declared input modalities.
 *
 * The default is text alone, and that asymmetry is deliberate: under-claiming
 * refuses an image before it is attached, which the operator sees immediately,
 * while over-claiming admits an image the endpoint rejects after the message
 * is durable — a request no later turn can recover.
 *
 * @param {unknown} value - the configured array.
 * @param {string} field - field name, for the message.
 * @returns {string[]} the validated modalities.
 */
function modalities(value, field) {
  if (value === undefined) return ['text']
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`dsh-subscriptions: ${field} must be a non-empty array`)
  }
  const seen = new Set()
  for (const modality of value) {
    if (!MODEL_MODALITIES.includes(modality)) {
      throw new Error(`dsh-subscriptions: ${field} must contain only ${MODEL_MODALITIES.join(' and ')}`)
    }
    if (seen.has(modality)) throw new Error(`dsh-subscriptions: ${field} must not contain duplicates`)
    seen.add(modality)
  }
  if (!seen.has('text')) throw new Error(`dsh-subscriptions: ${field} must include "text"`)
  return [...value]
}

/**
 * Validate one configured model catalog.
 * @param {unknown} value - the configured array.
 * @param {string} field - field name, for the message.
 * @param {object[]} fallback - catalog used when unset.
 * @returns {object[]}
 */
function catalog(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`dsh-subscriptions: ${field} must be a non-empty array`)
  }
  const seen = new Set()
  return value.map((entry, at) => {
    const where = `${field}[${String(at)}]`
    if (typeof entry?.id !== 'string' || entry.id.length === 0) {
      throw new Error(`dsh-subscriptions: ${where}.id must be a non-empty string`)
    }
    if (seen.has(entry.id)) throw new Error(`dsh-subscriptions: ${where}.id "${entry.id}" is duplicated`)
    seen.add(entry.id)
    return {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      contextWindow: positiveInteger(entry.contextWindow, `${where}.contextWindow`, DEFAULT_CONTEXT_WINDOW),
      maxTokens: positiveInteger(entry.maxTokens, `${where}.maxTokens`, DEFAULT_MAX_TOKENS),
      inputModalities: Object.freeze(modalities(entry.inputModalities, `${where}.inputModalities`)),
    }
  })
}

/**
 * Resolve and validate the plugin configuration.
 *
 * A supplied catalog replaces the default rather than merging: naming three
 * models means those three, and a merge would silently reintroduce models the
 * subscription does not serve.
 *
 * @param {object} [raw] - the cordis.yml entry config.
 * @returns {object} the frozen resolved configuration.
 */
function resolveConfig(raw = {}) {
  const dshHome = resolveDshHome(raw.dshHome)
  const baseURL = (raw.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const codexBaseURL = (raw.codexBaseURL ?? 'https://chatgpt.com/backend-api').replace(/\/+$/, '')
  for (const [field, value] of [['baseURL', baseURL], ['codexBaseURL', codexBaseURL]]) {
    if (!/^https?:\/\//.test(value)) throw new Error(`dsh-subscriptions: ${field} must be an http(s) URL`)
  }
  const routes = raw.routes ?? ['claude', 'codex']
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('dsh-subscriptions: routes must be a non-empty array')
  }
  for (const route of routes) {
    if (route !== 'claude' && route !== 'codex') {
      throw new Error(`dsh-subscriptions: unknown route "${String(route)}"; expected "claude" or "codex"`)
    }
  }

  return Object.freeze({
    routes: Object.freeze([...routes]),
    baseURL,
    codexBaseURL,
    claudeCredentialPath: raw.claudeCredentialPath ?? join(dshHome, 'claude-code-oauth.json'),
    codexCredentialPath: raw.codexCredentialPath ?? join(dshHome, 'codex-oauth.json'),
    claudeImportFrom: raw.claudeImportFrom,
    codexImportFrom: raw.codexImportFrom,
    // Port 0 is meaningful here: it asks the OS for a free port, which is how
    // a test mounts the plugin without claiming the operator's real one.
    controlPort: raw.controlPort === 0 ? 0 : positiveInteger(raw.controlPort, 'controlPort', 1458),
    streamIdleTimeoutMs: positiveInteger(raw.streamIdleTimeoutMs, 'streamIdleTimeoutMs', DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    defaultContextWindow: positiveInteger(raw.defaultContextWindow, 'defaultContextWindow', DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(raw.maxTokens, 'maxTokens', DEFAULT_MAX_TOKENS),
    retryPolicy: Object.freeze(raw.retryPolicy === undefined
      ? DEFAULT_RETRY_POLICY
      : { ...DEFAULT_RETRY_POLICY, ...raw.retryPolicy }),
    claudeModels: Object.freeze(catalog(raw.claudeModels, 'claudeModels', DEFAULT_CLAUDE_MODELS)),
    codexModels: Object.freeze(catalog(raw.codexModels, 'codexModels', DEFAULT_CODEX_MODELS)),
  })
}

module.exports = {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_CODEX_MODELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  MODEL_MODALITIES,
  VISION,
  resolveConfig,
}
