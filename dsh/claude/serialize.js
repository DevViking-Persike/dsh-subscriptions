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
const { assertReasoningEffort } = require('../reasoning.js')

/** The identity the subscription endpoint gates on. */
const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude."

/** Media types the base64 image source accepts. */
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

/** Refuse image content before a text-only path can erase it. */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new SubscriptionError(
      'This Claude subscription model does not accept image input.',
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
 * Resolve one durable image reference into its Anthropic wire part.
 *
 * @param {object} block - the harness image block.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the `image` content block.
 */
async function imagePart(block, attachments, signal) {
  let stored
  try {
    stored = await attachments.readImage(block.attachment, signal)
  } catch (error) {
    // The attachment service owns admission; its refusal is the accurate
    // message, and reporting it as a transport fault would send the operator
    // looking at the network.
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
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: Buffer.from(stored.data).toString('base64') },
  }
}

/**
 * Present Harness tool parameters as a JSON Schema object.
 *
 * Most Harness tools already carry a root `type: object`, but capability-only
 * tools may declare `{}` or use a bare property map whose `required` flag lives
 * on each property. Anthropic requires `input_schema.type` for every tool and
 * rejects the complete request at the first unwrapped entry.
 *
 * A value already carrying `type` is a real schema and passes through. A value
 * carrying `properties` but no type receives only the required root type.
 *
 * @param {object|undefined} parameters - declared tool parameters.
 * @returns {object} a JSON Schema object.
 */
function toJsonSchema(parameters) {
  if (parameters === undefined || parameters === null) return { type: 'object', properties: {} }
  if (typeof parameters !== 'object' || Array.isArray(parameters)) return { type: 'object', properties: {} }
  if (Object.hasOwn(parameters, 'type')) return parameters
  if (Object.hasOwn(parameters, 'properties')) return { type: 'object', ...parameters }

  const properties = {}
  const required = []
  for (const [name, declared] of Object.entries(parameters)) {
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) continue
    const { required: isRequired, ...schema } = declared
    properties[name] = schema
    if (isRequired === true) required.push(name)
  }
  return { type: 'object', properties, ...required.length === 0 ? {} : { required } }
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
 * Assemble the `/v1/messages` body around already-serialized wire messages.
 *
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @param {object[]} wireMessages - the serialized conversation.
 * @returns {object} the request body.
 */
function assembleRequest(options, defaults, wireMessages) {
  assertReasoningEffort('claude', options.model, options.reasoningEffort)
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
    messages: wireMessages,
    stream: true,
    ...options.reasoningEffort === undefined ? {} : { output_config: { effort: options.reasoningEffort } },
    ...options.tools !== undefined && options.tools.length > 0
      ? {
        tools: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: toJsonSchema(tool.parameters),
        })),
      }
      : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
  }
}

/**
 * Serialize one complete streaming request.
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @returns {object} the `/v1/messages` body.
 */
function serializeRequest(options, defaults) {
  return assembleRequest(options, defaults, serializeMessages(options.messages))
}

/**
 * Serialize one user message with image resolution.
 *
 * Order is preserved because it carries meaning: text before an image reads as
 * an instruction about it, and text after reads as a follow-up. A tool result
 * keeps its images inside its own content array, which this protocol accepts
 * natively — unlike the Codex route, which has to flush them into a following
 * user message.
 *
 * @param {object} message - the harness user message.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the wire message.
 */
async function serializeUserWithImages(message, attachments, signal) {
  const blocks = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push(await imagePart(block, attachments, signal))
    } else if (block.type === 'tool-result') {
      const parts = []
      for (const inner of Array.isArray(block.content) ? block.content : []) {
        if (inner.type === 'text' && inner.text.length > 0) parts.push({ type: 'text', text: inner.text })
        else if (inner.type === 'image') parts.push(await imagePart(inner, attachments, signal))
      }
      blocks.push({
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        // Empty tool output still needs content on the wire.
        content: parts.length === 0 ? '(no output)' : parts,
      })
    }
  }
  return { role: 'user', content: blocks }
}

/**
 * Serialize the conversation with image resolution.
 *
 * @param {readonly object[]} messages - the harness conversation, in order.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object[]>} the wire messages.
 */
async function serializeMessagesWithImages(messages, attachments, signal) {
  assertImageRoles(messages)
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') continue
    wire.push(message.role === 'assistant'
      ? serializeAssistant(message)
      : await serializeUserWithImages(message, attachments, signal))
  }
  return wire
}

/**
 * Serialize one complete streaming request with image resolution.
 *
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the `/v1/messages` body.
 */
async function serializeRequestWithImages(options, defaults, attachments, signal) {
  const messages = await serializeMessagesWithImages(options.messages, attachments, signal)
  return assembleRequest(options, defaults, messages)
}

module.exports = {
  CLAUDE_CODE_PREAMBLE,
  SUPPORTED_MEDIA_TYPES,
  contentHasImage,
  serializeMessages,
  serializeMessagesWithImages,
  serializeRequest,
  serializeRequestWithImages,
  toJsonSchema,
}
