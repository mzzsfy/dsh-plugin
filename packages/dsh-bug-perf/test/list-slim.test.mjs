// 列表瘦身的契约:只裁白名单、命中缓存不重建、增删事件失效、任何异常回落到原行为。
// 安全面:包装必须保留调用方 receiver(宿主在 list 内按 invocation 逐项鉴权),
// 缓存只服务 owner/本地调用,非 owner 主体不得命中共享缓存。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installListSlim, KEEP_PROJECTIONS, slimItem } from '../src/list-slim.mjs'

/** 一条带完整投影的列表项。 */
const item = (id, values) => ({ sessionId: id, updatedAt: 1, projections: { kind: 'cached', asOfSeq: 1, values } })

/** 造一个只实现本模块用到表面的上下文(缺服务时不回调,模拟 cordis inject 门控)。 */
function makeContext(list, { withController = true, controller: given, effectError } = {}) {
  const handlers = new Map()
  const disposers = []
  const logs = { info: [], warn: [] }
  const controller = withController ? (given ?? { ctx: {}, list }) : undefined
  const ctx = {
    get: (name) => (name === 'sessionController' ? controller : undefined),
    on: (event, handler) => handlers.set(event, handler),
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    inject: (deps, callback) => {
      if (controller === undefined) return
      callback({
        sessionController: controller,
        on: (event, handler) => handlers.set(event, handler),
        effect: (factory) => {
          if (effectError !== undefined) throw effectError
          disposers.push(factory())
        },
      })
    },
  }
  return { ctx, controller, handlers, disposers, logs }
}

const sample = () => [
  item('a', { title: 'A', sessionListMetadata: { blank: false }, contextHeaders: [{ pad: 'x'.repeat(64) }] }),
  item('b', { title: 'B', inbox: { 'next-turn': [], 'next-step': [] } }),
]

/** 模拟宿主 service proxy 的 receiver:invocation 决定 remoteAccess 的判定。 */
const receiverOf = (principal) => ({ ctx: { invocation: principal === undefined ? undefined : { peer: { principal } } } })

test('裁剪只保留白名单里的投影', () => {
  const slim = slimItem(sample()[0], ['title'])
  assert.deepEqual(Object.keys(slim.projections.values), ['title'])
  assert.equal(slim.projections.kind, 'cached')
  assert.equal(slim.sessionId, 'a')
})

test('子会话与分支血缘投影保留在列表 block 中', () => {
  const values = {
    title: '根',
    subagentCatalog: { head: [{ childSessionId: 'child' }] },
    subagentTiming: { child: { startedAt: 1 } },
    subagent: { mode: 'continuable' },
    forkLineage: { parentSessionId: 'p' },
  }
  const slim = slimItem(item('root', values), KEEP_PROJECTIONS)
  assert.deepEqual(Object.keys(slim.projections.values).sort(), Object.keys(values).sort())
})

test('形状不符的条目原样返回', () => {
  const bare = { sessionId: 'c' }
  assert.equal(slimItem(bare, ['title']), bare)
  assert.equal(slimItem({ projections: { values: null } }, ['title']).projections.values, null)
  const array = { projections: { values: ['x'] } }
  assert.equal(slimItem(array, ['title']), array)
})

test('开关关闭时包装保留,但每次调用透传原方法', async () => {
  const original = async () => ({ items: sample() })
  const { ctx, controller } = makeContext(original)
  installListSlim(ctx, { isEnabled: () => false, warmupDelayMs: -1 })
  assert.notEqual(controller.list, original)
  const value = await controller.list({}, undefined)
  assert.equal(value.items[0].projections.values.contextHeaders[0].pad.length, 64)
})

// Given 宿主没有 sessionController, When 装载, Then inject 不回调、不接管、不抛错
test('宿主没有 sessionController 时静默等待', () => {
  const { ctx, logs } = makeContext(undefined, { withController: false })
  assert.equal(installListSlim(ctx, { warmupDelayMs: -1 }), true)
  assert.deepEqual(logs.warn, [])
})

