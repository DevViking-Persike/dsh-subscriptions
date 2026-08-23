// Anthropic wire events to harness stream chunks.
//
// This protocol is not OpenAI chat-completions and its differences are the
// dangerous part, because every one of them fails silently:
//
//   - Usage is ALREADY disjoint here. `input_tokens` excludes cache reads, so
//     `cacheReadTokens` maps straight across. Applying the OpenAI rule
//     (input = prompt - cached) subtracts a second time and under-reports the
//     context with nothing raised.
//   - `message_delta.usage.output_tokens` is a running TOTAL, so it is
//     assigned, never accumulated.
//   - A thinking delta carries `.thinking`, and a tool delta carries
//     `.partial_json`. Reading `.text` on either appends "undefined".
//   - Blocks are closed from insertion order, not from the open map:
//     `content_block_stop` already removed every entry by the time the stream
//     ends, so iterating the map would emit nothing.

const { SubscriptionError } = require('../errors.js')

/** Code the harness treats as retryable when a model completes with no content. */
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * Map an Anthropic stop reason onto the harness's tagged finish reason.
 * @param {string} reason - the wire value.
 * @returns {object} the tagged reason.
 */
function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn': return { kind: 'stop' }
    case 'stop_sequence': return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default:
      // refusal, content_filter, and anything added later: surfaced as an
      // error finish carrying the raw word rather than flattened into `stop`.
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

/**
 * Map Anthropic usage onto harness counts.
 *
 * No subtraction: this endpoint already reports `input_tokens` net of cache
 * reads, unlike the OpenAI family.
 *
 * @param {object} usage - wire usage.
 * @returns {object} the harness counts present in this payload.
 */
function mapUsage(usage) {
  return {
    ...usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens },
    ...usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens },
    ...usage.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: usage.cache_read_input_tokens },
  }
}

/** Close one open block into the content block a `block-end` carries. */
function closeBlock(block) {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text }
}

/**
 * Convert one delta, or nothing when it does not match its block's kind.
 *
 * A mismatched delta is dropped rather than raised: the wire occasionally
 * interleaves a kind the block was not opened for, and refusing the whole
 * stream over it would be worse than ignoring it.
 *
 * @param {object} block - the open block.
 * @param {object} delta - the wire delta.
 * @returns {object|undefined} the chunk to emit.
 */
function deltaChunk(block, delta) {
  if (delta.type === 'text_delta') {
    if (block.kind !== 'text') return undefined
    block.text += delta.text
    return { type: 'text-delta', index: block.index, text: delta.text }
  }
  if (delta.type === 'thinking_delta') {
    if (block.kind !== 'reasoning') return undefined
    block.text += delta.thinking
    return { type: 'reasoning-delta', index: block.index, text: delta.thinking }
  }
  if (delta.type === 'input_json_delta') {
    if (block.kind !== 'tool-call') return undefined
    block.text += delta.partial_json
    return {
      type: 'tool-call-delta',
      index: block.index,
      id: block.callId ?? '',
      ...block.name === undefined ? {} : { name: block.name },
      // `argumentsDelta` on the delta, `arguments` on the closed block. The
      // assembler appends this field directly, so a wrong name appends the
      // string "undefined" to every tool call and raises nothing.
      argumentsDelta: delta.partial_json,
    }
  }
  return undefined
}

/**
 * Translate Anthropic events into harness stream chunks.
 *
 * @param {AsyncIterable<object>} events - decoded SSE events.
 * @returns {AsyncGenerator<object>} harness stream chunks.
 */
async function* translate(events) {
  const blocks = new Map()
  const order = []
  let pendingFinish
  const usage = {}

  for await (const event of events) {
    if (event.type === 'message_start') {
      if (event.message?.usage !== undefined) Object.assign(usage, mapUsage(event.message.usage))
      continue
    }
    if (event.type === 'content_block_start') {
      const wire = event.content_block
      const kind = wire.type === 'thinking' ? 'reasoning' : wire.type === 'tool_use' ? 'tool-call' : 'text'
      const block = {
        index: event.index,
        kind,
        text: '',
        ...wire.id === undefined ? {} : { callId: wire.id },
        ...wire.name === undefined ? {} : { name: wire.name },
      }
      blocks.set(event.index, block)
      order.push(block)
      yield { type: 'block-start', index: block.index, blockType: kind }
      continue
    }
    if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index)
      if (block === undefined) {
        throw new SubscriptionError(`content_block_delta for unopened block ${String(event.index)}`, 'MALFORMED_RESPONSE')
      }
      const chunk = deltaChunk(block, event.delta)
      if (chunk !== undefined) yield chunk
      continue
    }
    if (event.type === 'content_block_stop') {
      if (!blocks.has(event.index)) {
        throw new SubscriptionError(`content_block_stop for unopened block ${String(event.index)}`, 'MALFORMED_RESPONSE')
      }
      blocks.delete(event.index)
      continue
    }
    if (event.type === 'message_delta') {
      if (typeof event.delta?.stop_reason === 'string') pendingFinish = mapStopReason(event.delta.stop_reason)
      // A running total, so assignment rather than accumulation.
      if (event.usage?.output_tokens !== undefined) usage.outputTokens = event.usage.output_tokens
      continue
    }
    if (event.type === 'message_stop') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        yield { type: 'usage', usage }
      }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }
    if (event.type === 'error') {
      throw new SubscriptionError(
        `Claude stream error: ${String(event.error?.message ?? 'unknown')}`,
        typeof event.error?.type === 'string' ? event.error.type.toUpperCase() : 'SERVER',
      )
    }
    // `ping` and any future event: ignored rather than refused, so a keepalive
    // never fails a stream.
  }

  throw new SubscriptionError('Claude stream ended without message_stop', 'STREAM_CLOSED')
}

module.exports = { EMPTY_RESPONSE_CODE, mapStopReason, mapUsage, translate }
