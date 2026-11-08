// 列表瘦身的契约:只裁白名单、命中缓存不重建、增删事件失效、任何异常回落到原行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installListSlim, slimItem } from '../src/list-slim.mjs'

/** 一条带完整投影的列表项。 */
const item = (id, values) => ({ sessionId: id, updatedAt: 1, projections: { kind: 'cached', asOfSeq: 1, values } })

/** 造一个只实现本模块用到表面的上下文(inject 立即回调,等价于服务已就绪)。 */
function makeContext(list, { withController = true } = {}) {
  const handlers = new Map()
  const disposers = []
  const controller = withController ? { list } : undefined
  const ctx = {
    get: (name) => (name === 'sessionController' ? controller : undefined),
    on: (event, handler) => handlers.set(event, handler),
    logger: { info() {}, warn() {} },
    inject: (deps, callback) => {
      callback({
        sessionController: controller,
        on: (event, handler) => handlers.set(event, handler),
        effect: (factory) => {
          disposers.push(factory())
        },
      })
    },
  }
  return { ctx, controller, handlers, disposers }
}

const sample = () => [
  item('a', { title: 'A', sessionListMetadata: { blank: false }, contextHeaders: [{ pad: 'x'.repeat(64) }] }),
  item('b', { title: 'B', inbox: { 'next-turn': [], 'next-step': [] } }),
]

test('裁剪只保留白名单里的投影', () => {
  const slim = slimItem(sample()[0], ['title'])
  assert.deepEqual(Object.keys(slim.projections.values), ['title'])
  assert.equal(slim.projections.kind, 'cached')
  assert.equal(slim.sessionId, 'a')
})

test('形状不符的条目原样返回', () => {
  const bare = { sessionId: 'c' }
  assert.equal(slimItem(bare, ['title']), bare)
  assert.equal(slimItem({ projections: { values: null } }, ['title']).projections.values, null)
  const array = { projections: { values: ['x'] } }
  assert.equal(slimItem(array, ['title']), array)
})

test('开关关闭时不接管 controller.list', async () => {
  const original = async () => ({ items: sample() })
  const { ctx, controller } = makeContext(original)
  assert.equal(installListSlim(ctx, { enabled: false }), false)
  assert.equal(controller.list, original)
})

test('宿主没有 sessionController 时不接管任何方法', () => {
  const { ctx } = makeContext(undefined, { withController: false })
  installListSlim(ctx)
  assert.equal(ctx.get('sessionController'), undefined)
})

test('controller 缺 list 方法时静默放弃', () => {
  const { ctx, controller } = makeContext(undefined)
  installListSlim(ctx)
  assert.equal(controller.list, undefined)
})

test('第二次调用命中缓存,不重建', async () => {
  let built = 0
  const { ctx, controller } = makeContext(async () => {
    built += 1
    return { items: sample() }
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  await controller.list({}, undefined)
  const value = await controller.list({}, undefined)
  assert.equal(built, 1)
  assert.equal(value.items[0].projections.values.contextHeaders, undefined)
})

test('过期后重建', async () => {
  let built = 0
  const { ctx, controller } = makeContext(async () => {
    built += 1
    return { items: sample() }
  })
  installListSlim(ctx, { ttlMs: 0, warmupDelayMs: -1 })
  await controller.list({}, undefined)
  await controller.list({}, undefined)
  assert.equal(built, 2)
})

test('会话增删让缓存失效', async () => {
  let built = 0
  const { ctx, controller, handlers } = makeContext(async () => {
    built += 1
    return { items: sample() }
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  await controller.list({}, undefined)
  handlers.get('api-session/added')()
  await controller.list({}, undefined)
  assert.equal(built, 2)
  handlers.get('api-session/removed')()
  await controller.list({}, undefined)
  assert.equal(built, 3)
})

test('并发请求只触发一次重建', async () => {
  let built = 0
  const { ctx, controller } = makeContext(async () => {
    built += 1
    return { items: sample() }
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  await Promise.all([controller.list({}, undefined), controller.list({}, undefined), controller.list({}, undefined)])
  assert.equal(built, 1)
})

test('原方法抛错时错误照旧透传给调用方', async () => {
  const { ctx, controller } = makeContext(async () => {
    throw new Error('宿主故障')
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  await assert.rejects(() => controller.list({}, undefined), /宿主故障/)
})

test('响应形状不符时原样透传,不缓存', async () => {
  let built = 0
  const { ctx, controller } = makeContext(async () => {
    built += 1
    return { sessions: sample() }
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  const first = await controller.list({}, undefined)
  const second = await controller.list({}, undefined)
  assert.deepEqual(Object.keys(first), ['sessions'])
  assert.equal(built, 2)
  assert.notEqual(second, first)
})

test('把调用方 request 原样交给原方法', async () => {
  const seen = []
  const { ctx, controller } = makeContext(async (request) => {
    seen.push(request)
    return { items: sample() }
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  const request = { cursor: 'abc' }
  await controller.list(request, undefined)
  assert.equal(seen[0], request)
})

test('预热在延迟后构建一次', async () => {
  let built = 0
  const { ctx } = makeContext(async () => {
    built += 1
    return { items: sample() }
  })
  installListSlim(ctx, { warmupDelayMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(built, 1)
})

test('卸载时恢复原方法', async () => {
  const original = async () => ({ items: sample() })
  const { ctx, controller, disposers } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  assert.notEqual(controller.list, original)
  for (const dispose of disposers) dispose()
  assert.equal(controller.list, original)
})
