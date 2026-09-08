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

/** Media types the data-URL image part accepts. */
const SUPPORTED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

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

/** Preserve a received tool-call block as quoted context, not an assistant action. */
function quotedToolCall(block) {
  return { type: 'input_text', text: `Quoted tool call (not a call by this assistant):\n${JSON.stringify(block)}` }
}

/** Refuse image content before a text-only path can erase it. */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new SubscriptionError(
      'This Codex subscription model does not accept image input.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * Refuse an image in a role whose wire format cannot carry one.
 *
 * Assistant history cannot carry images on this protocol, and an image there
 * stays in the durable log, so every later turn would refuse it again.
 *
 * @param {readonly object[]} messages - the harness conversation.
 */
function assertImageRoles(messages) {
  for (const message of messages) {
    if (message.role === 'assistant' && contentHasImage(message.content)) {
      throw new SubscriptionError(
        'This adapter cannot represent image content in an assistant message.',
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/**
 * Resolve one durable image reference into its Responses wire part.
 *
 * @param {object} block - the harness image block.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the `input_image` content part.
 */
async function imagePart(block, attachments, signal) {
  let stored
  try {
    stored = await attachments.readImage(block.attachment, signal)
  } catch (error) {
    throw new SubscriptionError(
      error?.message ?? 'the attachment could not be read',
      error?.code ?? 'UNSUPPORTED_CONTENT',
      { cause: error },
    )
  }
  const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    throw new SubscriptionError(
      `unsupported image media type "${String(mediaType)}"`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return {
    type: 'input_image',
    image_url: `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
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
      if (block.type === 'tool-call' && message.role !== 'assistant') {
        input.push({ type: 'message', role: 'user', content: [quotedToolCall(block)] })
        continue
      }
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
 * Serialize the conversation with image resolution.
 *
 * A tool result's `output` field is a string on this protocol, so its images
 * cannot ride inside it: they are flushed into a following user message —
 * emitted before anything that is not another tool result — so the model still
 * sees them in order.
 *
 * @param {readonly object[]} messages - the harness conversation, in order.
 * @param {string|undefined} system - the explicit system prompt.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<{instructions: string|undefined, input: object[]}>}
 */
async function serializeConversationWithImages(messages, system, attachments, signal) {
  assertImageRoles(messages)
  const instructionParts = [
    ...messages.filter(message => message.role === 'system').map(message => flattenText(message.content)),
    ...system === undefined ? [] : [system],
  ]
  const input = []
  const pendingToolImages = []

  /** Flush tool-result images before anything that is not another tool result. */
  const flushToolImages = async () => {
    if (pendingToolImages.length === 0) return
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Attached image(s) from tool result:' }, ...pendingToolImages],
    })
    pendingToolImages.length = 0
  }

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      await flushToolImages()
      for (const block of message.content) {
        assertTextOnly([block])
        if (block.type === 'text') {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text }],
          })
        } else if (block.type === 'tool-call') {
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
        }
      }
      continue
    }
    // A user message: text and images as ordered parts of one message.
    const parts = []
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const ownBlocks = message.content.filter(block => block.type !== 'tool-result')
    for (const block of ownBlocks) {
      if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
      else if (block.type === 'tool-call') parts.push(quotedToolCall(block))
      else if (block.type === 'image') parts.push(await imagePart(block, attachments, signal))
    }
    if (parts.length > 0 || toolResults.length === 0) {
      await flushToolImages()
      input.push({ type: 'message', role: 'user', content: parts })
    }
    for (const result of toolResults) {
      const text = flattenText(result.content)
      const images = []
      for (const inner of Array.isArray(result.content) ? result.content : []) {
        if (inner.type === 'image') images.push(await imagePart(inner, attachments, signal))
      }
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: text || (images.length > 0 ? '(see attached image)' : '(no output)'),
      })
      pendingToolImages.push(...images)
    }
  }
  await flushToolImages()
  return {
    instructions: instructionParts.length === 0 ? undefined : instructionParts.join('\n\n'),
    input,
  }
}

/**
 * Assemble the `/codex/responses` body around serialized conversation fields.
 *
 * @param {object} options - the harness generation request.
 * @param {{serviceTier?: string}} defaults - adapter-level defaults.
 * @param {{instructions: string|undefined, input: object[]}} conversation -
 *   the serialized conversation.
 * @returns {object} the request body.
 */
function assembleRequest(options, defaults, { instructions, input }) {
  require('../reasoning.js').assertReasoningEffort('codex', options.model, options.reasoningEffort)
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
  return assembleRequest(options, defaults, serializeConversation(options.messages, options.system))
}

/**
 * Serialize one complete streaming request with image resolution.
 *
 * @param {object} options - the harness generation request.
 * @param {{serviceTier?: string}} defaults - adapter-level defaults.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the `/codex/responses` body.
 */
async function serializeRequestWithImages(options, defaults, attachments, signal) {
  if (options.stop !== undefined) {
    throw new SubscriptionError('The Codex Responses API does not support stop sequences.', 'UNSUPPORTED')
  }
  const conversation = await serializeConversationWithImages(options.messages, options.system, attachments, signal)
  return assembleRequest(options, defaults, conversation)
}

module.exports = {
  SUPPORTED_MEDIA_TYPES,
  contentHasImage,
  serializeConversation,
  serializeConversationWithImages,
  serializeRequest,
  serializeRequestWithImages,
  wireEffort,
}
