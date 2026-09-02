// 纯逻辑层测试:分类映射 / 过滤决策 / 投影 / 认领状态机 / webhook 组装 / 音效映射 / 上传校验 / 标题提取。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORIES,
  CATEGORY_DONE,
  CATEGORY_ERROR,
  CATEGORY_APPROVAL,
  CATEGORY_ASK,
  mapEventToCategory,
  isSubagent,
  isSubagentWakeTurn,
  shouldNotify,
  SUBAGENT_WAKE_WINDOW_MS,
  buildUnit,
  buildWebhookPayload,
  createProjection,
  decideClaim,
  chooseChannels,
  resolveSound,
  pruneMapping,
  renameMapping,
  validateSoundName,
  SOUND_NAME_MAX_CHARS,
  parseVolume,
  DEFAULT_VOLUME,
  validateMappingId,
  validateConfigPatch,
  resolvedConfig,
  publicConfig,
  validateUpload,
  collectSessionEvents,
  readRawBody,
  sessionTitle,
  createApprovalTap,
  sendWebhook,
  TONE_BELL,
  TONE_UP_ARPEGGIO,
} from '../src/core.mjs'
import { EventEmitter } from 'node:events'

const MIN_TURN_MS = 5 * 1000

function baseSettings(overrides) {
  return {
    enabled: Object.fromEntries(CATEGORIES.map((name) => [name, true])),
    rootsOnly: true,
    minTurnDurationMs: MIN_TURN_MS,
    ...overrides,
  }
}

test('turn/end reason.kind 映射到六分类', () => {
  assert.equal(mapEventToCategory('turn/end', { reason: { kind: 'completed' } }), CATEGORY_DONE)
  assert.equal(mapEventToCategory('turn/end', { reason: { kind: 'error' } }), CATEGORY_ERROR)
  assert.equal(mapEventToCategory('turn/end', { reason: { kind: 'aborted' } }), CATEGORY_ERROR)
  assert.equal(mapEventToCategory('turn/end', { reason: { kind: 'interrupted' } }), 'interrupted')
  assert.equal(mapEventToCategory('turn/end', { reason: { kind: 'blocked' } }), CATEGORY_APPROVAL)
  assert.equal(mapEventToCategory('turn/end', { reason: { kind: 'max-tokens' } }), 'max-tokens')
})

test('非回合结束事件仅 ask_user_question tool/call 命中提问分类', () => {
  assert.equal(mapEventToCategory('tool/call', { name: 'ask_user_question' }), CATEGORY_ASK)
  assert.equal(mapEventToCategory('tool/call', { name: 'bash' }), null)
  assert.equal(mapEventToCategory('assistant/chunk', {}), null)
  assert.equal(mapEventToCategory('turn/start', {}), null)
})

test('rootsOnly 按子代理会话过滤', () => {
  const subByOrigin = { origin: 'subagent' }
  const subByDepth = { delegationDepth: 1 }
  const top = { delegationDepth: 0 }
  assert.equal(isSubagent(subByOrigin), true)
  assert.equal(isSubagent(subByDepth), true)
  assert.equal(isSubagent(top), false)
  assert.equal(isSubagent({}), false)
  const settings = baseSettings()
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10, settings, header: subByOrigin,
  }), false)
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10, settings, header: top,
  }), true)
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings: baseSettings({ rootsOnly: false }), header: subByDepth,
  }), true)
})

test('碎轮过滤仅作用于 turn/end 类', () => {
  const settings = baseSettings()
  const top = {}
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS - 1, settings, header: top,
  }), false)
  assert.equal(shouldNotify({
    category: CATEGORY_ERROR, kind: 'turn/end', durationMs: MIN_TURN_MS - 1, settings, header: top,
  }), false)
  assert.equal(shouldNotify({
    category: CATEGORY_APPROVAL, kind: 'approval/request', durationMs: null, settings, header: top,
  }), true)
  assert.equal(shouldNotify({
    category: CATEGORY_ASK, kind: 'tool/call', durationMs: null, settings, header: top,
  }), true)
})

