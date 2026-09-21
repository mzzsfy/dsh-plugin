// guard 入口集成(桩 ctx):安装 → 死态代挂两个官方行 → 复活卸载 → 官方包缺失停用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installGuard } from '../src/guard.js'
import { MAIN_ROW_ID, OFFICIAL_ROW_IDS } from '../src/guard-state.mjs'
import { shellSelectApplyState } from '../src/apply-state.mjs'

function row({ id, disabled = false, running = false }) {
  return {
    options: { id },
    get disabled() {
      return disabled
    },
    fiber: running ? { uid: 'f' } : undefined,
  }
}

function stubCtx({ rows, importOfficial }) {
  const log = []
  const mounts = []
  const listeners = new Map()
  const ctx = {
    logger: {
      warn: (msg) => log.push(['warn', msg]),
      error: (msg) => log.push(['error', msg]),
      info: (msg) => log.push(['info', msg]),
    },
    loader: {
      resolve(id) {
        const found = rows.find((candidate) => candidate.options.id === id)
        if (found) return found
        throw new Error('not found')
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
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
  return { ctx, log, mounts, listeners }
}

const OFFICIAL_MODULE = (name) => ({ __name: name, name, apply() {} })

function makeImport() {
  return async (packageName) => OFFICIAL_MODULE(packageName)
}

function deadWorld() {
  return [
    row({ id: MAIN_ROW_ID, disabled: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
}

test('死态安装:代挂两个官方行(pwsh-sandbox 配置读空文档)', async () => {
  const { ctx, mounts, log } = stubCtx({ rows: deadWorld(), importOfficial: makeImport() })
  await installGuard(ctx, {
    importOfficial: makeImport(),
    delay: async () => {},
    sweepIntervalMs: 10 * 3600 * 1000,
  })
  assert.equal(mounts.length, 2)
  assert.deepEqual(mounts.map((mount) => mount.moduleName), ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-pwsh-sandbox'])
  assert.deepEqual(mounts[0].config, {})
  assert.deepEqual(mounts[1].config, {})
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('代挂官方')))
})

test('非死态安装:不代挂', async () => {
  const rows = [
    row({ id: MAIN_ROW_ID }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
  const { ctx, mounts } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  assert.equal(mounts.length, 0)
})

test('官方包加载失败:告警并停用自愈,不抛错不拖垮树', async () => {
  const { ctx, mounts, log } = stubCtx({ rows: deadWorld() })
  await installGuard(ctx, {
    importOfficial: async () => {
      throw new Error('module not found')
    },
    delay: async () => {},
  })
  assert.equal(mounts.length, 0)
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('停用')))
})

test('复活边沿:受控行即将 init 时卸代挂再放行', async () => {
  const rows = deadWorld()
  const { ctx, mounts, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  assert.equal(mounts.length, 2)
  const patchContext = listeners.get('loader/patch-context')
  assert.ok(typeof patchContext === 'function')
  // 复活行:主行 fiber 空(即将 init)→ guard 卸代挂后放行
  await patchContext(row({ id: MAIN_ROW_ID }), () => 'passed')
  assert.equal(mounts.length, 0)
})

test('运行主行使复活行跳过让位逻辑(事件快速返回)', async () => {
  const rows = deadWorld()
  const { ctx, mounts, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  const patchContext = listeners.get('loader/patch-context')
  const runningEntry = row({ id: MAIN_ROW_ID, running: true })
  await patchContext(runningEntry, () => 'passed')
  assert.equal(mounts.length, 2)
})

test('apply 旗标:guard 引用的旗标模块可用', () => {
  assert.equal(shellSelectApplyState(), 'pending')
})

test('模块归一:apply 型模块直挂,default 类模块挂类(tool-pwsh/pwsh-sandbox 真实形态)', async () => {
  const applyShaped = { __name: '@deepseek-ai/dsh-tool-pwsh', name: 'tool-pwsh', apply() {}, Config: {}, inject: ['tools'] }
  const classShaped = { __name: '@deepseek-ai/dsh-pwsh-sandbox', default: class SandboxPwshExecutor {} }
  const modules = { '@deepseek-ai/dsh-tool-pwsh': applyShaped, '@deepseek-ai/dsh-pwsh-sandbox': classShaped }
  const mounted = []
  const { ctx } = stubCtx({ rows: deadWorld() })
  ctx.plugin = (plugin, config) => {
    mounted.push({ plugin, config })
    return Promise.resolve({ dispose: () => Promise.resolve() })
  }
  await installGuard(ctx, {
    importOfficial: async (packageName) => modules[packageName],
    delay: async () => {},
    sweepIntervalMs: 3600 * 1000,
  })
  assert.equal(mounted.length, 2)
  assert.equal(mounted[0].plugin, applyShaped)
  assert.equal(mounted[1].plugin, classShaped.default)
})

test('模块归一:两形态皆无的官方包按预载失败处理,停用自愈', async () => {
  const { ctx, mounts, log } = stubCtx({ rows: deadWorld() })
  await installGuard(ctx, {
    importOfficial: async () => ({ __name: 'shapeless' }),
    delay: async () => {},
  })
  assert.equal(mounts.length, 0)
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('停用')))
})
