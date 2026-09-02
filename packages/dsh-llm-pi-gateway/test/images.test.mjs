// 图片输入管线 BDD(官方 toPiContextWithImages 同构):user 角色图片经
// attachments 服务读出为 base64 块,非 user 角色拒绝,无 attachments 服务
// 拒绝,预算策略透传,纯文本路径不受影响。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toPiContext, toPiContextWithImages } from '../src/pi-context.mjs'

function attachmentService(versions) {
  const asked = []
  return {
    asked,
    async readImageRequest(ref, policy, signal) {
      asked.push({ ref: ref.attachmentId, policy })
      const version = versions.get(ref.attachmentId)
        ?? { attachment: ref, data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 4, height: 4, bytes: 3 }
      return version
    },
  }
}

function imageMessage(attachmentId = 'att-1') {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: { attachmentId, bytes: 3 } },
    ],
  }
}

const DEFAULTS = { maxRequestImageBytes: undefined, policy: { maxPixels: 4194304, maxBytes: 1048576 } }

test('user 消息图片转为 pi-ai image 块(附 handle 文本),纯文本归并为字符串', async () => {
  const attachments = attachmentService(new Map())
  const context = await toPiContextWithImages(
    { messages: [imageMessage()] },
    attachments,
    undefined,
    DEFAULTS.maxRequestImageBytes,
    DEFAULTS.policy,
  )
  const message = context.messages[0]
  assert.equal(message.role, 'user')
  assert.ok(Array.isArray(message.content))
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, '看这张图')
  assert.match(message.content[1].text, /Image att-1; request image 4x4px/)
  assert.equal(message.content[2].type, 'image')
  assert.equal(message.content[2].mimeType, 'image/png')
  assert.equal(message.content[2].data, Buffer.from([1, 2, 3]).toString('base64'))
  assert.equal(attachments.asked.length, 1)
})

test('多图与嵌套 tool-result 图片全部展开', async () => {
  const attachments = attachmentService(new Map())
  const context = await toPiContextWithImages(
    {
      messages: [
        imageMessage('att-a'),
        { role: 'user', content: [{ type: 'text', text: '结果:' }] },
        {
          role: 'user',
          content: [
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: { attachmentId: 'att-b', bytes: 3 } }] },
          ],
        },
      ],
    },
    attachments,
    undefined,
    DEFAULTS.maxRequestImageBytes,
    DEFAULTS.policy,
  )
  const imageBlocks = context.messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'image')
  assert.equal(imageBlocks.length, 2)
  assert.equal(attachments.asked.length, 2)
})

test('非 user 角色历史图片拒绝 UNSUPPORTED_CONTENT', async () => {
  await assert.rejects(
    toPiContextWithImages(
      { messages: [{ role: 'assistant', content: [{ type: 'image', attachment: { attachmentId: 'att-x' } }] }] },
      attachmentService(new Map()),
      undefined,
      DEFAULTS.maxRequestImageBytes,
      DEFAULTS.policy,
    ),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('纯文本请求走图片路径也不读 attachments', async () => {
  const attachments = attachmentService(new Map())
  const context = await toPiContextWithImages(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    attachments,
    undefined,
    DEFAULTS.maxRequestImageBytes,
    DEFAULTS.policy,
  )
  assert.equal(context.messages[0].content, 'hi')
  assert.equal(attachments.asked.length, 0)
})

test('文本路径遇图片报 UNSUPPORTED_CONTENT(官方文本路径同语义)', () => {
  assert.throws(
    () => toPiContext({ messages: [imageMessage()] }),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})

// ---- adapter 门禁:模型能力 / attachments 服务缺失 / 分支接线 ----

import { resolveRoute } from '../src/config.mjs'
import { createGatewayAdapter } from '../src/adapter.mjs'

function fakeProtocol(captured) {
  return {
    streamSimple: async function * (model, context, options) {
      captured.push({ model, context, options })
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: 0,
        },
      }
    },
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function makeAdapter(profile, captured, resolveAttachments) {
  const routes = new Map([['new-api', resolveRoute('new-api', profile)]])
  return createGatewayAdapter(routes, async () => fakeProtocol(captured), undefined, resolveAttachments)
}

const IMAGE_PROFILE = {
  api: 'anthropic-messages',
  baseURL: 'https://gw.example.com',
  models: [{ id: 'auto', contextWindow: 200000, input: ['text', 'image'] }],
}

test('模型声明 image 输入且有 attachments 服务:请求走图片路径', async () => {
  const captured = []
  const attachments = attachmentService(new Map())
  const adapter = makeAdapter(IMAGE_PROFILE, captured, () => attachments)
  await collect(adapter.stream({
    provider: 'new-api',
    model: 'auto',
    sessionId: 's',
    messages: [imageMessage()],
  }))
  const content = captured[0].context.messages[0].content
  assert.ok(Array.isArray(content))
  assert.equal(content[2].type, 'image')
})

test('模型未声明 image 输入:UNSUPPORTED_CONTENT,不触 attachments', async () => {
  const captured = []
  let asked = false
  const adapter = makeAdapter(
    { ...IMAGE_PROFILE, models: [{ id: 'auto', contextWindow: 200000 }] },
    captured,
    () => { asked = true; return attachmentService(new Map()) },
  )
  await assert.rejects(
    collect(adapter.stream({ provider: 'new-api', model: 'auto', sessionId: 's', messages: [imageMessage()] })),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
  assert.equal(asked, false)
})

test('无 attachments 服务:UNSUPPORTED_CONTENT(官方同语义)', async () => {
  const adapter = makeAdapter(IMAGE_PROFILE, [], () => undefined)
  await assert.rejects(
    collect(adapter.stream({ provider: 'new-api', model: 'auto', sessionId: 's', messages: [imageMessage()] })),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('无图片请求不读 attachments 服务', async () => {
  const captured = []
  let asked = false
  const adapter = makeAdapter(IMAGE_PROFILE, captured, () => { asked = true; return undefined })
  await collect(adapter.stream({
    provider: 'new-api',
    model: 'auto',
    sessionId: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(asked, false)
  assert.equal(captured[0].context.messages[0].content, 'hi')
})
