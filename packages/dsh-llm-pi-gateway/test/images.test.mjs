// 图片输入管线 BDD(官方 toPiContextWithImages 同构):user 角色图片经
// attachments 服务读出为 base64 块,非 user 角色拒绝,无 attachments 服务
// 拒绝,预算策略透传,纯文本路径不受影响;routed(0.1.7)形态断言必需卸载
// 上报与已标记块投影,transient(0.1.2–0.1.5)形态保持两段瞬时投影。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offloadedImageText, offloadRequestImagesWithPolicy } from '@deepseek-ai/dsh-llm'
import { imageOffloadAdapter } from '../src/image-offload.mjs'
import { toPiContext, toPiContextWithImages } from '../src/pi-context.mjs'

// 测试宿主为 devDep dsh-llm(0.1.5 闭包,transient 形态);
// routed 形态以 stub 注入(见 routedOffload)
const TRANSIENT_OFFLOAD = imageOffloadAdapter(
  { offloadRequestImagesWithPolicy },
  undefined,
)

const IMAGES_BASE = { offloadedText: offloadedImageText, offload: TRANSIENT_OFFLOAD }

// routed 形态 stub:官方 0.1.7 requiredImageOffload/projectOffloadedImages 语义
// (保留块按 versionBytes 从旧到新累计,超限即需卸载前缀数;已标记块投影占位)
function routedOffload({ requiredCount = 0 } = {}) {
  const retained = (messages) => messages.flatMap((message) => message.content)
    .filter((block) => block.type === 'image' && block.offloaded !== true)
  return {
    kind: 'routed',
    required: (messages, maxBytes) => (maxBytes === undefined ? 0 : requiredCount),
    requiredError: (maxBytes, count) => {
      const error = new Error(`pi-ai request images exceed the ${maxBytes}-byte base64 bound; ${count} more oldest occurrence(s) must be offloaded.`)
      error.code = 'IMAGE_OFFLOAD_REQUIRED'
      error.data = { offloadImages: count }
      return error
    },
    project: (messages, placeholder) => messages.map((message) => {
      const content = message.content.some?.((block) => block.type === 'image' && block.offloaded === true)
        ? message.content.map((block) => block.type === 'image' && block.offloaded === true
          ? { type: 'text', text: placeholder(block.attachment) }
          : block)
        : message.content
      return content === message.content ? message : { ...message, content }
    }),
    requestTarget: (ref, budget) => ({ width: 4, height: 4, maxBytes: budget.maxBytes }),
  }
}

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
    {
      attachments,
      resolveImageAccess: () => undefined,
      maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
      requestImagePolicy: DEFAULTS.policy,
      ...IMAGES_BASE,
    },
  )
  const message = context.messages[0]
  assert.equal(message.role, 'user')
  assert.ok(Array.isArray(message.content))
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, '看这张图')
  // 新 API 文本细节:官方 requestImageHandleText 由 "request image" 改为 "request preview"
  assert.match(message.content[1].text, /Image att-1; request preview 4x4px/)
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
    {
      attachments,
      resolveImageAccess: () => undefined,
      maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
      requestImagePolicy: DEFAULTS.policy,
      ...IMAGES_BASE,
    },
  )
  const imageBlocks = context.messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'image')
  assert.equal(imageBlocks.length, 2)
  assert.equal(attachments.asked.length, 2)
})

test('超预算图片被裁为占位文本:access 缺失提示重附,access 存在给出恢复路径', async () => {
  // 裁剪发生在 offload 阶段:预算压到单图字节以下即触发 placeholder 替换
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '图:' },
      { type: 'image', attachment: { attachmentId: 'att-big', name: '大图.png', mediaType: 'image/png', width: 8, height: 8, bytes: 999 } },
    ],
  }]
  const omitted = /image omitted to fit request image limits/
  const base = (resolveImageAccess) => ({
    attachments: attachmentService(new Map()),
    resolveImageAccess,
    maxRequestImageBytes: 1,
    requestImagePolicy: { maxPixels: 1, maxBytes: 1 },
    ...IMAGES_BASE,
  })
  const withoutAccess = await toPiContextWithImages({ messages }, base(() => undefined))
  assert.match(String(withoutAccess.messages[0].content), omitted)
  assert.match(String(withoutAccess.messages[0].content), /No local normalized image path is available/)
  const withAccess = await toPiContextWithImages(
    { messages },
    base(() => ({ readonlyPath: '/ro/big.png' })),
  )
  assert.match(String(withAccess.messages[0].content), omitted)
  assert.match(String(withAccess.messages[0].content), /\/ro\/big\.png/)
  assert.doesNotMatch(String(withAccess.messages[0].content), /No local normalized image path is available/)
})

