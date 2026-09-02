// parity 测试:client.js LOGIC 标记段与 src/core.mjs 同源逻辑对照(think-expand 模式)。
// 覆盖认领状态机、音效解析、存储不可用退化三条主干。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  decideClaim as coreDecideClaim,
  resolveSound as coreResolveSound,
  chooseChannels as coreChooseChannels,
  CLAIM_LOCK_TTL_MS,
} from '../src/core.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取标记段,构造同接口的纯逻辑实现。
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(
    section
      + '; return { decideClaim, resolveSound, chooseChannels, claimEvent, markDone, windowId, localGet, localSet, localDel, storageState, CLAIM_LOCK_TTL_MS, KEY_DND, KEY_TOAST, KEY_SYSTEM };',
  )
  return factory()
}

const client = clientLogic()

// client 段为位置参数签名,core 为对象签名,此处适配后逐场景对照。
function clientDecideClaim({ stored, done, now, windowId, lockTtlMs }) {
  assert.equal(client.CLAIM_LOCK_TTL_MS, lockTtlMs)
  return client.decideClaim(stored, done, now, windowId)
}

function clientResolveSound({ category, mapping, uploadedIds }) {
  return client.resolveSound(category, mapping, uploadedIds)
}

function defineClaimScenarios(prefix, decide) {
  const t0 = 1000
  test(prefix + '认领状态机四态对照', () => {
    assert.equal(decide({ stored: null, done: null, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: JSON.stringify({ wid: 'w2', at: t0 }), done: null, now: t0 + CLAIM_LOCK_TTL_MS - 1, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'skip')
    assert.equal(decide({ stored: JSON.stringify({ wid: 'w1', at: t0 }), done: null, now: t0 + CLAIM_LOCK_TTL_MS - 1, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: JSON.stringify({ wid: 'w2', at: t0 }), done: null, now: t0 + CLAIM_LOCK_TTL_MS + 1, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'takeover')
    assert.equal(decide({ stored: null, done: '1', now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'done')
    assert.equal(decide({ stored: 'not-json', done: null, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'takeover')
  })
}

defineClaimScenarios('[core.mjs decideClaim] ', coreDecideClaim)
defineClaimScenarios('[client.js decideClaim] ', clientDecideClaim)

function defineSoundScenarios(prefix, resolve) {
  test(prefix + '音效解析对照:自定义命中 / 失效与未配置回落', () => {
    const mapping = { completed: 'snd-9', error: 'gone' }
    assert.deepEqual(resolve({ category: 'completed', mapping, uploadedIds: ['snd-9'] }), { kind: 'custom', id: 'snd-9' })
    assert.deepEqual(resolve({ category: 'completed', mapping, uploadedIds: [] }), { kind: 'builtin', name: 'up-arpeggio' })
    const fallback = resolve({ category: 'error', mapping, uploadedIds: ['snd-9'] })
    assert.equal(fallback.kind, 'builtin')
    assert.notEqual(fallback.name, 'gone')
  })
}

defineSoundScenarios('[core.mjs resolveSound] ', coreResolveSound)
defineSoundScenarios('[client.js resolveSound] ', clientResolveSound)

// 四通道矩阵对照:client 版开关取自 localStorage,经 stub 注入后与 core 参数化版本逐场景比对。
function clientChooseChannels({ hasFocus, permission, focusQuiet, toastEnabled, systemEnabled }) {
  const backing = new Map()
  if (focusQuiet === false) backing.set(client.KEY_DND, '0')
  if (systemEnabled === false) backing.set(client.KEY_SYSTEM, '0')
  if (toastEnabled === false) backing.set(client.KEY_TOAST, '0')
  globalThis.window = { localStorage: { getItem: (key) => (backing.has(key) ? backing.get(key) : null) } }
  try {
    return client.chooseChannels(hasFocus, permission)
  } finally {
    delete globalThis.window
  }
}

function defineChannelScenarios(prefix, channels) {
  test(prefix + '四通道矩阵对照:聚焦静默 / 双开关 / 授权与降级', () => {
    const base = { hasFocus: false, permission: 'granted' }
    assert.deepEqual(channels(base), { toast: true, sound: true, system: true, blink: false })
    assert.deepEqual(channels({ ...base, hasFocus: true }), { toast: true, sound: false, system: false, blink: false })
    assert.deepEqual(channels({ ...base, hasFocus: true, focusQuiet: false }).sound, true)
    assert.deepEqual(channels({ ...base, toastEnabled: false }).toast, false)
    assert.deepEqual(channels({ ...base, systemEnabled: false }), { toast: true, sound: true, system: false, blink: false })
    assert.deepEqual(channels({ ...base, permission: 'default' }), { toast: true, sound: true, system: false, blink: true })
    assert.deepEqual(channels({ ...base, permission: 'denied', systemEnabled: false }).blink, false)
  })
}

defineChannelScenarios('[core.mjs chooseChannels] ', coreChooseChannels)
defineChannelScenarios('[client.js chooseChannels] ', clientChooseChannels)

test('[client.js] localStorage 抛错:认领退化为直接发声且提示位可用', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
    removeItem: () => { throw new Error('blocked') },
  }
  const original = globalThis.window
  globalThis.window = { localStorage: throwing }
  try {
    client.storageState.broken = false
    assert.equal(client.claimEvent('u1'), true)
    assert.equal(client.storageState.broken, true)
    assert.equal(client.localGet('k'), null)
    client.markDone('u1')
  } finally {
    client.storageState.broken = false
    if (original === undefined) delete globalThis.window
    else globalThis.window = original
  }
})

test('[client.js] localStorage 正常:写后读回唯一发声', () => {
  const backing = new Map()
  const store = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => { backing.set(key, value) },
    removeItem: (key) => { backing.delete(key) },
  }
  const original = globalThis.window
  globalThis.window = { localStorage: store }
  try {
    client.storageState.broken = false
    assert.equal(client.claimEvent('u2'), true)
    client.markDone('u2')
    // 完成标记后不再认领
    assert.equal(client.claimEvent('u2'), false)
  } finally {
    client.storageState.broken = false
    if (original === undefined) delete globalThis.window
    else globalThis.window = original
  }
})

test('client.js 语法可被 node 解析', () => {
  execFileSync(process.execPath, ['--check', join(PKG_ROOT, 'src', 'client.js')])
})
