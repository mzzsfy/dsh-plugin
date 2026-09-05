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
  mergeMapping as coreMergeMapping,
  deadCustomIds as coreDeadCustomIds,
  chooseChannels as coreChooseChannels,
  parseVolume as coreParseVolume,
  imTargetKeyOf as coreImTargetKeyOf,
  toggleImTargetList as coreToggleImTargetList,
  removeImTargetFromList as coreRemoveImTargetFromList,
  unregisterImBotList as coreUnregisterImBotList,
  imBoundBotIds as coreImBoundBotIds,
  DEFAULT_VOLUME,
  CLAIM_LOCK_TTL_MS,
  USER_IDLE_AWAY_MS,
  CATEGORIES as coreCategories,
  CATEGORY_LABELS as coreCategoryLabels,
  DEFAULT_TONES as coreDefaultTones,
  BUILTIN_TONES as coreBuiltinTones,
  AUDIO_EXTS as coreAudioExts,
  MIME_BY_EXT as coreMimeByExt,
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
      + '; return { decideClaim, resolveSound, mergeMapping, deadCustomIds, chooseChannels, parseVolume, claimEvent, markDone, windowId, localGet, localSet, localDel, storageState, CLAIM_LOCK_TTL_MS, IDLE_AWAY_MS, KEY_DND, KEY_TOAST, KEY_SOUND, KEY_SYSTEM, imTargetKey, toggleImTargetList, removeImTargetFromList, unregisterImBotList, imBoundBotIds, CATEGORIES, CATEGORY_LABELS, DEFAULT_TONES, TONE_LABELS, AUDIO_EXTS, MIME_BY_EXT };',
  )
  return factory()
}

const client = clientLogic()

// 数据镜像常量对照:client 与 core 任一侧漂移即失败,防改文案或增删分类时静默失同步
test('[parity 数据镜像] 分类清单与标签对照', () => {
  assert.deepEqual(client.CATEGORIES, coreCategories)
  assert.deepEqual(client.CATEGORY_LABELS, coreCategoryLabels)
})

test('[parity 数据镜像] 默认音效与内置音名标签对照', () => {
  assert.deepEqual(client.DEFAULT_TONES, coreDefaultTones)
  assert.deepEqual(client.TONE_LABELS, coreBuiltinTones)
})

test('[parity 数据镜像] 音频扩展名与 MIME 映射对照', () => {
  assert.deepEqual(client.AUDIO_EXTS, coreAudioExts)
  assert.deepEqual(client.MIME_BY_EXT, coreMimeByExt)
})

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
    // undefined 域双实现同形:视为无记录而非终态
    assert.equal(decide({ stored: null, done: undefined, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: undefined, done: null, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: 'not-json', done: undefined, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'takeover')
  })
}

defineClaimScenarios('[core.mjs decideClaim] ', coreDecideClaim)
defineClaimScenarios('[client.js decideClaim] ', clientDecideClaim)

function defineSoundScenarios(prefix, resolve) {
  test(prefix + '音效解析对照:自定义命中 / 内置音名命中 / 失效与未配置回落', () => {
    const mapping = { completed: 'snd-9', error: 'gone', interrupted: 'bell' }
    assert.deepEqual(resolve({ category: 'completed', mapping, uploadedIds: ['snd-9'] }), { kind: 'custom', id: 'snd-9' })
    // 映射值为内置音名时必须播放该内置音,而非回落分类默认
    assert.deepEqual(resolve({ category: 'interrupted', mapping, uploadedIds: [] }), { kind: 'builtin', name: 'bell' })
    assert.deepEqual(resolve({ category: 'completed', mapping, uploadedIds: [] }), { kind: 'builtin', name: 'up-arpeggio' })
    const fallback = resolve({ category: 'error', mapping, uploadedIds: ['snd-9'] })
    assert.equal(fallback.kind, 'builtin')
    assert.notEqual(fallback.name, 'gone')
  })
}

defineSoundScenarios('[core.mjs resolveSound] ', coreResolveSound)
defineSoundScenarios('[client.js resolveSound] ', clientResolveSound)

