// guard 生命周期:定时器随 fiber 清理(effect),停机竞态异常不逃逸为
// unhandledRejection——宿主 fail-loud 会把这类逃逸判为 fatal load failure
// 杀掉整个进程(dsh-maintain 重启停机窗口实测事故)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { installGuard } from '../src/guard.js'
import { MAIN_ROW_ID } from '../src/guard-state.mjs'

const OFFICIAL_MODULE = (name) => ({ __name: name, name, apply() {} })
const makeImport = async (packageName) => OFFICIAL_MODULE(packageName)

function row({ id, disabled = false, running = false }) {
  return {
    options: { id },
    get disabled() {
      return disabled
    },
    fiber: running ? { uid: 'f' } : undefined,
  }
}

function deadWorld() {
  return [
    row({ id: MAIN_ROW_ID, disabled: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
}

function stubCtx({ rows, resolveCount = { value: 0 } }) {
  const log = []
  const mounts = []
  const effects = []
  const listeners = new Map()
  const ctx = {
    logger: {
      warn: (msg) => log.push(['warn', msg]),
      error: (msg) => log.push(['error', msg]),
      info: (msg) => log.push(['info', msg]),
    },
    get loader() {
      return {
        resolve(id) {
          resolveCount.value += 1
          const found = rows.find((candidate) => candidate.options.id === id)
          if (found) return found
          throw new Error('not found')
        },
      }
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    effect(execute, label) {
      const dispose = execute()
      effects.push({ label, dispose })
      return dispose
    },
    plugin(module, config) {
      mounts.push({ moduleName: module.__name, config })
      return Promise.resolve({
        dispose: () => {
          mounts.length = 0
          return Promise.resolve()
        },
      })
    },
  }
  return { ctx, log, mounts, effects, resolveCount }
}

test('定时器随 fiber 清理:effect dispose 后不再扫描', async () => {
  const sweepIntervalMs = 20
  const { ctx, mounts, effects, resolveCount } = stubCtx({ rows: deadWorld() })
  await installGuard(ctx, { importOfficial: makeImport, sweepIntervalMs })
  assert.equal(mounts.length, 2)
  const timerEffect = effects.find((entry) => entry.label.includes('sweep'))
  assert.ok(timerEffect, 'sweep 定时器必须注册为 effect')
  assert.equal(typeof timerEffect.dispose, 'function')
  timerEffect.dispose()
  await sleep(sweepIntervalMs * 3)
  const settled = resolveCount.value
  await sleep(sweepIntervalMs * 3)
  assert.equal(resolveCount.value, settled, 'dispose 后不得再有 sweep 扫描')
})

test('sweep 异常不逃逸:停机竞态下 loader 抛错不产生 unhandledRejection', async () => {
  const sweepIntervalMs = 20
  const { ctx, mounts } = stubCtx({ rows: deadWorld() })
  await installGuard(ctx, { importOfficial: makeImport, sweepIntervalMs })
  assert.equal(mounts.length, 2)
  // 模拟 fiber 停用后 ctx.loader 访问抛 inactive context 错误
  Object.defineProperty(ctx, 'loader', {
    get() {
      throw new Error('cannot get required service "loader" in inactive context')
    },
  })
  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on('unhandledRejection', onRejection)
  try {
    await sleep(sweepIntervalMs * 4)
    assert.equal(mounts.length, 2, '异常不得破坏已挂载状态')
    assert.deepEqual(rejections, [])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})
