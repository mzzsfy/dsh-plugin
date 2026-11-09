// 历史窗口收敛的契约:只下调预算、按宿主校验同步收敛 turn 下限、异常与关闭一律透传原请求。
// 包装的是宿主 sessionController 的历史入口(follow/page/events),不改地址等身份字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HISTORY_METHODS, installSessionWindow, limitHistoryRequest } from '../src/session-window.mjs'

const WINDOW = { maxMessages: 200, minTurns: 2 }

/** 客户端默认发出的首屏请求形态(宿主 HISTORY_PAGE_OPTIONS)。 */
const hostRequest = () => ({
  address: { kind: 'session', sessionId: 'session-a' },
  activate: true,
  assistantStream: true,
  maxMessages: 500,
  turnWindow: { minMessages: 50, minTurns: 2 },
})

/** 造一个只实现本模块用到表面的上下文(缺服务时不回调,模拟 cordis inject 门控)。 */
function makeContext(controller, { effectError } = {}) {
  const disposers = []
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    inject: (deps, callback) => {
      if (controller === undefined) return
      callback({
        sessionController: controller,
        effect: (factory) => {
          if (effectError !== undefined) throw effectError
          disposers.push(factory())
        },
      })
    },
  }
  return { ctx, disposers, logs }
}

/** 记录调用参数的 sessionController 替身:方法定义在原型上,与宿主服务同形。 */
function makeController() {
  const calls = []
  const results = { page: { records: ['page'] }, events: { records: ['events'] } }
  class FakeController {
    follow(request, signal) {
      calls.push({ method: 'follow', request, signal, receiver: this })
      return (async function* () {})()
    }
    page(request, signal, ...rest) {
      calls.push({ method: 'page', request, signal, rest, receiver: this })
      return Promise.resolve(results.page)
    }
    events(request, signal) {
      calls.push({ method: 'events', request, signal, receiver: this })
      return Promise.resolve(results.events)
    }
    list() { return Promise.resolve({ items: [] }) }
  }
  return { controller: new FakeController(), calls, results }
}

test('历史窗口_预算超上限_收敛并同步轮下限', () => {
  const request = hostRequest()
  const limited = limitHistoryRequest(request, WINDOW)
  assert.equal(limited.maxMessages, 200)
  assert.deepEqual(limited.turnWindow, { minMessages: 50, minTurns: 2 })
  assert.equal(limited.address, request.address)
  assert.equal(limited.activate, true)
  assert.equal(limited.assistantStream, true)
})

test('历史窗口_轮下限超上限_同步下调', () => {
  const limited = limitHistoryRequest({ maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 5 } }, { maxMessages: 120, minTurns: 1 })
  assert.equal(limited.maxMessages, 120)
  assert.deepEqual(limited.turnWindow, { minMessages: 120, minTurns: 1 })
})

test('历史窗口_预算未超上限_原对象返回', () => {
  const request = { maxMessages: 40, turnWindow: { minMessages: 20, minTurns: 2 } }
  assert.equal(limitHistoryRequest(request, WINDOW), request)
})

test('历史窗口_无预算只有轮数_只收轮数', () => {
  const request = { address: {}, turnWindow: { minMessages: 50, minTurns: 4 } }
  const limited = limitHistoryRequest(request, WINDOW)
  assert.equal(limited.maxMessages, undefined)
  assert.deepEqual(limited.turnWindow, { minMessages: 50, minTurns: 2 })
})

test('历史窗口_无窗口字段_原对象返回', () => {
  const request = { address: {}, activate: true }
  assert.equal(limitHistoryRequest(request, WINDOW), request)
})

test('历史窗口_非对象请求_原样返回', () => {
  assert.equal(limitHistoryRequest(undefined, WINDOW), undefined)
  assert.equal(limitHistoryRequest(null, WINDOW), null)
  assert.equal(limitHistoryRequest('session-a', WINDOW), 'session-a')
})

test('历史窗口_turnWindow非法_只收预算', () => {
  const request = { maxMessages: 500, turnWindow: 'two' }
  const limited = limitHistoryRequest(request, WINDOW)
  assert.equal(limited.maxMessages, 200)
  assert.equal(limited.turnWindow, 'two')
})

test('历史窗口_安装_三个入口都按上限下发', async () => {
  const { controller, calls } = makeController()
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  for (const method of HISTORY_METHODS) {
    await controller[method](hostRequest(), undefined)
  }
  assert.deepEqual(calls.map((call) => call.method), [...HISTORY_METHODS])
  for (const call of calls) {
    assert.equal(call.request.maxMessages, 200)
    assert.deepEqual(call.request.turnWindow, { minMessages: 50, minTurns: 2 })
  }
})

test('历史窗口_安装_实现以服务实例为receiver', async () => {
  const { controller, calls } = makeController()
  const signal = new AbortController().signal
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  await controller.page(hostRequest(), signal)
  assert.equal(calls[0].receiver, controller)
  assert.equal(calls[0].signal, signal)
})

test('历史窗口_安装_非首参原样转发', async () => {
  const { controller, calls } = makeController()
  const signal = new AbortController().signal
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  await controller.page(hostRequest(), signal, 'extra')
  assert.equal(calls[0].request.maxMessages, 200)
  assert.equal(calls[0].signal, signal)
  assert.deepEqual(calls[0].rest, ['extra'])
})

