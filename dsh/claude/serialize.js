// Harness messages to Anthropic `/v1/messages` requests.
//
// Three protocol facts here are load-bearing and none of them is obvious:
//
//   - The Claude Code preamble must occupy its OWN system block. The
//     subscription backend classifies OAuth traffic by it and answers
//     `rate_limit_error` without it — even on models the subscription serves.
//     Concatenating it with the caller's prompt into one string is refused the
//     same way.
//   - Tool-call arguments are raw JSON strings end to end in the harness, but
//     the wire wants a parsed object, and an empty string must become `{}`.
//   - Reasoning blocks are dropped rather than replayed. Anthropic accepts
//     only its own signed thinking blocks; an unsigned substitute is rejected.

const { SubscriptionError } = require('../errors.js')

/** The identity the subscription endpoint gates on. */
const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * Whether any block carries an image, including inside a tool result.
 * @param {readonly object[]} blocks - content blocks.
 * @returns {boolean}
 */
function contentHasImage(blocks) {
  return blocks.some(block => block.type === 'image'
    || (block.type === 'tool-result' && Array.isArray(block.content) && contentHasImage(block.content)))
}

/** Join the text blocks of a message. */
function flattenText(blocks) {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Refuse image content before a text-only path can erase it. */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new SubscriptionError(
      'The Claude subscription adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Serialize one assistant message: text and tool calls. */
function serializeAssistant(message) {
  const blocks = []
  for (const block of message.content) {
    assertTextOnly([block])
    if (block.type === 'text' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      let input
      try {
        input = block.arguments.length === 0 ? {} : JSON.parse(block.arguments)
      } catch (error) {
        throw new SubscriptionError(
          `tool call ${block.name} carries arguments that are not valid JSON`,
          'INVALID_REQUEST',
          { cause: error },
        )
      }
      blocks.push({ type: 'tool_use', id: block.id, name: block.name, input })
    }
    // Reasoning is dropped; see the module note.
  }
  return { role: 'assistant', content: blocks }
}

/** Serialize one user message: text and tool results. */
function serializeUser(message) {
  const blocks = []
  let text = ''
  for (const block of message.content) {
    assertTextOnly([block])
    if (block.type === 'text') {
      text += block.text
    } else if (block.type === 'tool-result') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        // Empty tool output still needs content on the wire.
        content: flattenText(block.content) || '(no output)',
      })
    }
  }
  if (text.length > 0) blocks.unshift({ type: 'text', text })
  return { role: 'user', content: blocks }
}

/**
 * Serialize the conversation.
 *
 * System-role messages are not emitted here: Anthropic carries them in the
 * top-level `system` slot instead.
 *
 * @param {readonly object[]} messages - the harness conversation, in order.
 * @returns {object[]} the wire messages.
 */
function serializeMessages(messages) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') continue
    wire.push(message.role === 'assistant' ? serializeAssistant(message) : serializeUser(message))
  }
  return wire
}

/**
 * Serialize one complete streaming request.
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @returns {object} the `/v1/messages` body.
 */
function serializeRequest(options, defaults) {
  const caller = [
    ...options.messages.filter(message => message.role === 'system').map(message => flattenText(message.content)),
    ...options.system === undefined ? [] : [options.system],
  ].join('\n\n')
  const system = [
    { type: 'text', text: CLAUDE_CODE_PREAMBLE },
    ...caller.length > 0 ? [{ type: 'text', text: caller }] : [],
  ]
  const maxTokens = options.maxTokens ?? defaults.maxTokens
  if (maxTokens === undefined) {
    throw new SubscriptionError('Claude requires a max_tokens value; none was configured.', 'INVALID_REQUEST')
  }
  return {
    model: options.model,
    max_tokens: maxTokens,
    system,
    messages: serializeMessages(options.messages),
    stream: true,
    ...options.tools !== undefined && options.tools.length > 0
      ? {
        tools: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      }
      : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
  }
}

module.exports = { CLAUDE_CODE_PREAMBLE, serializeMessages, serializeRequest }
