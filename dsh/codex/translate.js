// OpenAI Responses events to harness stream chunks.
//
// This is a third protocol, and its usage convention is the OPPOSITE of the
// Claude route in this same package: here `input_tokens` INCLUDES cache reads,
// so they are subtracted, while Anthropic reports them already excluded.
// Getting this backwards raises nothing — it just misreports context in every
// cost display — so both rules are pinned by tests recorded from the harness.
//
// Blocks are keyed by the wire's `output_index` but numbered by our own
// monotonic index: the wire may reuse or skip output indices, and the harness
// assembler expects a dense sequence.

const { SubscriptionError } = require('../errors.js')

/** Code the harness treats as retryable when a model completes with no content. */
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * Map Responses usage onto harness counts.
 *
 * `input_tokens` includes cache reads on this protocol, so they come out to
 * keep the counts disjoint.
 *
 * @param {object} usage - wire usage.
 * @returns {object} the harness counts.
 */
function mapUsage(usage) {
  const cacheRead = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.input_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * Resolve the finish reason and usage from a terminal event.
 *
 * The Responses API reports neither a stop reason nor a tool-call signal, so
 * the reason is derived: a response that opened a tool call finished for one.
 *
 * @param {object} event - the terminal wire event.
 * @param {readonly object[]} order - blocks opened during the response.
 * @returns {{reason: object, usage: object|undefined}}
 */
function mapTerminal(event, order) {
  if (event.type === 'response.failed') {
    const failure = event.response?.error
    return {
      reason: {
        kind: 'error',
        failure: {
          message: failure?.message ?? 'model response failed',
          code: failure?.code ?? 'RESPONSE_FAILED',
        },
      },
      usage: undefined,
    }
  }
  const wireUsage = event.response?.usage
  const usage = wireUsage === undefined ? undefined : mapUsage(wireUsage)
  if (event.type === 'response.incomplete') return { reason: { kind: 'max-tokens' }, usage }
  return {
    reason: order.some(block => block.kind === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' },
    usage,
  }
}

/** Close one open block into the content block a `block-end` carries. */
function closeBlock(block) {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text }
}

/**
 * Translate Responses events into harness stream chunks.
 *
 * @param {AsyncIterable<object>} events - decoded SSE events.
 * @returns {AsyncGenerator<object>} harness stream chunks.
 */
async function* translate(events) {
  const byOutputIndex = new Map()
  const order = []
  let nextIndex = 0

  for await (const event of events) {
    if (event.type === 'response.output_item.added') {
      const wire = event.item ?? {}
      const kind = wire.type === 'reasoning' ? 'reasoning' : wire.type === 'function_call' ? 'tool-call' : 'text'
      const block = {
        index: nextIndex++,
        kind,
        text: '',
        ...wire.call_id === undefined ? {} : { callId: wire.call_id },
        ...wire.name === undefined ? {} : { name: wire.name },
      }
      byOutputIndex.set(event.output_index, block)
      order.push(block)
      yield { type: 'block-start', index: block.index, blockType: kind }
      continue
    }
    if (event.type === 'response.output_text.delta') {
      const block = byOutputIndex.get(event.output_index)
      // A delta whose block was never opened, or whose kind disagrees, is
      // dropped rather than raised: the wire interleaves item kinds and
      // refusing the whole stream over one stray delta would be worse.
      if (block === undefined || block.kind !== 'text') continue
      block.text += event.delta
      yield { type: 'text-delta', index: block.index, text: event.delta }
      continue
    }
    if (event.type === 'response.reasoning_summary_text.delta') {
      const block = byOutputIndex.get(event.output_index)
      if (block === undefined || block.kind !== 'reasoning') continue
      block.text += event.delta
      yield { type: 'reasoning-delta', index: block.index, text: event.delta }
      continue
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const block = byOutputIndex.get(event.output_index)
      if (block === undefined || block.kind !== 'tool-call') continue
      block.text += event.delta
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: block.callId ?? '',
        ...block.name === undefined ? {} : { name: block.name },
        // `argumentsDelta` on the delta, `arguments` on the closed block.
        argumentsDelta: event.delta,
      }
      continue
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
      const terminal = mapTerminal(event, order)
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (terminal.usage !== undefined) yield { type: 'usage', usage: terminal.usage }
      yield {
        type: 'finish',
        reason: terminal.reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : terminal.reason,
      }
      return
    }
    // Every other event — created, in_progress, output_item.done, and any
    // future addition — is ignored rather than refused.
  }

  throw new SubscriptionError('Codex stream ended without a terminal event', 'STREAM_CLOSED')
}

module.exports = { EMPTY_RESPONSE_CODE, mapTerminal, mapUsage, translate }