test('分类开关关闭即不通知', () => {
  const settings = baseSettings({ enabled: { [CATEGORY_ERROR]: false } })
  const full = baseSettings()
  assert.equal(shouldNotify({
    category: CATEGORY_ERROR, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings: { ...settings, enabled: { ...full.enabled, [CATEGORY_ERROR]: false } }, header: {},
  }), false)
})

test('子代理回执静默:唤醒回合 completed 不通知,其余分类与开关关闭不受影响', () => {
  const now = 1_000_000
  const windowMs = SUBAGENT_WAKE_WINDOW_MS
  const settings = baseSettings()
  // 唤醒判定:父会话回合开始时刻落在子代理结束后窗口内,恰等边界含
  assert.equal(isSubagentWakeTurn({ childDoneAt: now - windowMs, turnStartMs: now }), true)
  assert.equal(isSubagentWakeTurn({ childDoneAt: now, turnStartMs: now }), true)
  assert.equal(isSubagentWakeTurn({ childDoneAt: now - windowMs - 1, turnStartMs: now }), false)
  assert.equal(isSubagentWakeTurn({ childDoneAt: now + 1, turnStartMs: now }), false)
  assert.equal(isSubagentWakeTurn({ childDoneAt: null, turnStartMs: now }), false)
  // 唤醒回合 completed + 开关开 → 抑制
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings, header: {}, wakeTurn: true,
  }), false)
  // 开关关 → 通知
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings: baseSettings({ suppressSubagentWake: false }), header: {}, wakeTurn: true,
  }), true)
  // 非唤醒回合 → 正常通知(不误伤)
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings, header: {}, wakeTurn: false,
  }), true)
  // 唤醒回合但异常分类 → 仍通知
  assert.equal(shouldNotify({
    category: CATEGORY_ERROR, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings, header: {}, wakeTurn: true,
  }), true)
})

test('投影环形容量与过期清理', () => {
  const capacity = 20
  const ttlMs = 60 * 1000
  let now = 1000
  const projection = createProjection({ capacity, ttlMs, now: () => now })
  for (let index = 0; index < capacity + 3; index += 1) {
    projection.push({ id: 'e' + index, category: CATEGORY_DONE, ts: now })
  }
  let listed = projection.list()
  assert.equal(listed.length, capacity)
  assert.equal(listed[0].id, 'e3')
  now += ttlMs + 1
  listed = projection.list()
  assert.equal(listed.length, 0)
})

test('认领状态机:无锁认领 / 他锁跳过 / 过期接管 / 完成标记终态', () => {
  const lockTtlMs = 30 * 1000
  const t0 = 1000
  assert.equal(decideClaim({ stored: null, done: null, now: t0, windowId: 'w1', lockTtlMs }), 'claim')
  assert.equal(decideClaim({ stored: JSON.stringify({ wid: 'w2', at: t0 }), done: null, now: t0 + lockTtlMs - 1, windowId: 'w1', lockTtlMs }), 'skip')
  assert.equal(decideClaim({ stored: JSON.stringify({ wid: 'w1', at: t0 }), done: null, now: t0 + lockTtlMs - 1, windowId: 'w1', lockTtlMs }), 'claim')
  assert.equal(decideClaim({ stored: JSON.stringify({ wid: 'w2', at: t0 }), done: null, now: t0 + lockTtlMs + 1, windowId: 'w1', lockTtlMs }), 'takeover')
  assert.equal(decideClaim({ stored: null, done: '1', now: t0, windowId: 'w1', lockTtlMs }), 'done')
  assert.equal(decideClaim({ stored: 'not-json', done: null, now: t0, windowId: 'w1', lockTtlMs }), 'takeover')
})