test('非 user 角色历史图片拒绝 UNSUPPORTED_CONTENT', async () => {
  await assert.rejects(
    toPiContextWithImages(
      { messages: [{ role: 'assistant', content: [{ type: 'image', attachment: { attachmentId: 'att-x' } }] }] },
      {
        attachments: attachmentService(new Map()),
        resolveImageAccess: () => undefined,
        maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
        requestImagePolicy: DEFAULTS.policy,
        ...IMAGES_BASE,
      },
    ),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('纯文本请求走图片路径也不读 attachments', async () => {
  const attachments = attachmentService(new Map())
  const context = await toPiContextWithImages(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    {
      attachments,
      resolveImageAccess: () => undefined,
      maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
      requestImagePolicy: DEFAULTS.policy,
      ...IMAGES_BASE,
    },
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

function makeAdapter(profile, captured, resolveAttachments, offload = TRANSIENT_OFFLOAD) {
  const routes = new Map([['new-api', resolveRoute('new-api', profile)]])
  return createGatewayAdapter(routes, async () => fakeProtocol(captured), undefined, resolveAttachments, undefined, () => undefined, offloadedImageText, offload)
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

test('adapter 图片路径超预算裁剪:占位文本经注入的 offloadedText 进入协议 context', async () => {
  // 预算压到单图字节以下触发 placeholder,锁定 createGatewayAdapter 第 7 参接线:
  // 删掉该参数,占位闭包在请求路径上抛 TypeError,本用例即红
  const captured = []
  const attachments = attachmentService(new Map())
  const adapter = makeAdapter(
    { ...IMAGE_PROFILE, maxRequestImageBytes: 1, requestImageMaxBytes: 1, requestImagePixelBudget: 1 },
    captured,
    () => attachments,
  )
  const bigImage = {
    role: 'user',
    content: [
      { type: 'text', text: '图:' },
      { type: 'image', attachment: { attachmentId: 'att-big', name: '大图.png', mediaType: 'image/png', width: 8, height: 8, bytes: 999 } },
    ],
  }
  await collect(adapter.stream({ provider: 'new-api', model: 'auto', sessionId: 's', messages: [bigImage] }))
  assert.match(String(captured[0].context.messages[0].content), /image omitted to fit request image limits/)
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

// ---- routed 形态(0.1.7+):必需卸载上报 + 已标记块投影 + 目标尺寸契约 ----

test('routed 形态:超限上报 IMAGE_OFFLOAD_REQUIRED 且读出先行,不触发投影', async () => {
  let asked = 0
  const attachments = {
    async readImageRequest(ref, target) {
      asked += 1
      // 目标尺寸契约:target 为 {width, height, maxBytes}(requestImageTarget 同构)
      assert.equal(typeof target.width, 'number')
      assert.equal(typeof target.height, 'number')
      assert.equal(typeof target.maxBytes, 'number')
      return { attachment: ref, data: new Uint8Array([1]), mediaType: 'image/png', width: 4, height: 4, bytes: 1 }
    },
  }
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '图:' },
      { type: 'image', attachment: { attachmentId: 'att-big', mediaType: 'image/png', width: 8, height: 8, bytes: 999 } },
    ],
  }]
  await assert.rejects(
    toPiContextWithImages(
      { messages },
      {
        attachments,
        resolveImageAccess: () => undefined,
        maxRequestImageBytes: 1,
        requestImagePolicy: DEFAULTS.policy,
        offloadedText: offloadedImageText,
        offload: routedOffload({ requiredCount: 1 }),
      },
    ),
    (error) => error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.data?.offloadImages === 1,
  )
  // 官方同序:读出(为精确字节判定服务)先于必需卸载判定,投影不再执行
  assert.equal(asked, 1)
})

test('routed 形态:预算内保留块照常转 base64,已标记块投影占位文本', async () => {
  const attachments = attachmentService(new Map())
  const context = await toPiContextWithImages(
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'att-old', mediaType: 'image/png', width: 8, height: 8, bytes: 9 }, offloaded: true },
            { type: 'text', text: '看这张' },
            { type: 'image', attachment: { attachmentId: 'att-new', mediaType: 'image/png', width: 8, height: 8, bytes: 3 } },
          ],
        },
      ],
    },
    {
      attachments,
      resolveImageAccess: () => undefined,
      maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
      requestImagePolicy: DEFAULTS.policy,
      offloadedText: offloadedImageText,
      offload: routedOffload({ requiredCount: 0 }),
    },
  )
  // 已标记块:不读出(attachments.asked 只含保留块)、投影为占位文本
  assert.deepEqual(attachments.asked.map((entry) => entry.ref), ['att-new'])
  const content = context.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /image omitted to fit request image limits/)
  // [占位文本, '看这张', handle 文本, image 块] — handle+image 在索引 2/3
  assert.equal(content[3].type, 'image')
})

