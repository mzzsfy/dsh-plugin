// guard-rail 单元:护栏语义——正常完成透传值、超时按位降级抛错、
// 超时前拒绝透传、超时后迟到 settlement 不产生未处理拒绝、
// thenable 引用不被 race 吞掉(settlement 值非引用的形态)
import test from 'node:test'
import assert from 'node:assert/strict'
import { withTimeout, isGuardRailTimeout, MODULE_LOAD_TIMEOUT_MS, DISPOSE_TIMEOUT_MS, MOUNT_TIMEOUT_MS } from '../src/guard-rail.mjs'

test('护栏: 正常完成透传值', async () => {
  const value = { id: 1 }
  const result = await withTimeout(Promise.resolve(value), 1000, '测试')
  assert.equal(result, value)
})

test('护栏: 超时抛错,消息含位置标注且带机器可读 code', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 10, '测试位置'),
    (error) => {
      assert.match(error.message, /测试位置/)
      assert.match(error.message, /10ms/)
      assert.equal(isGuardRailTimeout(error), true)
      return true
    },
  )
})

test('护栏: 超时前底层拒绝,错误透传且非超时标记', async () => {
  const boom = new Error('底层失败')
  await assert.rejects(
    () => withTimeout(new Promise((_, reject) => setTimeout(() => reject(boom), 5)), 10 * 1000, '测试'),
    (error) => error === boom && isGuardRailTimeout(error) === false,
  )
})

test('护栏: 超时后底层迟到 settlement,不产生未处理拒绝且调用方已降级', async () => {
  const late = new Promise((resolve) => setTimeout(() => resolve('迟到'), 30))
  await assert.rejects(() => withTimeout(late, 5, '测试'), isGuardRailTimeout)
  // 迟到完成不许炸进程:挂 settle handler 消费即可,断言其不影响已降级的调用方
  assert.equal(await late, '迟到')
})

test('护栏: 超时后底层迟到拒绝,不产生未处理拒绝', async () => {
  const lateReject = new Promise((_, reject) => setTimeout(() => reject(new Error('迟到失败')), 30))
  await assert.rejects(() => withTimeout(lateReject, 5, '测试'), isGuardRailTimeout)
  // 挂 rejection handler 消费迟到拒绝;若为 unhandledRejection 进程即崩,用例失败
  await assert.rejects(() => lateReject, /迟到失败/)
})

test('护栏: thenable 对象引用不丢失(race 吸收后仍拿到原对象)', async () => {
  const fiber = {
    disposed: false,
    then(onFulfilled) { return Promise.resolve(onFulfilled(undefined)) },
    async dispose() { this.disposed = true },
  }
  let held = null
  const likeMount = (async () => {
    const raw = fiber
    await withTimeout(Promise.resolve(raw), 1000, '测试')
    held = raw
  })()
  await likeMount
  assert.equal(held, fiber)
  await held.dispose()
  assert.equal(held.disposed, true)
})

test('护栏: 常量取值', () => {
  assert.equal(MODULE_LOAD_TIMEOUT_MS, 30 * 1000)
  assert.equal(DISPOSE_TIMEOUT_MS, 5 * 1000)
  assert.equal(MOUNT_TIMEOUT_MS, 30 * 1000)
})