test('发声通道判定:聚焦静默压声音与系统弹窗,页内提示与系统弹窗独立开关', () => {
  const base = { hasFocus: false, permission: 'granted' }
  assert.deepEqual(chooseChannels(base), { toast: true, sound: true, system: true, blink: false })
  // 聚焦静默:仅页内提示
  assert.deepEqual(chooseChannels({ ...base, hasFocus: true }), { toast: true, sound: false, system: false, blink: false })
  // 聚焦静默可关:聚焦窗口照常发声
  assert.deepEqual(chooseChannels({ ...base, hasFocus: true, focusQuiet: false }).sound, true)
  // 页内提示独立关闭
  assert.deepEqual(chooseChannels({ ...base, toastEnabled: false }).toast, false)
  // 系统弹窗独立关闭:不弹不闪
  assert.deepEqual(chooseChannels({ ...base, systemEnabled: false }), { toast: true, sound: true, system: false, blink: false })
  // 想弹未授权:降级闪烁
  assert.deepEqual(chooseChannels({ ...base, permission: 'default' }), { toast: true, sound: true, system: false, blink: true })
  assert.deepEqual(chooseChannels({ ...base, permission: 'denied' }).blink, true)
  // 关闭系统弹窗后未授权不再闪
  assert.deepEqual(chooseChannels({ ...base, permission: 'denied', systemEnabled: false }).blink, false)
})

test('webhook payload 字段映射', () => {
  const unit = buildUnit({
    id: 'n1', category: CATEGORY_DONE, status: 'completed',
    sessionTitle: '修复登录', workspace: '/repo', durationMs: 12 * 1000, ts: 1234,
  })
  const payload = buildWebhookPayload(unit)
  assert.deepEqual(payload, {
    text: payload.text,
    event: 'n1',
    category: CATEGORY_DONE,
    status: 'completed',
    session: '修复登录',
    workspace: '/repo',
    durationMs: 12 * 1000,
    ts: 1234,
  })
  assert.ok(payload.text.includes('修复登录'))
})

test('音效映射:自定义命中用自定义,内置备选与失效回落', () => {
  const mapping = { [CATEGORY_ERROR]: 'snd-9', [CATEGORY_DONE]: TONE_BELL, [CATEGORY_ASK]: 'gone' }
  assert.deepEqual(resolveSound({ category: CATEGORY_ERROR, mapping, uploadedIds: ['snd-9'] }), { kind: 'custom', id: 'snd-9' })
  assert.deepEqual(resolveSound({ category: CATEGORY_DONE, mapping, uploadedIds: [] }), { kind: 'builtin', name: TONE_BELL })
  const fallback = resolveSound({ category: CATEGORY_ASK, mapping, uploadedIds: [] })
  assert.equal(fallback.kind, 'builtin')
  assert.notEqual(fallback.name, 'gone')
  assert.deepEqual(resolveSound({ category: CATEGORY_DONE, mapping: {}, uploadedIds: [] }), { kind: 'builtin', name: TONE_UP_ARPEGGIO })
})

test('删除被引用音效后映射回落', () => {
  const mapping = pruneMapping({ [CATEGORY_DONE]: 'a', [CATEGORY_ERROR]: 'b' }, 'a')
  assert.equal(mapping[CATEGORY_DONE], undefined)
  assert.equal(mapping[CATEGORY_ERROR], 'b')
})

test('重命名映射:引用随新名迁移,无关分类保留', () => {
  const mapping = renameMapping({ [CATEGORY_DONE]: 'old', [CATEGORY_ERROR]: 'other', [CATEGORY_ASK]: 'old' }, 'old', 'new')
  assert.equal(mapping[CATEGORY_DONE], 'new')
  assert.equal(mapping[CATEGORY_ERROR], 'other')
  assert.equal(mapping[CATEGORY_ASK], 'new')
})

test('音量解析:未设置回默认,显式零保留,非法回落默认', () => {
  assert.equal(parseVolume(null), DEFAULT_VOLUME)
  assert.equal(parseVolume(undefined), DEFAULT_VOLUME)
  assert.equal(parseVolume('0'), 0)
  assert.equal(parseVolume('0.5'), 0.5)
  assert.equal(parseVolume('1'), 1)
  assert.equal(parseVolume('abc'), DEFAULT_VOLUME)
  assert.equal(parseVolume('2'), DEFAULT_VOLUME)
  assert.equal(parseVolume('-1'), DEFAULT_VOLUME)
})

