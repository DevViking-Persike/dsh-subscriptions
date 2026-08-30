// The Responses image path: user images become data-URL input_image parts,
// tool-result images are flushed into a following user message, and every role
// or modality that cannot carry an image is refused before a request is sent.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SubscriptionError } = require('../dsh/errors.js')
const {
  contentHasImage, serializeRequestWithImages,
} = require('../dsh/codex/serialize.js')

const DATA_URL = `data:image/png;base64,${Buffer.from('pngbytes').toString('base64')}`

/** A fake attachment service handing back one fixed PNG. */
const attachments = {
  async readImage(ref) {
    if (ref?.id === 'missing') throw new SubscriptionError('attachment not found', 'INVALID_ATTACHMENT')
    if (ref?.id === 'tiff') return { data: Buffer.from('tiff'), ref: { mediaType: 'image/tiff' } }
    return { data: Buffer.from('pngbytes'), ref: { mediaType: ref?.mediaType ?? 'image/png' } }
  },
}

const image = attachment => ({ type: 'image', attachment })

test('a user image becomes an input_image part, order preserved', async () => {
  const body = await serializeRequestWithImages({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'look' },
      image({ id: 'a1' }),
      { type: 'text', text: 'carefully' },
    ] }],
  }, {}, attachments)
  assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: DATA_URL },
    { type: 'input_text', text: 'carefully' },
  ] }])
})

test('tool-result images are flushed into a following user message', async () => {
  const body = await serializeRequestWithImages({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [
        { type: 'text', text: 'shot:' },
        image({ id: 'a1' }),
      ] }] },
    ],
  }, {}, attachments)
  assert.deepEqual(body.input, [
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'shot:' },
    { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Attached image(s) from tool result:' },
      { type: 'input_image', image_url: DATA_URL },
    ] },
  ])
})

test('a tool result with only an image still names its output', async () => {
  const body = await serializeRequestWithImages({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [image({ id: 'a1' })] }] }],
  }, {}, attachments)
  assert.deepEqual(body.input, [
    { type: 'function_call_output', call_id: 'c1', output: '(see attached image)' },
    { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Attached image(s) from tool result:' },
      { type: 'input_image', image_url: DATA_URL },
    ] },
  ])
})

test('an image in an assistant message is refused', async () => {
  await assert.rejects(
    serializeRequestWithImages({
      model: 'm',
      messages: [{ role: 'assistant', content: [image({ id: 'a1' })] }],
    }, {}, attachments),
    /cannot represent image content in an assistant message/,
  )
})

test('an unsupported media type is refused', async () => {
  await assert.rejects(
    serializeRequestWithImages({
      model: 'm',
      messages: [{ role: 'user', content: [image({ id: 'tiff' })] }],
    }, {}, attachments),
    /unsupported image media type "image\/tiff"/,
  )
})

test('the attachment service refusal reaches the caller', async () => {
  await assert.rejects(
    serializeRequestWithImages({
      model: 'm',
      messages: [{ role: 'user', content: [image({ id: 'missing' })] }],
    }, {}, attachments),
    /attachment not found/,
  )
})

test('contentHasImage sees through tool results', () => {
  assert.equal(contentHasImage([{ type: 'tool-result', content: [image({ id: 'a1' })] }]), true)
  assert.equal(contentHasImage([{ type: 'text', text: 'x' }]), false)
})
