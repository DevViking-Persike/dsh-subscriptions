const { test } = require('node:test')
const assert = require('node:assert/strict')
const { serializeRequest, serializeRequestWithImages } = require('../dsh/codex/serialize.js')

for (const [name, serialize] of [
  ['text', options => serializeRequest(options)],
  ['image-capable', options => serializeRequestWithImages(options, {}, {
    readImage: async () => ({ ref: { mediaType: 'image/png' }, data: Buffer.from('image') }),
  })],
]) {
  test(`${name}: a failed child notice quotes its tool call without creating a parent call`, async () => {
    const quoted = { type: 'tool-call', id: 'child-call', name: 'run_code', arguments: '{"code":"doWork()"}' }
    const options = { model: 'gpt-5.6-sol', messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'parent-call', name: 'run_code', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'parent-call', content: [{ type: 'text', text: 'done' }] }] },
      { role: 'user', source: { kind: 'subagent-settled', form: 'notice' }, content: [
        { type: 'text', text: 'Background subagent failed. Its closing message:' }, quoted,
        ...name === 'image-capable' ? [{ type: 'image', attachment: { id: 'image-id', mediaType: 'image/png' } }] : [],
      ] },
    ] }
    const before = structuredClone(options)
    const body = await serialize(options)
    assert.deepEqual(options, before)
    assert.deepEqual(body.input.filter(x => x.type === 'function_call').map(x => x.call_id), ['parent-call'])
    assert.deepEqual(body.input.filter(x => x.type === 'function_call_output').map(x => x.call_id), ['parent-call'])
    const text = body.input.flatMap(x => x.content ?? []).filter(x => x.type === 'input_text').map(x => x.text).join('\n')
    assert.ok(text.includes('Quoted tool call (not a call by this assistant):\n' + JSON.stringify(quoted)))
    if (name === 'image-capable') assert.ok(body.input.some(x => x.content?.some(p => p.type === 'input_image')))
  })
}