test('音效名校验:合法名通过并归一化,非法名拒绝', () => {
  assert.deepEqual(validateSoundName('  提示音甲 '), { ok: true, name: '提示音甲' })
  assert.equal(validateSoundName('bell').ok, false)
  assert.equal(validateSoundName('').ok, false)
  assert.equal(validateSoundName('   ').ok, false)
  assert.equal(validateSoundName('a/b').ok, false)
  assert.equal(validateSoundName('a\\b').ok, false)
  assert.equal(validateSoundName('a.b').ok, false)
  assert.equal(validateSoundName('a:b').ok, false)
  assert.equal(validateSoundName('a*b').ok, false)
  assert.equal(validateSoundName('a?b').ok, false)
  assert.equal(validateSoundName('a"b').ok, false)
  assert.equal(validateSoundName('a<b').ok, false)
  assert.equal(validateSoundName('a>b').ok, false)
  assert.equal(validateSoundName('a|b').ok, false)
  assert.equal(validateSoundName('a\u0000b').ok, false)
  assert.equal(validateSoundName('长'.repeat(SOUND_NAME_MAX_CHARS + 1)).ok, false)
  assert.equal(validateSoundName('长'.repeat(SOUND_NAME_MAX_CHARS)).ok, true)
})

test('上传校验:扩展名 / 单文件上限 / 总量上限', () => {
  const fileMax = 2 * 1024 * 1024
  const totalMax = 10 * 1024 * 1024
  assert.equal(validateUpload({ filename: 'a.MP3', size: fileMax, totalBytes: 0 }).ok, true)
  assert.equal(validateUpload({ filename: 'a.txt', size: 1, totalBytes: 0 }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: fileMax + 1, totalBytes: 0 }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: 1, totalBytes: totalMax }).ok, false)
})

test('标题提取:首个用户文本并截断', () => {
  const events = [
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我修复登录页面的崩溃问题' }] } },
  ]
  const long = '长'.repeat(200)
  const eventsLong = [
    { type: 'user/message', data: { content: [{ type: 'text', text: long }] } },
  ]
  assert.equal(sessionTitle(events), '帮我修复登录页面的崩溃问题')
  assert.equal(sessionTitle(eventsLong).length, 60)
  assert.equal(sessionTitle([]), null)
})

test('审批观察器 next() 立即放行且只通知一次', () => {
  const notified = []
  const scheduled = []
  const tap = createApprovalTap((unit) => { notified.push(unit) }, (fn) => { scheduled.push(fn) })
  let nextCalled = 0
  const returned = tap({ toolName: 'bash' }, () => { nextCalled += 1; return 'next-result' })
  assert.equal(nextCalled, 1)
  assert.equal(returned, 'next-result')
  assert.equal(notified.length, 0)
  for (const fn of scheduled) fn()
  assert.equal(notified.length, 1)
  assert.equal(notified[0].category, CATEGORY_APPROVAL)
})

test('webhook 发送吞错不抛出', async () => {
  const calls = []
  const failing = async () => { calls.push(1); throw new Error('unreachable') }
  await assert.doesNotReject(() => sendWebhook({ url: 'https://hook.example', payload: { text: 'x' }, fetchImpl: failing }))
  assert.equal(calls.length, 1)
  const ok = async () => ({ ok: true })
  await assert.doesNotReject(() => sendWebhook({ url: '', payload: { text: 'x' }, fetchImpl: ok }))
})