test('历史窗口_安装_follow保持异步迭代协议', () => {
  const { controller } = makeController()
  const { ctx, logs } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  const stream = controller.follow(hostRequest(), undefined)
  assert.equal(typeof stream[Symbol.asyncIterator], 'function')
  assert.equal(logs.info.length, 1)
})

test('历史窗口_开关关闭_透传原参数', async () => {
  const { controller, calls } = makeController()
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => false, readWindow: () => WINDOW })
  await controller.page(hostRequest(), undefined)
  assert.equal(calls[0].request.maxMessages, 500)
})

test('历史窗口_读配置抛错_透传原参数', async () => {
  const { controller, calls } = makeController()
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => { throw new Error('config gone') } })
  await controller.events(hostRequest(), undefined)
  assert.equal(calls[0].request.maxMessages, 500)
})

test('历史窗口_卸载_恢复原方法', async () => {
  const { controller, calls } = makeController()
  const original = controller.page
  const { ctx, disposers } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  assert.notEqual(controller.page, original)
  for (const dispose of disposers) dispose()
  assert.equal(controller.page, original)
  await controller.page(hostRequest(), undefined)
  assert.equal(calls[0].request.maxMessages, 500)
})

test('历史窗口_重复安装_不叠加包装', async () => {
  const { controller, calls } = makeController()
  const { ctx, disposers } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  const first = Object.getOwnPropertyDescriptor(controller, 'follow')?.value
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  assert.equal(Object.getOwnPropertyDescriptor(controller, 'follow')?.value, first)
  // 只卸载一次也回到原型实现:叠加安装会残留第二层 own 属性
  for (const dispose of disposers) dispose()
  assert.equal(Object.getOwnPropertyDescriptor(controller, 'follow'), undefined)
  await controller.follow(hostRequest(), undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.maxMessages, 500)
})

test('历史窗口_卸载_不误删后来者的包装', async () => {
  const { controller } = makeController()
  const { ctx, disposers } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  const later = function later() { return (async function* () {})() }
  Object.defineProperty(controller, 'page', { value: later, writable: true, configurable: true })
  for (const dispose of disposers) dispose()
  assert.equal(Object.getOwnPropertyDescriptor(controller, 'page')?.value, later)
  assert.equal(Object.getOwnPropertyDescriptor(controller, 'follow'), undefined)
})

test('历史窗口_返回值原样透传', async () => {
  const { controller, results } = makeController()
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  assert.equal(await controller.page(hostRequest(), undefined), results.page)
  assert.equal(await controller.events(hostRequest(), undefined), results.events)
})

test('历史窗口_开关读取抛错_透传原参数', async () => {
  const { controller, calls } = makeController()
  const { ctx } = makeContext(controller)
  installSessionWindow(ctx, {
    isEnabled: () => { throw new Error('flag gone') },
    readWindow: () => WINDOW,
  })
  await controller.follow(hostRequest(), undefined)
  assert.equal(calls[0].request.maxMessages, 500)
})

test('历史窗口_上限非正安全整数_不写进请求', () => {
  const request = hostRequest()
  for (const window of [{ maxMessages: 200.5, minTurns: 1.5 }, { maxMessages: 0, minTurns: 0 }, { maxMessages: '200', minTurns: undefined }]) {
    const limited = limitHistoryRequest(request, window)
    assert.equal(limited, request)
  }
})

test('历史窗口_服务属性被代理包装_卸载仍恢复原型方法', async () => {
  const { controller, calls } = makeController()
  // 复刻 Cordis 追踪代理:方法读取返回新包装,引用比较不可信
  const proxy = new Proxy(controller, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof key === 'string' && HISTORY_METHODS.includes(key) && typeof value === 'function') {
        return function (...args) { return Reflect.apply(value, target, args) }
      }
      return value
    },
  })
  const { ctx, disposers } = makeContext(proxy)
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  assert.equal(Object.getOwnPropertyDescriptor(controller, 'follow')?.value?.name, 'patched')
  for (const dispose of disposers) dispose()
  assert.equal(Object.getOwnPropertyDescriptor(controller, 'follow'), undefined)
  await controller.follow(hostRequest(), undefined)
  assert.equal(calls[0].request.maxMessages, 500)
})

test('历史窗口_缺sessionController_不抛', () => {
  const { ctx, logs } = makeContext(undefined)
  assert.doesNotThrow(() => installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW }))
  assert.equal(logs.warn.length, 0)
})

test('历史窗口_入口全缺_记录跳过', () => {
  const { ctx, logs } = makeContext({})
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  assert.equal(logs.warn.length, 1)
})

test('历史窗口_effect注册失败_回滚包装', () => {
  const { controller } = makeController()
  const original = controller.follow
  const { ctx, logs } = makeContext(controller, { effectError: new Error('effect frozen') })
  installSessionWindow(ctx, { isEnabled: () => true, readWindow: () => WINDOW })
  assert.equal(controller.follow, original)
  assert.equal(logs.warn.length, 1)
})