test('routed 形态:role:"tool" 词汇转 pi-ai toolResult(0.1.7 历史同构)', async () => {
  const attachments = attachmentService(new Map())
  const context = await toPiContextWithImages(
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: '读图', argumentsJson: '{}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
      ],
    },
    {
      attachments,
      resolveImageAccess: () => undefined,
      maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
      requestImagePolicy: DEFAULTS.policy,
      offloadedText: offloadedImageText,
      offload: routedOffload(),
    },
  )
  const result = context.messages[1]
  assert.equal(result.role, 'toolResult')
  assert.equal(result.toolCallId, 'c1')
  assert.equal(result.toolName, '读图')
  assert.equal(result.content[0].text, 'ok')
})

test('routed 形态:developer 角色与 tool-change 块拒绝(assertSupportedHistory 同构)', async () => {
  const images = {
    attachments: attachmentService(new Map()),
    resolveImageAccess: () => undefined,
    maxRequestImageBytes: DEFAULTS.maxRequestImageBytes,
    requestImagePolicy: DEFAULTS.policy,
    offloadedText: offloadedImageText,
    offload: routedOffload(),
  }
  await assert.rejects(
    toPiContextWithImages({ messages: [{ role: 'developer', content: [{ type: 'text', text: 'x' }] }] }, images),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
  await assert.rejects(
    toPiContextWithImages({ messages: [{ role: 'user', content: [{ type: 'tool-addition', tool: {} }] }] }, images),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
  // 0.1.7 词汇 tool 角色内的图片合法(结果内容)
  const context = await toPiContextWithImages(
    {
      messages: [
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'image', attachment: { attachmentId: 'att-t', mediaType: 'image/png', width: 8, height: 8, bytes: 3 } }],
        },
      ],
    },
    images,
  )
  assert.ok(Array.isArray(context.messages[0].content))
})

test('imageOffloadAdapter:形态选择与缺失回落', async () => {
  // routed 优先:三件套 + 常量 + requestImageDimensions 齐备
  const trio = {
    requiredImageOffload: () => 0,
    projectOffloadedImages: (m) => m,
    offloadedImageText,
    LlmError: class LlmError extends Error {},
    IMAGE_OFFLOAD_REQUIRED_CODE: 'IMAGE_OFFLOAD_REQUIRED',
  }
  const routed = imageOffloadAdapter(trio, { requestImageDimensions: () => ({}) })
  assert.equal(routed.kind, 'routed')
  // 三件套齐但缺 requestImageDimensions(宿主形态不一致的病态组合)→ null
  // 干净禁用:0.1.7 闭包必带 dsh-attachment,缺位即宿主面破损,禁用比带错契约运行诚实
  assert.equal(imageOffloadAdapter(trio, undefined), null)
  // 仅旧函数 → transient
  assert.equal(imageOffloadAdapter({ offloadRequestImagesWithPolicy }, undefined).kind, 'transient')
  // 双缺 → null(apply 干净禁用)
  assert.equal(imageOffloadAdapter({}, undefined), null)
})