test('webhook 发送返回真实投递结果', async () => {
  const delivered = async () => ({ ok: true, status: 200 })
  assert.deepEqual(
    await sendWebhook({ url: ' https://hook.example ', payload: { text: 'x' }, fetchImpl: delivered }),
    { ok: true, detail: 'HTTP 200' },
  )
  const rejected = async () => ({ ok: false, status: 500 })
  assert.deepEqual(
    await sendWebhook({ url: 'https://hook.example', payload: { text: 'x' }, fetchImpl: rejected }),
    { ok: false, detail: 'HTTP 500' },
  )
  const failing = async () => { throw new Error('unreachable') }
  assert.deepEqual(
    await sendWebhook({ url: 'https://hook.example', payload: { text: 'x' }, fetchImpl: failing }),
    { ok: false, detail: 'unreachable' },
  )
  let called = 0
  const probe = async () => { called += 1; return { ok: true, status: 200 } }
  assert.deepEqual(
    await sendWebhook({ url: '   ', payload: { text: 'x' }, fetchImpl: probe }),
    { ok: false, detail: '未配置 webhook' },
  )
  assert.equal(called, 0)
})

test('配置补丁校验:合法整补丁与部分补丁放行并归一化', () => {
  const full = validateConfigPatch({
    webhookUrl: ' https://hook.example ',
    minTurnDurationMs: 1500,
    rootsOnly: false,
    suppressSubagentWake: false,
    enabled: { completed: false, error: true },
  })
  assert.equal(full.ok, true)
  assert.deepEqual(full.patch, {
    webhookUrl: 'https://hook.example',
    minTurnDurationMs: 1500,
    rootsOnly: false,
    suppressSubagentWake: false,
    enabled: { completed: false, error: true },
  })
  assert.deepEqual(validateConfigPatch({ webhookUrl: '' }), { ok: true, patch: { webhookUrl: '' } })
  assert.deepEqual(validateConfigPatch({ rootsOnly: true }), { ok: true, patch: { rootsOnly: true } })
  assert.deepEqual(validateConfigPatch({ suppressSubagentWake: true }), { ok: true, patch: { suppressSubagentWake: true } })
  assert.deepEqual(validateConfigPatch({}), { ok: true, patch: {} })
})

test('配置补丁校验:非法输入逐类拒绝', () => {
  assert.equal(validateConfigPatch(null).ok, false)
  assert.equal(validateConfigPatch('x').ok, false)
  assert.equal(validateConfigPatch({ other: 1 }).ok, false)
  assert.equal(validateConfigPatch({ webhookUrl: 123 }).ok, false)
  assert.equal(validateConfigPatch({ webhookUrl: 'ftp://hook.example' }).ok, false)
  assert.equal(validateConfigPatch({ webhookUrl: 'not a url' }).ok, false)
  assert.equal(validateConfigPatch({ minTurnDurationMs: -1 }).ok, false)
  assert.equal(validateConfigPatch({ minTurnDurationMs: 1.5 }).ok, false)
  assert.equal(validateConfigPatch({ minTurnDurationMs: 'fast' }).ok, false)
  assert.equal(validateConfigPatch({ rootsOnly: 'yes' }).ok, false)
  assert.equal(validateConfigPatch({ suppressSubagentWake: 'yes' }).ok, false)
  assert.equal(validateConfigPatch({ enabled: { unknown: true } }).ok, false)
  assert.equal(validateConfigPatch({ enabled: { completed: 'no' } }).ok, false)
  assert.equal(validateConfigPatch({ enabled: [true] }).ok, false)
})

test('配置解析:enabled 缺省键按开补全,字段类型回退默认', () => {
  assert.deepEqual(
    resolvedConfig({ webhookUrl: 'https://hook.example', enabled: { completed: false }, soundMapping: { completed: 'snd-1' } }),
    {
      webhookUrl: 'https://hook.example',
      minTurnDurationMs: MIN_TURN_MS,
      rootsOnly: true,
      suppressSubagentWake: true,
      enabled: { completed: false, error: true, interrupted: true, approval: true, ask: true, 'max-tokens': true },
      soundMapping: { completed: 'snd-1' },
    },
  )
  assert.deepEqual(resolvedConfig({}), {
    webhookUrl: '',
    minTurnDurationMs: MIN_TURN_MS,
    rootsOnly: true,
    suppressSubagentWake: true,
    enabled: Object.fromEntries(CATEGORIES.map((name) => [name, true])),
    soundMapping: {},
  })
  assert.equal(resolvedConfig({ minTurnDurationMs: Number.NaN }).minTurnDurationMs, MIN_TURN_MS)
  assert.equal(resolvedConfig({ suppressSubagentWake: false }).suppressSubagentWake, false)
})