// 双作用域映射合并对照:覆盖语义、缺键回落、空串覆盖与空入参容错。
function defineMergeScenarios(prefix, merge) {
  test(prefix + '映射合并:本地覆盖 / 缺键回落 / 空串覆盖 / 空入参容错', () => {
    assert.deepEqual(merge({ completed: 'a', error: 'b' }, { completed: 'c' }), { completed: 'c', error: 'b' })
    assert.deepEqual(merge({ completed: 'a' }, {}), { completed: 'a' })
    assert.deepEqual(merge({ completed: 'a' }, { completed: '' }), { completed: '' })
    assert.deepEqual(merge(null, { completed: 'a' }), { completed: 'a' })
    assert.deepEqual(merge({ completed: 'a' }, null), { completed: 'a' })
    assert.deepEqual(merge(undefined, undefined), {})
    const base = { completed: 'a' }
    assert.deepEqual(merge(base, { completed: 'b' }), { completed: 'b' })
    assert.deepEqual(base, { completed: 'a' })
  })
}

defineMergeScenarios('[core.mjs mergeMapping] ', coreMergeMapping)
defineMergeScenarios('[client.js mergeMapping] ', client.mergeMapping)

// 死链识别对照:非内置音名且非已上传 id 即死链,去重按首次出现,空值与非字符串跳过。
function defineDeadScenarios(prefix, dead) {
  test(prefix + '死链识别:死链收集 / 内置与已上传豁免 / 去重保序 / 空值与非字符串跳过 / 列表容错', () => {
    const mapping = { completed: 'gone-2', error: 'bell', interrupted: 'gone-1', approval: '', ask: 'gone-2', 'max-tokens': 'snd-1' }
    assert.deepEqual(dead(mapping, ['snd-1']), ['gone-2', 'gone-1'])
    assert.deepEqual(dead({ completed: 'bell' }, []), [])
    assert.deepEqual(dead({}, ['snd-1']), [])
    assert.deepEqual(dead(null, []), [])
    assert.deepEqual(dead({ completed: 7, error: null, ask: { id: 'x' } }, ['snd-1']), [])
    assert.deepEqual(dead({ completed: 'gone-1' }, null), ['gone-1'])
  })
}

defineDeadScenarios('[core.mjs deadCustomIds] ', coreDeadCustomIds)
defineDeadScenarios('[client.js deadCustomIds] ', client.deadCustomIds)

// 四通道矩阵对照:client 版开关取自 localStorage,经 stub 注入后与 core 参数化版本逐场景比对。
function clientChooseChannels({ hasFocus, permission, focusQuiet, toastEnabled, soundEnabled, soundCategories, category, systemEnabled, idleMs, idleThresholdMs }) {
  const backing = new Map()
  if (focusQuiet === false) backing.set(client.KEY_DND, '0')
  if (systemEnabled === false) backing.set(client.KEY_SYSTEM, '0')
  if (toastEnabled === false) backing.set(client.KEY_TOAST, '0')
  if (soundEnabled === false) backing.set(client.KEY_SOUND, '0')
  globalThis.window = { localStorage: { getItem: (key) => (backing.has(key) ? backing.get(key) : null) } }
  try {
    if (idleThresholdMs !== undefined) assert.equal(client.IDLE_AWAY_MS, idleThresholdMs)
    return client.chooseChannels(hasFocus, permission, idleMs ?? undefined, soundCategories ?? null, category ?? null)
  } finally {
    delete globalThis.window
  }
}

