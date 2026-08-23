// Harness messages to OpenAI Responses requests.
//
// The Responses API is not chat-completions: the system prompt is a top-level
// `instructions` string, and the conversation is a flat `input` array where a
// tool call and its result are siblings of the messages rather than nested
// inside them.
//
// `store: false` and `include: ['reasoning.encrypted_content']` are not
// options: the first keeps the subscription from retaining conversations
// server-side, and the second is what lets a reasoning model carry its own
// thinking across turns.

const { SubscriptionError } = require('../errors.js')

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
      'The Codex subscription adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Map a harness reasoning effort onto the wire vocabulary. */
function wireEffort(effort) {
  return effort === 'off' ? 'minimal' : effort
}

/**
 * Split the conversation into top-level instructions and the input array.
 *
 * @param {readonly object[]} messages - the harness conversation, in order.
 * @param {string|undefined} system - the explicit system prompt.
 * @returns {{instructions: string|undefined, input: object[]}}
 */
function serializeConversation(messages, system) {
  const instructionParts = [
    ...messages.filter(message => message.role === 'system').map(message => flattenText(message.content)),
    ...system === undefined ? [] : [system],
  ]
  const input = []
  for (const message of messages) {
    if (message.role === 'system') continue
    for (const block of message.content) {
      assertTextOnly([block])
      if (block.type === 'text') {
        input.push({
          type: 'message',
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: [{
            // The content type differs by direction on this protocol.
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: block.text,
          }],
        })
      } else if (block.type === 'tool-call') {
        // Arguments stay a raw JSON string here, unlike the Anthropic route
        // which wants them parsed.
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
      } else if (block.type === 'tool-result') {
        input.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          // Empty tool output still needs content on the wire.
          output: flattenText(block.content) || '(no output)',
        })
      }
      // Reasoning is dropped; the wire carries its own encrypted content.
    }
  }
  return {
    instructions: instructionParts.length === 0 ? undefined : instructionParts.join('\n\n'),
    input,
  }
}

/**
 * Serialize one complete streaming request.
 * @param {object} options - the harness generation request.
 * @param {{serviceTier?: string}} defaults - adapter-level defaults.
 * @returns {object} the `/codex/responses` body.
 */
function serializeRequest(options, defaults = {}) {
  if (options.stop !== undefined) {
    // Refused rather than dropped: silently ignoring a stop sequence would let
    // a model run past a boundary the caller relied on.
    throw new SubscriptionError('The Codex Responses API does not support stop sequences.', 'UNSUPPORTED')
  }
  const { instructions, input } = serializeConversation(options.messages, options.system)
  return {
    model: options.model,
    ...instructions === undefined ? {} : { instructions },
    input,
    stream: true,
    ...options.tools !== undefined && options.tools.length > 0
      ? {
        tools: options.tools.map(tool => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        tool_choice: 'auto',
        parallel_tool_calls: false,
      }
      : {},
    ...options.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: wireEffort(options.reasoningEffort), summary: 'auto' } },
    ...defaults.serviceTier === undefined ? {} : { service_tier: defaults.serviceTier },
    store: false,
    include: ['reasoning.encrypted_content'],
  }
}

module.exports = { serializeConversation, serializeRequest, wireEffort }
