// The Anthropic image path: attachment references resolve into base64 image
// sources, tool results keep their images inline, and every role or modality
// that cannot carry an image is refused before a request is sent.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SubscriptionError } = require('../dsh/errors.js')
const {
  contentHasImage, serializeRequestWithImages, serializeRequest,
} = require('../dsh/claude/serialize.js')

/** A fake attachment service handing back one fixed PNG. */
const attachments = {
  async readImage(ref) {
    if (ref?.id === 'missing') throw new SubscriptionError('attachment not found', 'INVALID_ATTACHMENT')
    if (ref?.id === 'tiff') return { data: Buffer.from('tiff'), ref: { mediaType: 'image/tiff' } }
    return { data: Buffer.from('pngbytes'), ref: { mediaType: ref?.mediaType ?? 'image/png' } }
  },
}

const image = attachment => ({ type: 'image', attachment })

test('a user image becomes a base64 image source, order preserved', async () => {
  const body = await serializeRequestWithImages({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'look' },
      image({ id: 'a1' }),
      { type: 'text', text: 'carefully' },
    ] }],
  }, { maxTokens: 16 }, attachments)
  assert.deepEqual(body.messages, [{ role: 'user', content: [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('pngbytes').toString('base64') } },
    { type: 'text', text: 'carefully' },
  ] }])
})

test('a tool result keeps its images inside its content array', async () => {
  const body = await serializeRequestWithImages({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [
        { type: 'text', text: 'shot:' },
        image({ id: 'a1' }),
      ] }] },
    ],
  }, { maxTokens: 16 }, attachments)
  assert.deepEqual(body.messages, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: [
        { type: 'text', text: 'shot:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('pngbytes').toString('base64') } },
      ] },
    ] },
  ])
})

test('an empty tool result still carries content', async () => {
  const body = await serializeRequestWithImages({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] }],
  }, { maxTokens: 16 }, attachments)
  assert.equal(body.messages[0].content[0].content, '(no output)')
})

test('an image in an assistant message is refused', async () => {
  await assert.rejects(
    serializeRequestWithImages({
      model: 'm',
      messages: [{ role: 'assistant', content: [image({ id: 'a1' })] }],
    }, { maxTokens: 16 }, attachments),
    /cannot represent image content in an assistant message/,
  )
})

test('an unsupported media type is refused', async () => {
  await assert.rejects(
    serializeRequestWithImages({
      model: 'm',
      messages: [{ role: 'user', content: [image({ id: 'tiff' })] }],
    }, { maxTokens: 16 }, attachments),
    /unsupported image media type "image\/tiff"/,
  )
})

test('the attachment service refusal reaches the caller', async () => {
  await assert.rejects(
    serializeRequestWithImages({
      model: 'm',
      messages: [{ role: 'user', content: [image({ id: 'missing' })] }],
    }, { maxTokens: 16 }, attachments),
    /attachment not found/,
  )
})

test('the text-only path still refuses images by model', () => {
  assert.throws(
    () => serializeRequest({
      model: 'm',
      messages: [{ role: 'user', content: [image({ id: 'a1' })] }],
    }, { maxTokens: 16 }),
    /does not accept image input/,
  )
})

test('contentHasImage sees through tool results', () => {
  assert.equal(contentHasImage([{ type: 'tool-result', content: [image({ id: 'a1' })] }]), true)
  assert.equal(contentHasImage([{ type: 'text', text: 'x' }]), false)
})