function defineChannelScenarios(prefix, channels) {
  test(prefix + '四通道矩阵对照:聚焦静默 / 双开关 / 授权与降级 / 提示音分类静音', () => {
    const base = { hasFocus: false, permission: 'granted' }
    assert.deepEqual(channels(base), { toast: true, sound: true, system: true, blink: false })
    assert.deepEqual(channels({ ...base, hasFocus: true }), { toast: true, sound: false, system: false, blink: false })
    assert.deepEqual(channels({ ...base, hasFocus: true, focusQuiet: false }).sound, true)
    assert.deepEqual(channels({ ...base, toastEnabled: false }).toast, false)
    assert.deepEqual(channels({ ...base, systemEnabled: false }), { toast: true, sound: true, system: false, blink: false })
    assert.deepEqual(channels({ ...base, permission: 'default' }), { toast: true, sound: true, system: false, blink: true })
    assert.deepEqual(channels({ ...base, permission: 'denied', systemEnabled: false }).blink, false)
    assert.deepEqual(channels({ ...base, soundEnabled: false }), { toast: true, sound: false, system: true, blink: false })
    assert.equal(channels({ ...base, soundCategories: { ask: false }, category: 'ask' }).sound, false)
    assert.equal(channels({ ...base, soundCategories: { ask: false }, category: 'completed' }).sound, true)
    assert.equal(channels({ ...base, soundCategories: { ask: false } }).sound, true)
    assert.equal(channels({ ...base, soundCategories: { ask: false }, category: null }).sound, true)
  })
  test(prefix + '用户空闲对照:满阈值离开全通道,活跃聚焦静默', () => {
    const base = { hasFocus: true, permission: 'granted', idleThresholdMs: USER_IDLE_AWAY_MS }
    assert.deepEqual(channels({ ...base, idleMs: USER_IDLE_AWAY_MS }), { toast: true, sound: true, system: true, blink: false })
    assert.equal(channels({ ...base, idleMs: USER_IDLE_AWAY_MS - 1 }).sound, false)
    assert.equal(channels({ ...base, idleMs: 0 }).sound, false)
    assert.deepEqual(channels(base), { toast: true, sound: false, system: false, blink: false })
  })
}

defineChannelScenarios('[core.mjs chooseChannels] ', coreChooseChannels)
defineChannelScenarios('[client.js chooseChannels] ', clientChooseChannels)

function defineVolumeScenarios(prefix, parse) {
  test(prefix + '音量解析对照:未设置回默认 / 显式零保留 / 非法回落', () => {
    assert.equal(parse(null), DEFAULT_VOLUME)
    assert.equal(parse(undefined), DEFAULT_VOLUME)
    assert.equal(parse('0'), 0)
    assert.equal(parse('0.5'), 0.5)
    assert.equal(parse('1'), 1)
    assert.equal(parse('-1'), DEFAULT_VOLUME)
    assert.equal(parse('abc'), DEFAULT_VOLUME)
    assert.equal(parse('3'), DEFAULT_VOLUME)
  })
}

defineVolumeScenarios('[core.mjs parseVolume] ', coreParseVolume)
defineVolumeScenarios('[client.js parseVolume] ', client.parseVolume)

// IM 投递目标列表操作对照:client 版 key 为 imTargetKey,其余签名一致。
const A = { botId: 'wx_aaa', targetId: 'tgt_1' }
const B = { botId: 'wx_aaa', targetId: 'tgt_2' }
const C = { botId: 'wx_bbb', targetId: 'tgt_1' }

function clientToggle(list, botId, targetId, checked) {
  return client.toggleImTargetList(list, botId, targetId, checked)
}

function defineImTargetScenarios(prefix, keyOf, toggle, removeItem, unregister, boundBots) {
  test(prefix + '键拼接与勾选幂等对照', () => {
    assert.equal(keyOf(A), 'wx_aaa/tgt_1')
    const once = toggle([], 'wx_aaa', 'tgt_1', true)
    assert.deepEqual(once, [A])
    assert.deepEqual(toggle(once, 'wx_aaa', 'tgt_1', true), [A])
    assert.deepEqual(toggle(once, 'wx_bbb', 'tgt_1', true), [A, C])
  })
  test(prefix + '取消勾选/移除/取消注册对照', () => {
    const list = [A, B, C]
    assert.deepEqual(toggle(list, 'wx_aaa', 'tgt_2', false), [A, C])
    assert.deepEqual(removeItem(list, 'wx_aaa', 'tgt_2'), [A, C])
    assert.deepEqual(unregister(list, 'wx_aaa'), [C])
    assert.deepEqual(unregister(list, 'wx_nnn'), list)
  })
  test(prefix + '已绑 bot 去重保序对照', () => {
    assert.deepEqual(boundBots([A, B, C]), ['wx_aaa', 'wx_bbb'])
    assert.deepEqual(boundBots([]), [])
  })
}

defineImTargetScenarios(
  '[core.mjs imTargets] ',
  coreImTargetKeyOf,
  coreToggleImTargetList,
  coreRemoveImTargetFromList,
  coreUnregisterImBotList,
  coreImBoundBotIds,
)
defineImTargetScenarios(
  '[client.js imTargets] ',
  client.imTargetKey,
  clientToggle,
  client.removeImTargetFromList,
  client.unregisterImBotList,
  client.imBoundBotIds,
)

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
