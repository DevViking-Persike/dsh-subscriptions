// Error vocabulary shared by both subscription routes.
//
// The harness classifies a failure by the `code` it carries, and its retry
// plugin reads `failure.status` and `failure.providerRetryAfterMs` to honor a
// provider's own backoff. Those field names are the contract that crosses the
// package boundary, so they are asserted by a test rather than assumed.
//
// The two message classifiers are ports of the harness's own
// `isContextWindowExceededError` and `isQuotaExceededError`. A provider that
// answers 400 for an oversized prompt is telling us something the status code
// does not, and calling that INVALID_REQUEST would hide a recoverable
// condition behind an unrecoverable-looking one.

/** Structured context-overflow wording, as distinct from a plain size complaint. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/**
 * Whether provider text identifies a request exceeding the model context.
 * @param {string} detail - provider code, type, and message joined.
 * @returns {boolean}
 */
function isContextWindowExceeded(detail) {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/**
 * Whether provider text identifies exhausted quota or credit.
 * @param {string} detail - provider code, type, and message joined.
 * @returns {boolean}
 */
function isQuotaExceeded(detail) {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\bexceeded\s+your\s+current\s+quota\b/i.test(detail)
    || /\b(?:quota|credits?|balance)\s+(?:has\s+been\s+)?(?:exhausted|depleted|used\s+up)\b/i.test(detail)
}

/**
 * One adapter failure.
 *
 * `failure` is the object the harness reads; it is carried as an own property
 * so it survives being thrown across the package boundary.
 */
class SubscriptionError extends Error {
  /**
   * @param {string} message - human-readable cause.
   * @param {string} code - the harness failure code.
   * @param {{status?: number, providerRetryAfterMs?: number, requestId?: string, cause?: unknown}} [extra]
   */
  constructor(message, code, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'SubscriptionError'
    this.code = code
    this.failure = {
      message,
      code,
      ...extra.status === undefined ? {} : { status: extra.status },
      ...extra.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: extra.providerRetryAfterMs },
      ...extra.requestId === undefined ? {} : { requestId: extra.requestId },
    }
  }
}

/**
 * Classify one HTTP failure.
 *
 * Status alone is not enough: an OpenAI-compatible endpoint answers 400 for
 * both a malformed request and an oversized prompt, and only the message
 * distinguishes a condition the caller can recover from by compacting.
 *
 * @param {number} status - HTTP status.
 * @param {string} detail - provider error text.
 * @returns {string} the harness failure code.
 */
function httpErrorCode(status, detail) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 413) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  if (status === 400) {
    if (isContextWindowExceeded(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
    if (isQuotaExceeded(detail)) return 'QUOTA'
    return 'INVALID_REQUEST'
  }
  // An unmapped status is reported by its number rather than guessed at, so a
  // provider-specific code stays visible instead of being folded into SERVER.
  return `HTTP_${String(status)}`
}

/**
 * Parse a `retry-after` header into milliseconds.
 *
 * Both forms in RFC 9110 are accepted: delta-seconds and an HTTP date. A past
 * date yields 0 rather than a negative delay.
 *
 * @param {string | null} header - the raw header value.
 * @returns {number | undefined} milliseconds, or undefined when unusable.
 */
function retryAfterMs(header) {
  if (header === null || header === undefined) return undefined
  const trimmed = header.trim()
  if (trimmed.length === 0) return undefined
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/**
 * Strip anything shaped like a subscription token out of upstream text.
 *
 * Token-endpoint error bodies are upstream-controlled and reach logs and the
 * session transcript, so they are cleaned and capped before being quoted.
 *
 * @param {unknown} text - upstream message text.
 * @returns {string} the redacted, length-capped text.
 */
function redact(text) {
  return String(text)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
    .slice(0, 300)
}

module.exports = { SubscriptionError, httpErrorCode, isContextWindowExceeded, isQuotaExceeded, redact, retryAfterMs }
