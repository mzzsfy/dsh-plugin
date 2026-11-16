// guard 官方包按需加载的退避重试与失败定局(死态代挂才触发加载;正常启动零加载)。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installGuard } from '../src/guard.js'
import { MAIN_ROW_ID, OFFICIAL_ROW_IDS } from '../src/guard-state.mjs'

const OFFICIAL_PACKAGES = {
  'tool-pwsh': '@deepseek-ai/dsh-tool-pwsh',
  'pwsh-sandbox': '@deepseek-ai/dsh-pwsh-sandbox',
}

const OFFICIAL_MODULE = (name) => ({ __name: name, name, apply() {} })

function stubLoader(rows) {
  const entries = rows.map(([id, options]) => ({
    id,
    options,
    get disabled() { return options?.disabled === true },
    get fiber() { return options?.running ? { uid: 'x' } : undefined },
  }))
  return {
    entries: () => entries,
    resolve(id) {
      const found = entries.find((entry) => entry.id === id)
      if (found) return found
      throw new Error('not found')
    },
  }
}

function stubCtx({ loader, importOfficial }) {
  const logs = []
  const mounts = []
  return {
    ctx: {
      logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m), info: () => {} },
      loader,
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
      plugin: async (module) => {
        mounts.push(module.__name)
        return { dispose: async () => {} }
      },
    },
    logs,
    mounts,
    importOfficial,
  }
}

function deadWorldLoader() {
  return stubLoader([
    [MAIN_ROW_ID, { id: MAIN_ROW_ID, name: '@mzzsfy/dsh-shell-select', disabled: true }],
    ['tool-pwsh', { id: 'tool-pwsh', name: OFFICIAL_PACKAGES['tool-pwsh'], disabled: true }],
    [OFFICIAL_ROW_IDS[1], { id: OFFICIAL_ROW_IDS[1], name: OFFICIAL_PACKAGES[OFFICIAL_ROW_IDS[1]], disabled: true }],
  ])
}

test('预载瞬时失败退避重试后成功', async () => {
  let attempts = 0
  const importOfficial = async (name) => {
    attempts++
    if (attempts <= 2) throw new Error('import 竞争超时')
    return OFFICIAL_MODULE(name)
  }
  const { ctx, mounts } = stubCtx({ loader: deadWorldLoader(), importOfficial })
  const delays = []
  const result = await installGuard(ctx, {
    importOfficial,
    delay: async (ms) => { delays.push(ms) },
    timeouts: { load: 100, mount: 100 },
    sweepIntervalMs: 60 * 1000,
  })
  assert.equal(result, undefined)
  assert.ok(attempts >= 3, `至少 3 次尝试,实际 ${attempts}`)
  assert.ok(delays.length >= 2, '存在重试退避')
  assert.equal(mounts.length, 2, '加载恢复后照常代挂双行')
})

test('预载重试耗尽仍失败则停用自愈', async () => {
  const importOfficial = async () => { throw new Error('持续不可用') }
  const { ctx, logs, mounts } = stubCtx({ loader: deadWorldLoader(), importOfficial })
  const result = await installGuard(ctx, {
    importOfficial,
    delay: async () => {},
    timeouts: { load: 50, mount: 50 },
    sweepIntervalMs: 60 * 1000,
  })
  assert.equal(result, undefined)
  assert.equal(mounts.length, 0, '加载失败不得半挂')
  assert.ok(logs.some((m) => m.includes('死态自愈停用')))
})

test('非死态(主行在场):官方包零加载,apply 不被加载预算阻塞', async () => {
  let attempts = 0
  const importOfficial = async (name) => {
    attempts++
    return OFFICIAL_MODULE(name)
  }
  const loader = stubLoader([
    [MAIN_ROW_ID, { id: MAIN_ROW_ID, name: '@mzzsfy/dsh-shell-select', disabled: false, running: true }],
    ['tool-pwsh', { id: 'tool-pwsh', name: OFFICIAL_PACKAGES['tool-pwsh'], disabled: true }],
    [OFFICIAL_ROW_IDS[1], { id: OFFICIAL_ROW_IDS[1], name: OFFICIAL_PACKAGES[OFFICIAL_ROW_IDS[1]], disabled: true }],
  ])
  const { ctx, mounts } = stubCtx({ loader, importOfficial })
  await installGuard(ctx, {
    importOfficial,
    delay: async () => { throw new Error('正常启动不得进入退避等待') },
    timeouts: { load: 50, mount: 50 },
    sweepIntervalMs: 60 * 1000,
  })
  assert.equal(attempts, 0)
  assert.equal(mounts.length, 0)
})
