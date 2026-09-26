// Exact model capabilities shared by discovery and request validation.
const { SubscriptionError } = require('./errors.js')

const CLAUDE_FIVE = new Set(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5'])
const CODEX_FOUR = new Set(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5'])
const LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Xhigh', max: 'Ultra Code (max)', ultra: 'Ultra' }

/** Effort ids the live model list reported, keyed by `${route}:${model}`. */
const LIVE_EFFORTS = new Map()

/**
 * Record one model's vendor-reported effort ids, overriding the static set.
 * @param {string} route - 'claude' or 'codex'.
 * @param {string} model - the model id.
 * @param {string[]} ids - vendor-reported effort ids, in vendor order.
 */
function setLiveEfforts(route, model, ids) {
  LIVE_EFFORTS.set(`${route}:${model}`, [...ids])
}

/**
 * Drop every live effort record one route reported, before a refresh re-adds
 * the models that still stand.
 * @param {string} route - 'claude' or 'codex'.
 */
function resetLiveEfforts(route) {
  for (const key of LIVE_EFFORTS.keys()) {
    if (key.startsWith(`${route}:`)) LIVE_EFFORTS.delete(key)
  }
}

/** Return fresh capability metadata; omission preserves the provider default. */
function reasoningMetadata(route, model) {
  const live = LIVE_EFFORTS.get(`${route}:${model}`)
  if (live !== undefined) return { reasoning: { efforts: live.map(id => ({ id, name: LABELS[id] ?? id })) } }
  let ids
  if ((route === 'claude' && CLAUDE_FIVE.has(model)) || (route === 'codex' && model === 'gpt-6-astra')) {
    ids = ['low', 'medium', 'high', 'xhigh', 'max']
  } else if (route === 'claude' && model === 'claude-sonnet-4-6') {
    ids = ['low', 'medium', 'high', 'max']
  } else if (route === 'codex' && CODEX_FOUR.has(model)) {
    ids = ['low', 'medium', 'high', 'xhigh']
  }
  return ids === undefined ? {} : { reasoning: { efforts: ids.map(id => ({ id, name: LABELS[id] })) } }
}

/** Reject unsupported declared choices without changing the selected effort. */
function assertReasoningEffort(route, model, effort) {
  if (effort === undefined) return
  const { reasoning } = reasoningMetadata(route, model)
  // Custom Codex endpoints retain their existing direct-serializer vocabulary;
  // no selector is advertised without exact model capability metadata.
  if (reasoning === undefined && route === 'codex') return
  if (!reasoning?.efforts.some(entry => entry.id === effort)) {
    throw new SubscriptionError(`Model "${model}" does not support reasoning effort "${effort}".`, 'UNSUPPORTED_REASONING_EFFORT')
  }
}

module.exports = { assertReasoningEffort, reasoningMetadata, resetLiveEfforts, setLiveEfforts }
