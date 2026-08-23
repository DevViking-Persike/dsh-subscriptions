// SSE decoding for the OpenAI Responses transport.
//
// Unlike the chat-completions family there is no `[DONE]` sentinel: the server
// signals completion with a terminal event. A stream that ends without one is
// truncated and must not be mistaken for a finished response.

const { EventSourceParserStream } = require('eventsource-parser/stream')
const { SubscriptionError } = require('../errors.js')

/** The events that end a response. */
const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed'])

/**
 * Parse a Responses SSE byte stream into wire events.
 *
 * @param {ReadableStream} stream - raw SSE bytes.
 * @param {(comment: string) => void} [onComment] - transport-activity callback.
 * @returns {AsyncGenerator<object>} decoded events, a terminal one last.
 */
async function* parseSse(stream, onComment) {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new SubscriptionError(`malformed SSE payload: ${data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    yield parsed
    if (TERMINAL.has(parsed.type)) return
  }
  throw new SubscriptionError('Codex SSE stream ended without a terminal event', 'STREAM_CLOSED')
}

module.exports = { TERMINAL, parseSse }