// Given 服务在场但没有 list 方法, When 装载, Then 记录原因并放弃
test('controller 缺 list 方法时记录原因', () => {
  const { ctx, logs } = makeContext(undefined, { controller: { ctx: {} } })
  installListSlim(ctx, { warmupDelayMs: -1 })
  assert.ok(logs.warn.some((message) => message.includes('list 不可用')))
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

test('不同 signal 的并发调用共享一次构建,取消互不影响', async () => {
  let built = 0
  let release
  const { ctx, controller } = makeContext(() => {
    built += 1
    return new Promise((resolve) => {
      release = () => resolve({ items: sample() })
    })
  })
  installListSlim(ctx, { warmupDelayMs: -1 })
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = controller.list({}, firstController.signal)
  const second = controller.list({}, secondController.signal)
  firstController.abort()
  release()
  const [firstResult, secondResult] = await Promise.allSettled([first, second])
  assert.equal(built, 1)
  assert.equal(firstResult.status, 'rejected')
  assert.equal(secondResult.status, 'fulfilled')
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

// Given 另一个插件在本插件之后包装了 list, When 本插件卸载, Then 不摘掉后装包装且链上透传
test('卸载不摘掉后装的包装', async () => {
  const original = async () => ({ items: sample() })
  const { ctx, controller, disposers } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const wrapped = controller.list
  const later = async function (request, signal) {
    return wrapped.call(this, request, signal)
  }
  controller.list = later
  for (const dispose of disposers) dispose()
  assert.equal(controller.list, later)
  const value = await controller.list({}, undefined)
  assert.equal(value.items[0].projections.values.contextHeaders[0].pad.length, 64, '卸载后链上的旧包装应透传')
})

// Given 服务代理每次读取 list 都返回新引用(真实 cordis traceable), When 卸载, Then 按包装标记仍恢复原方法
test('服务代理返回新引用时卸载仍恢复原方法', async () => {
  const original = async () => ({ items: sample() })
  let current = original
  const service = {
    ctx: {},
    get list() {
      return new Proxy(current, {})
    },
    set list(value) {
      current = value
    },
  }
  const { ctx, disposers } = makeContext(undefined, { controller: service })
  installListSlim(ctx, { warmupDelayMs: -1 })
  const installed = current
  assert.notEqual(service.list, installed, '代理每次返回新引用')
  for (const dispose of disposers) dispose()
  assert.notEqual(current, installed, '卸载后不再指向包装')
  const value = await current({})
  assert.equal(value.items[0].projections.values.contextHeaders[0].pad.length, 64, '恢复后透传完整投影')
})

// Given 宿主 effect 注册失败, When 装载, Then 包装与标记回滚,不留下无法卸载的包装
test('effect 注册失败时回滚包装', () => {
  const original = async () => ({ items: sample() })
  const { ctx, controller, logs } = makeContext(original, { effectError: new Error('inactive') })
  installListSlim(ctx, { warmupDelayMs: -1 })
  assert.equal(controller.list, original)
  assert.equal(controller[Symbol.for('@mzzsfy/dsh-bug-perf/list-slim')], undefined)
  assert.ok(logs.warn.some((message) => message.includes('装载失败')))
})

// Given 第一实例的安装标记不可见, When 第二实例再包装且第一实例卸载, Then 不摘掉第二实例的包装
test('不摘掉其它实例的包装', () => {
  const original = async () => ({ items: sample() })
  const first = makeContext(original)
  installListSlim(first.ctx, { warmupDelayMs: -1 })
  const firstWrapped = first.controller.list
  delete first.controller[Symbol.for('@mzzsfy/dsh-bug-perf/list-slim')]
  const second = makeContext(undefined, { controller: first.controller })
  installListSlim(second.ctx, { warmupDelayMs: -1 })
  const secondWrapped = first.controller.list
  assert.notEqual(secondWrapped, firstWrapped)
  for (const dispose of first.disposers) dispose()
  assert.equal(first.controller.list, secondWrapped)
})

// Given 所有调用者都取消, When 最后一个等待者结束, Then 中止共享构建,后续调用可重试
test('所有调用者取消后中止共享构建', async () => {
  let built = 0
  const signals = []
  const original = (request, signal) => {
    built += 1
    signals.push(signal)
    if (built === 1) {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return Promise.resolve({ items: sample() })
  }
  const { ctx, controller } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const first = new AbortController()
  const second = new AbortController()
  const waitFirst = controller.list({}, first.signal)
  const waitSecond = controller.list({}, second.signal)
  first.abort()
  second.abort()
  await Promise.allSettled([waitFirst, waitSecond])
  assert.equal(signals[0].aborted, true, '所有等待者取消后应中止构建')
  const third = await controller.list({}, undefined)
  assert.equal(built, 2)
  assert.deepEqual(third.items.map((entry) => entry.sessionId), ['a', 'b'])
})

// Given 列表构建在途, When 卸载, Then 中止内部构建
test('卸载中止在途构建', () => {
  let internal
  const original = (request, signal) => {
    internal = signal
    return new Promise(() => {})
  }
  const { ctx, controller, disposers } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  void controller.list({}, undefined)
  for (const dispose of disposers) dispose()
  assert.equal(internal.aborted, true)
})

// Given 同一服务重复装载, When 再次 install, Then 不叠加第二层包装
test('重复装载不叠加包装', () => {
  const original = async () => ({ items: sample() })
  const { ctx, controller } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const first = controller.list
  installListSlim(ctx, { warmupDelayMs: -1 })
  assert.equal(controller.list, first)
})

// Given 宿主 list 按 this.ctx.invocation 过滤, When viewer 主体调用, Then 包装保留 receiver 且只拿到可见项
test('包装保留调用方 receiver,非 owner 由宿主逐项过滤', async () => {
  const original = async function list() {
    const principal = this?.ctx?.invocation?.peer?.principal
    const items = principal?.kind === 'viewer' ? [item('shared', { title: 'S' })] : [item('secret', { title: 'X' }), item('shared', { title: 'S' })]
    return { items }
  }
  const { ctx } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const value = await ctx.get('sessionController').list.call(receiverOf({ kind: 'viewer' }), {}, undefined)
  assert.deepEqual(value.items.map((entry) => entry.sessionId), ['shared'])
})

// Given owner 已把全量列表写入缓存, When viewer 调用, Then 不命中 owner 缓存、仍由宿主过滤
test('非 owner 不命中 owner 缓存', async () => {
  let built = 0
  const original = async function list() {
    built += 1
    const principal = this?.ctx?.invocation?.peer?.principal
    const items = principal?.kind === 'viewer' ? [item('shared', { title: 'S' })] : [item('secret', { title: 'X' }), item('shared', { title: 'S' })]
    return { items }
  }
  const { ctx, controller } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const owner = await controller.list({}, undefined)
  assert.deepEqual(owner.items.map((entry) => entry.sessionId), ['secret', 'shared'])
  const viewer = await controller.list.call(receiverOf({ kind: 'viewer' }), {}, undefined)
  assert.deepEqual(viewer.items.map((entry) => entry.sessionId), ['shared'])
  assert.equal(built, 2, 'viewer 调用必须重新走原方法')
})

// Given 预热已构建 owner 缓存, When viewer 调用, Then 仍不命中缓存
test('预热缓存不对非 owner 生效', async () => {
  let built = 0
  const original = async function list() {
    built += 1
    const principal = this?.ctx?.invocation?.peer?.principal
    const items = principal?.kind === 'viewer' ? [item('shared', { title: 'S' })] : [item('secret', { title: 'X' }), item('shared', { title: 'S' })]
    return { items }
  }
  const { ctx, controller } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(built, 1)
  const viewer = await controller.list.call(receiverOf({ kind: 'viewer' }), {}, undefined)
  assert.deepEqual(viewer.items.map((entry) => entry.sessionId), ['shared'])
  assert.equal(built, 2)
})

// Given 列表构建在途, When 会话增删事件触发且同 signal 再次调用, Then 不复用失效前的构建
test('在途构建遇到失效后新调用重建', async () => {
  let built = 0
  const releases = []
  const original = () => {
    built += 1
    return new Promise((resolve) => {
      releases.push(() => resolve({ items: sample() }))
    })
  }
  const { ctx, controller, handlers } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const signal = new AbortController().signal
  const pending = controller.list({}, signal)
  handlers.get('api-session/added')()
  const second = controller.list({}, signal)
  assert.equal(built, 2, '失效后的新调用必须重建')
  releases[0]()
  releases[1]()
  await Promise.all([pending, second])
})

// Given 在途构建期间失效, When 旧构建完成, Then 旧结果不写回缓存
test('在途构建遇到失效后不写回旧快照', async () => {
  let built = 0
  const releases = []
  const original = () => {
    built += 1
    return new Promise((resolve) => {
      releases.push(() => resolve({ items: sample() }))
    })
  }
  const { ctx, controller, handlers } = makeContext(original)
  installListSlim(ctx, { warmupDelayMs: -1 })
  const pending = controller.list({}, undefined)
  handlers.get('api-session/added')()
  releases[0]()
  await pending
  const second = controller.list({}, undefined)
  assert.equal(built, 2, '失效期间的结果不得作为缓存命中')
  releases[1]()
  await second
})