test('面板可见配置:webhookUrl 不出主机,仅回是否已配置', () => {
  assert.deepEqual(
    publicConfig({ webhookUrl: 'https://hook.example/service/xxx', enabled: { completed: false }, soundMapping: { completed: 'snd-1' } }),
    {
      minTurnDurationMs: MIN_TURN_MS,
      rootsOnly: true,
      suppressSubagentWake: true,
      enabled: { completed: false, error: true, interrupted: true, approval: true, ask: true, 'max-tokens': true },
      soundMapping: { completed: 'snd-1' },
      webhookConfigured: true,
    },
  )
  assert.equal(publicConfig({}).webhookConfigured, false)
  assert.equal(publicConfig({ webhookUrl: '   ' }).webhookConfigured, false)
  assert.equal('webhookUrl' in publicConfig({ webhookUrl: 'https://hook.example' }), false)
})

test('会话事件有界累积:标题提取后封账,内存不再增长', () => {
  const store = new Map()
  const titled = new Set()
  const sessionId = 's1'
  const userEvent = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
  collectSessionEvents(store, titled, sessionId, userEvent('第一句'))
  assert.equal(titled.has(sessionId), true)
  const sizeAfterTitle = store.get(sessionId).length
  for (let index = 0; index < 100; index += 1) {
    collectSessionEvents(store, titled, sessionId, userEvent('追加 ' + index))
  }
  assert.equal(store.get(sessionId).length, sizeAfterTitle)
  // 非用户消息事件不入库
  collectSessionEvents(store, titled, sessionId, { type: 'turn/start', data: {} })
  assert.equal(store.get(sessionId).length, sizeAfterTitle)
  // 未提取到标题的会话继续累积
  collectSessionEvents(store, titled, 's2', { type: 'user/message', data: { content: [{ type: 'text', text: ' ' }] } })
  collectSessionEvents(store, titled, 's2', userEvent('正式内容'))
  assert.equal(store.get('s2').length, 2)
})

test('映射路由 id 校验:空串放行,仅收已上传 id 与内置音名', () => {
  assert.equal(validateMappingId('', []), true)
  assert.equal(validateMappingId('snd-1', ['snd-1']), true)
  assert.equal(validateMappingId(TONE_BELL, []), true)
  assert.equal(validateMappingId('gone', ['snd-1']), false)
  assert.equal(validateMappingId('gone', []), false)
})

test('readRawBody 超限 reject 并断流', async () => {
  const req = new EventEmitter()
  req.destroy = () => { req.destroyed = true }
  const pending = readRawBody(req, 8)
  req.emit('data', Buffer.alloc(4))
  req.emit('data', Buffer.alloc(4))
  req.emit('data', Buffer.alloc(4))
  await assert.rejects(() => pending, /超过上限/)
  assert.equal(req.destroyed, true)
})

test('readRawBody 连接中断 close 兜底 reject', async () => {
  const req = new EventEmitter()
  req.destroy = () => {}
  req.readableEnded = false
  const pending = readRawBody(req, 1024)
  req.emit('close')
  await assert.rejects(() => pending, /中断/)
})

test('readRawBody 正常聚合', async () => {
  const req = new EventEmitter()
  req.destroy = () => {}
  req.readableEnded = false
  const pending = readRawBody(req, 1024)
  req.emit('data', Buffer.from('ab'))
  req.emit('data', Buffer.from('cd'))
  req.readableEnded = true
  req.emit('end')
  assert.equal((await pending).toString('utf8'), 'abcd')
})
