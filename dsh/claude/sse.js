// SSE decoding for the Anthropic transport.
//
// Framing belongs to `eventsource-parser`; hand-rolling it is how a read that
// splits mid-UTF-8 becomes corrupted text. This module keeps only the protocol
// rule: `message_stop` terminates, and a stream that ends without it raises
// rather than looking complete.

const { EventSourceParserStream } = require('eventsource-parser/stream')
const { SubscriptionError } = require('../errors.js')

/**
 * Parse an Anthropic SSE byte stream into wire events.
 *
 * @param {ReadableStream} stream - raw SSE bytes.
 * @param {(comment: string) => void} [onComment] - transport-activity callback.
 * @returns {AsyncGenerator<object>} decoded events, `message_stop` last.
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
    if (parsed.type === 'message_stop') return
  }
  throw new SubscriptionError('Claude SSE stream ended without message_stop', 'STREAM_CLOSED')
}

module.exports = { parseSse }
