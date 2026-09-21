import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installGuard } from '../src/guard.js'

const MAIN_ROW_ID = 'shell-select'
const OFFICIAL_ROW_IDS = ['tool-pwsh', 'pwsh-sandbox']
const OFFICIAL_PACKAGES = {
  'tool-pwsh': '@deepseek-ai/dsh-tool-pwsh',
  'pwsh-sandbox': '@deepseek-ai/dsh-pwsh-sandbox',
}

const OFFICIAL_MODULE = (name) => ({ __name: name, name, apply() {} })

function stubLoader(rows) {
  const entries = rows.map(([id, options]) => ({
    id,
    options,
    get fiber() { return options?.running ? { uid: 'x' } : undefined },
  }))
  return { entries: () => entries }
}

function stubCtx({ loader, importOfficial }) {
  const logs = []
  return {
    ctx: {
      logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m), info: () => {} },
      loader,
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
    },
    logs,
    importOfficial,
  }
}

test('预载瞬时失败退避重试后成功', async () => {
  let attempts = 0
  const importOfficial = async (name) => {
    attempts++
    if (attempts <= 2) throw new Error('import 竞争超时')
    return OFFICIAL_MODULE(name)
  }
  const loader = stubLoader([
    [MAIN_ROW_ID, { id: MAIN_ROW_ID, name: '@mzzsfy/dsh-shell-select', disabled: true }],
    ['tool-pwsh', { id: 'tool-pwsh', name: OFFICIAL_PACKAGES['tool-pwsh'], disabled: true }],
    ['pwsh-sandbox', { id: 'pwsh-sandbox', name: OFFICIAL_PACKAGES['pwsh-sandbox'], disabled: true }],
  ])
  const { ctx } = stubCtx({ loader, importOfficial })
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
})

test('预载重试耗尽仍失败则停用自愈', async () => {
  const importOfficial = async () => { throw new Error('持续不可用') }
  const loader = stubLoader([
    [MAIN_ROW_ID, { id: MAIN_ROW_ID, name: '@mzzsfy/dsh-shell-select', disabled: true }],
    ['tool-pwsh', { id: 'tool-pwsh', name: OFFICIAL_PACKAGES['tool-pwsh'], disabled: true }],
    ['pwsh-sandbox', { id: 'pwsh-sandbox', name: OFFICIAL_PACKAGES['pwsh-sandbox'], disabled: true }],
  ])
  const { ctx, logs } = stubCtx({ loader, importOfficial })
  const result = await installGuard(ctx, {
    importOfficial,
    delay: async () => {},
    timeouts: { load: 50, mount: 50 },
    sweepIntervalMs: 60 * 1000,
  })
  assert.equal(result, undefined)
  assert.ok(logs.some((m) => m.includes('死态自愈停用')))
})
