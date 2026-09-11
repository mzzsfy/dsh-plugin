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
  buildSummary,
  collectAssistantTail,
  normalizeKindRoutes,
  unitRoutes,
  createProjection,
  decideClaim,
  chooseChannels,
  USER_IDLE_AWAY_MS,
  resolveSound,
  mergeMapping,
  deadCustomIds,
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
  storedSessionTitle,
  SESSION_EVENTS_MAX,
  pruneTimestamps,
  TITLE_MAX_CHARS,
  readRawBody,
  sessionTitle,
  createApprovalTap,
  sendWebhook,
  TONE_BELL,
  TONE_UP_ARPEGGIO,
  TONE_DOUBLE_PING,
  MIME_BY_EXT,
  mimeOf,
} from '../src/core.mjs'
import { EventEmitter } from 'node:events'

const MIN_TURN_MS = 5 * 1000

test('validateConfigPatch 拒绝非法 imTargets:非数组/超上限/重复/字符集与字段形态', () => {
  const idMax = 'x'.repeat(128)
  const cases = [
    { imTargets: 'nope' },
    { imTargets: [{ botId: 'wx_a', targetId: 't', extra: 1 }] },
    { imTargets: [{ botId: 'wx a', targetId: 't' }] },
    { imTargets: [{ botId: 'wx_a', targetId: 't;' }] },
    { imTargets: [{ botId: 'wx_a' + 'x'.repeat(128), targetId: 't' }] },
    { imTargets: [{ botId: 'wx_a', targetId: idMax + 'x' }] },
    { imTargets: [{ botId: 123, targetId: 't' }] },
    { imTargets: [{ botId: 'wx_a', targetId: 't' }, { botId: 'wx_a', targetId: 't' }] },
    { imTargets: Array.from({ length: 17 }, (_, i) => ({ botId: 'wx_' + i, targetId: 't' })) },
    { imTargets: [['wx_a', 't']] },
    { imTargets: [{ botId: '   ', targetId: 't' }] },
  ]
  for (const patch of cases) {
    const verdict = validateConfigPatch(patch)
    assert.equal(verdict.ok, false, '应拒绝: ' + JSON.stringify(patch))
  }
  // 边界值合法:128 字符 ID、恰好 16 项目标、targetId 全部合法字符
  assert.equal(validateConfigPatch({ imTargets: [{ botId: idMax, targetId: 'x'.repeat(123) + '._:@-' }] }).ok, true)
  assert.equal(validateConfigPatch({ imTargets: Array.from({ length: 16 }, (_, i) => ({ botId: 'wx_' + i, targetId: 't' })) }).ok, true)
})

test('resolvedConfig 缺省与脏数据归一化 imTargets', () => {
  assert.deepEqual(resolvedConfig({}).imTargets, [])
  assert.deepEqual(resolvedConfig({ imTargets: 'junk' }).imTargets, [])
  assert.deepEqual(resolvedConfig({ imTargets: [{ botId: 'a', targetId: 'b', extra: 1 }, null, { botId: 2, targetId: 'x' }, { botId: 'c', targetId: 'd' }] }).imTargets,
    [{ botId: 'a', targetId: 'b' }, { botId: 'c', targetId: 'd' }])
})

test('publicConfig 回显 imTargets', () => {
  const config = publicConfig({ imTargets: [{ botId: 'wx_a', targetId: 'owner' }] })
  assert.deepEqual(config.imTargets, [{ botId: 'wx_a', targetId: 'owner' }])
  assert.deepEqual(publicConfig({}).imTargets, [])
})

test('validateConfigPatch 接受合法 imTargets 并归一化 trim 且保持顺序', () => {
  const verdict = validateConfigPatch({
    imTargets: [
      { botId: ' wx_abc ', targetId: 'owner' },
      { botId: 'wx_def', targetId: 'tgt_1234' },
    ],
  })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.patch.imTargets, [
    { botId: 'wx_abc', targetId: 'owner' },
    { botId: 'wx_def', targetId: 'tgt_1234' },
  ])
})

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

test('碎轮过滤仅作用于 turn/end 类,时长恰等边界放行', () => {
  const settings = baseSettings()
  const top = {}
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS - 1, settings, header: top,
  }), false)
  assert.equal(shouldNotify({
    category: CATEGORY_ERROR, kind: 'turn/end', durationMs: MIN_TURN_MS - 1, settings, header: top,
  }), false)
  // 恰等阈值不属碎轮
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS, settings, header: top,
  }), true)
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

test('等待子代理静默:主回合挂起等委托时 completed 不通知,其余分类与开关关闭不受影响', () => {
  const settings = baseSettings()
  // 等待子代理 + completed + 开关开 → 抑制
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings, header: {}, awaitingChildren: true,
  }), false)
  // 开关关 → 通知
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings: baseSettings({ suppressSubagentWake: false }), header: {}, awaitingChildren: true,
  }), true)
  // 无等待 → 正常通知(不误伤)
  assert.equal(shouldNotify({
    category: CATEGORY_DONE, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings, header: {}, awaitingChildren: false,
  }), true)
  // 等待中但异常分类 → 仍通知
  assert.equal(shouldNotify({
    category: CATEGORY_ERROR, kind: 'turn/end', durationMs: MIN_TURN_MS * 10,
    settings, header: {}, awaitingChildren: true,
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

test('投影版本:push 与 bump 各递增,version 读取当前值', () => {
  const projection = createProjection({})
  assert.equal(projection.version(), 0)
  projection.push({ id: 'e1', category: CATEGORY_DONE, ts: 1 })
  assert.equal(projection.version(), 1)
  projection.bump()
  assert.equal(projection.version(), 2)
})

test('投影等待:已有新版本立即返回,落后 cursor 挂起至 push 唤醒', async () => {
  const projection = createProjection({})
  projection.push({ id: 'e1', category: CATEGORY_DONE, ts: 1 })
  // cursor 已落后:立即返回当前版本,不挂起
  assert.equal(await projection.wait(0, 60 * 1000), 1)
  // cursor 追平:挂起,push 后唤醒并返回新版本
  const pending = projection.wait(1, 60 * 1000)
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.equal(settled, false, '未 push 前不应唤醒')
  projection.push({ id: 'e2', category: CATEGORY_DONE, ts: 2 })
  assert.equal(await pending, 2)
})

test('投影等待:超时以当前版本收尾,bump 同样唤醒等待者', async () => {
  const timeoutMs = 10
  const projection = createProjection({})
  const timedOut = projection.wait(0, timeoutMs)
  assert.equal(await timedOut, 0)
  const pending = projection.wait(0, 60 * 1000)
  projection.bump()
  assert.equal(await pending, 1)
})

test('投影停用:dispose 唤醒全部等待者并清空定时器', async () => {
  const projection = createProjection({})
  const first = projection.wait(0, 60 * 1000)
  const second = projection.wait(0, 60 * 1000)
  projection.dispose()
  assert.equal(await first, 0)
  assert.equal(await second, 0)
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
  assert.deepEqual(chooseChannels(base), { toast: true, sound: true, system: true, blink: false, pageSound: false })
  // 聚焦静默:仅页内提示
  assert.deepEqual(chooseChannels({ ...base, hasFocus: true }), { toast: true, sound: false, system: false, blink: false, pageSound: false })
  // 聚焦静默可关:聚焦窗口照常发声
  assert.deepEqual(chooseChannels({ ...base, hasFocus: true, focusQuiet: false }).sound, true)
  // 页内提示独立关闭
  assert.deepEqual(chooseChannels({ ...base, toastEnabled: false }).toast, false)
  // 系统弹窗独立关闭:不弹不闪
  assert.deepEqual(chooseChannels({ ...base, systemEnabled: false }), { toast: true, sound: true, system: false, blink: false, pageSound: false })
  // 想弹未授权:降级闪烁
  assert.deepEqual(chooseChannels({ ...base, permission: 'default' }), { toast: true, sound: true, system: false, blink: true, pageSound: false })
  assert.deepEqual(chooseChannels({ ...base, permission: 'denied' }).blink, true)
  // 关闭系统弹窗后未授权不再闪
  assert.deepEqual(chooseChannels({ ...base, permission: 'denied', systemEnabled: false }).blink, false)
})

test('页内提示音:聚焦补位发声,失焦让位通知声音,页内分类独立配置', () => {
  const base = { hasFocus: false, permission: 'granted', pageSoundEnabled: true }
  // 聚焦静默压制通知声音,页内提示音补位:核心场景
  assert.equal(chooseChannels({ ...base, hasFocus: true }).pageSound, true)
  // 失焦时通知声音已播,页内提示音让位,同一通知至多一声
  assert.equal(chooseChannels(base).pageSound, false)
  // 通知声音总开关关闭:失焦时页内提示音顶上
  assert.equal(chooseChannels({ ...base, soundEnabled: false }).pageSound, true)
  // 页内提示关闭:无卡片即无声
  assert.equal(chooseChannels({ ...base, hasFocus: true, toastEnabled: false }).pageSound, false)
  // 页内分类显式静音:该分类不补位
  assert.equal(chooseChannels({ ...base, hasFocus: true, pageSoundCategories: { ask: false }, category: 'ask' }).pageSound, false)
  // 页内分类静音只压本分类:其他分类照常
  assert.equal(chooseChannels({ ...base, hasFocus: true, pageSoundCategories: { ask: false }, category: 'completed' }).pageSound, true)
  // 提示音分类静音不连带页内提示音:两套分类配置独立
  assert.equal(chooseChannels({ ...base, hasFocus: true, soundCategories: { ask: false }, category: 'ask' }).pageSound, true)
  // 未提供页内分类:全放行(null 与 undefined 等价)
  assert.equal(chooseChannels({ ...base, hasFocus: true, pageSoundCategories: { ask: false } }).pageSound, true)
  // 开关缺省关闭:行为与旧版一致
  assert.equal(chooseChannels({ hasFocus: true, permission: 'granted' }).pageSound, false)
})

test('提示音开关:总开关与分类配置独立静音,缺省键与空分类放行', () => {
  const base = { hasFocus: false, permission: 'granted' }
  // 提示音总开关独立关闭:页内提示与系统弹窗不受影响
  assert.deepEqual(chooseChannels({ ...base, soundEnabled: false }), { toast: true, sound: false, system: true, blink: false, pageSound: false })
  // 分类显式 false:该分类静音
  assert.equal(chooseChannels({ ...base, soundCategories: { ask: false }, category: 'ask' }).sound, false)
  // 同配置其他分类照常出声
  assert.equal(chooseChannels({ ...base, soundCategories: { ask: false }, category: 'completed' }).sound, true)
  // 未提供分类:全放行(与既有调用形态兼容)
  assert.equal(chooseChannels({ ...base, soundCategories: { ask: false } }).sound, true)
  // 分类空缺:null 与 undefined 等价放行
  assert.equal(chooseChannels({ ...base, soundCategories: { ask: false }, category: null }).sound, true)
})

test('用户行动空闲满阈值:聚焦也全通道齐发,活跃时维持聚焦静默', () => {
  const base = { hasFocus: true, permission: 'granted' }
  const idle = USER_IDLE_AWAY_MS
  // 空闲满阈值:离开,聚焦静默不再适用,全通道
  assert.deepEqual(chooseChannels({ ...base, idleMs: idle }), { toast: true, sound: true, system: true, blink: false, pageSound: false })
  // 恰等边界含
  assert.equal(chooseChannels({ ...base, idleMs: idle - 1 }).sound, false)
  // 活跃(刚行动):聚焦静默维持
  assert.equal(chooseChannels({ ...base, idleMs: 0 }).sound, false)
  // 空闲但未聚焦:行为不变
  assert.equal(chooseChannels({ hasFocus: false, permission: 'granted', idleMs: idle }).sound, true)
  // 未提供空闲时长:行为与旧版一致
  assert.deepEqual(chooseChannels(base), { toast: true, sound: false, system: false, blink: false, pageSound: false })
  // 空闲时聚焦静默关闭依旧生效
  assert.equal(chooseChannels({ ...base, idleMs: 0, focusQuiet: false }).sound, true)
})

test('webhook payload 字段映射', () => {
  const unit = buildUnit({
    id: 'n1', category: CATEGORY_DONE, status: 'completed',
    sessionTitle: '修复登录', workspace: '/repo', durationMs: 12 * 1000, ts: 1234,
    tokens: 1500, summary: '耗时 12 秒 · 1.5k tokens · 已修复',
  })
  const payload = buildWebhookPayload(unit)
  assert.deepEqual(payload, {
    text: '[dsh] 任务完成: 修复登录',
    summary: '耗时 12 秒 · 1.5k tokens · 已修复',
    event: 'n1',
    category: CATEGORY_DONE,
    status: 'completed',
    session: '修复登录',
    workspace: '/repo',
    durationMs: 12 * 1000,
    tokens: 1500,
    ts: 1234,
  })
})

test('通知统计与降级小结:buildSummary 组装与空缺归 null', () => {
  assert.equal(buildSummary({ durationMs: null, tokens: null, prefix: null }), null)
  assert.equal(buildSummary({ durationMs: 5200, tokens: 0, prefix: '' }), '耗时 5 秒')
  assert.equal(buildSummary({ durationMs: 800, tokens: null, prefix: null }), '耗时 800 毫秒')
  assert.equal(buildSummary({ durationMs: null, tokens: 940, prefix: null }), '940 tokens')
  assert.equal(buildSummary({ durationMs: null, tokens: 123456, prefix: null }), '123k tokens')
  assert.equal(
    buildSummary({ durationMs: 65 * 1000, tokens: 45, prefix: '已修复崩溃' }),
    '耗时 65 秒 · 45 tokens · 已修复崩溃',
  )
  // 前缀纯空白按缺省处理
  assert.equal(buildSummary({ durationMs: null, tokens: null, prefix: '   ' }), null)
})

test('collectAssistantTail:tokens 累加,回答前缀后到覆盖,usage 缺失不减不崩', () => {
  const tail = new Map()
  const first = collectAssistantTail(tail, 's1', {
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 },
    message: { content: [{ type: 'text', text: '  第一段回答  ' }] },
  })
  assert.deepEqual(first, { tokens: 160, prefix: '第一段回答' })
  const second = collectAssistantTail(tail, 's1', {
    usage: { inputTokens: 20, outputTokens: 30 },
    message: { content: [{ type: 'text', text: '最终回答' }] },
  })
  assert.deepEqual(second, { tokens: 210, prefix: '最终回答' })
  // 无 usage 无文本:tokens 保留,前缀保留
  const third = collectAssistantTail(tail, 's1', { message: { content: [{ type: 'image' }] } })
  assert.deepEqual(third, { tokens: 210, prefix: '最终回答' })
  // 畸形数据不崩
  const fourth = collectAssistantTail(tail, 's1', null)
  assert.deepEqual(fourth, { tokens: 210, prefix: '最终回答' })
  // 长前缀按码点截断
  const long = '好'.repeat(120)
  collectAssistantTail(new Map(), 's2', { message: { content: [{ type: 'text', text: long }] } })
  const cut = collectAssistantTail(new Map(), 's2', { message: { content: [{ type: 'text', text: long }] } })
  assert.equal(Array.from(cut.prefix).length, 80)
})

test('kindRoutes 归一化:非法剔除合法保留,去重保序,写侧宽松读侧剔除', () => {
  assert.deepEqual(normalizeKindRoutes(undefined), { ok: true, routes: {} })
  assert.deepEqual(normalizeKindRoutes(null), { ok: true, routes: {} })
  assert.deepEqual(normalizeKindRoutes('x'), { ok: true, routes: {} })
  assert.deepEqual(normalizeKindRoutes({ bogus: ['sound'] }), { ok: true, routes: {} }, '未知分类条目剔除')
  assert.deepEqual(normalizeKindRoutes({ completed: 'sound' }), { ok: true, routes: {} }, '形态非法条目剔除')
  const merged = normalizeKindRoutes({
    completed: ['webhook', 'sound', 'webhook', 'sms'],
    error: [],
    bogus: ['sound'],
  })
  assert.deepEqual(merged, { ok: true, routes: { completed: ['webhook', 'sound'], error: [] } }, '未知通道剔除,合法去重保序,空名单=全禁')
  // 空数组 = 全禁(显式配置),与缺省键(全放行)可区分
  assert.deepEqual(unitRoutes({ completed: [] }, 'completed'), [])
  assert.deepEqual(unitRoutes({ completed: ['webhook'] }, 'error'), null)
  assert.deepEqual(unitRoutes(null, 'completed'), null)
  // 写侧经 validateConfigPatch 归一后写入
  const verdict = validateConfigPatch({ kindRoutes: { completed: ['webhook'] } })
  assert.deepEqual(verdict, { ok: true, patch: { kindRoutes: { completed: ['webhook'] } } })
})

test('音效映射:自定义命中用自定义,内置备选与失效回落', () => {
  const mapping = { [CATEGORY_ERROR]: 'snd-9', [CATEGORY_DONE]: TONE_BELL, [CATEGORY_ASK]: 'gone' }
  assert.deepEqual(resolveSound({ category: CATEGORY_ERROR, mapping, uploadedIds: ['snd-9'] }), { kind: 'custom', id: 'snd-9' })
  assert.deepEqual(resolveSound({ category: CATEGORY_DONE, mapping, uploadedIds: [] }), { kind: 'builtin', name: TONE_BELL })
  const fallback = resolveSound({ category: CATEGORY_ASK, mapping, uploadedIds: [] })
  assert.deepEqual(fallback, { kind: 'builtin', name: TONE_DOUBLE_PING })
  assert.deepEqual(resolveSound({ category: CATEGORY_DONE, mapping: {}, uploadedIds: [] }), { kind: 'builtin', name: TONE_UP_ARPEGGIO })
})

test('映射合并:本地覆盖全局,缺键回落,空串为显式内置默认,入参容错', () => {
  assert.deepEqual(mergeMapping({ completed: 'a', error: 'b' }, { completed: 'c' }), { completed: 'c', error: 'b' })
  assert.deepEqual(mergeMapping({ completed: 'a' }, {}), { completed: 'a' })
  assert.deepEqual(mergeMapping({ completed: 'a' }, { completed: '' }), { completed: '' })
  assert.deepEqual(mergeMapping(null, { completed: 'a' }), { completed: 'a' })
  assert.deepEqual(mergeMapping({ completed: 'a' }, null), { completed: 'a' })
  assert.deepEqual(mergeMapping(undefined, undefined), {})
  const globalMapping = { completed: 'a' }
  assert.deepEqual(mergeMapping(globalMapping, { completed: 'b' }), { completed: 'b' })
  assert.deepEqual(globalMapping, { completed: 'a' })
})

test('死链识别:非内置非上传即死链,去重按首次出现排序,空值与非字符串跳过,列表空缺容错', () => {
  const mapping = { completed: 'gone-2', error: TONE_BELL, interrupted: 'gone-1', approval: '', ask: 'gone-2', 'max-tokens': 'snd-1' }
  assert.deepEqual(deadCustomIds(mapping, ['snd-1']), ['gone-2', 'gone-1'])
  assert.deepEqual(deadCustomIds({ completed: TONE_BELL }, []), [])
  assert.deepEqual(deadCustomIds({ completed: 'snd-1' }, ['snd-1']), [])
  assert.deepEqual(deadCustomIds({}, ['snd-1']), [])
  assert.deepEqual(deadCustomIds(null, []), [])
  assert.deepEqual(deadCustomIds({ completed: 7, error: null, ask: { id: 'x' } }, ['snd-1']), [])
  assert.deepEqual(deadCustomIds({ completed: 'gone-1' }, null), ['gone-1'])
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

test('上传校验:扩展名 / 单文件上限 / 总量上限 / 零与负体拒绝 / 总量恰等放行', () => {
  const fileMax = 2 * 1024 * 1024
  const totalMax = 10 * 1024 * 1024
  assert.equal(validateUpload({ filename: 'a.MP3', size: fileMax, totalBytes: 0 }).ok, true)
  assert.equal(validateUpload({ filename: 'a.txt', size: 1, totalBytes: 0 }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: fileMax + 1, totalBytes: 0 }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: 1, totalBytes: totalMax }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: 0, totalBytes: 0 }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: -1, totalBytes: 0 }).ok, false)
  assert.equal(validateUpload({ filename: 'a.mp3', size: fileMax, totalBytes: totalMax - fileMax }).ok, true)
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
  assert.equal(sessionTitle(eventsLong).length, TITLE_MAX_CHARS)
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

test('webhook 非 Error 抛出物以字符串形式回填 detail', async () => {
  const throwingString = async () => { throw 'boom' }
  assert.deepEqual(
    await sendWebhook({ url: 'https://hook.example', payload: { text: 'x' }, fetchImpl: throwingString }),
    { ok: false, detail: 'boom' },
  )
})

test('MIME 映射:扩展名一比一对应,未知扩展回退通用类型', () => {
  assert.deepEqual(MIME_BY_EXT, { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' })
  assert.equal(mimeOf('wav'), 'audio/wav')
  assert.equal(mimeOf('mp3'), 'audio/mpeg')
  assert.equal(mimeOf('ogg'), 'audio/ogg')
  assert.equal(mimeOf('txt'), 'application/octet-stream')
  assert.equal(mimeOf(''), 'application/octet-stream')
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
    resolvedConfig({ webhookUrl: 'https://hook.example', enabled: { completed: false }, soundMapping: { completed: 'snd-1' }, kindRoutes: { completed: ['webhook'], bogus: ['sound'] } }),
    {
      webhookUrl: 'https://hook.example',
      minTurnDurationMs: MIN_TURN_MS,
      rootsOnly: true,
      suppressSubagentWake: true,
      enabled: { completed: false, error: true, interrupted: true, approval: true, ask: true, 'max-tokens': true },
      soundMapping: { completed: 'snd-1' },
      imTargets: [],
      kindRoutes: { completed: ['webhook'] },
    },
  )
  assert.deepEqual(resolvedConfig({}), {
    webhookUrl: '',
    minTurnDurationMs: MIN_TURN_MS,
    rootsOnly: true,
    suppressSubagentWake: true,
    enabled: Object.fromEntries(CATEGORIES.map((name) => [name, true])),
    soundMapping: {},
    imTargets: [],
    kindRoutes: {},
  })
  assert.equal(resolvedConfig({ minTurnDurationMs: Number.NaN }).minTurnDurationMs, MIN_TURN_MS)
  assert.equal(resolvedConfig({ suppressSubagentWake: false }).suppressSubagentWake, false)
})

test('面板可见配置:webhookUrl 原文回显', () => {
  assert.deepEqual(
    publicConfig({ webhookUrl: 'https://hook.example/service/xxx', enabled: { completed: false }, soundMapping: { completed: 'snd-1' }, kindRoutes: { ask: ['im'] } }),
    {
      minTurnDurationMs: MIN_TURN_MS,
      rootsOnly: true,
      suppressSubagentWake: true,
      enabled: { completed: false, error: true, interrupted: true, approval: true, ask: true, 'max-tokens': true },
      soundMapping: { completed: 'snd-1' },
      imTargets: [],
      kindRoutes: { ask: ['im'] },
      webhookUrl: 'https://hook.example/service/xxx',
    },
  )
  assert.equal(publicConfig({}).webhookUrl, '')
  // 空白串原样回显,不静默归一
  assert.equal(publicConfig({ webhookUrl: '   ' }).webhookUrl, '   ')
  assert.equal('webhookConfigured' in publicConfig({ webhookUrl: 'https://hook.example' }), false)
})

test('会话事件有界累积:标题提取后封账为字符串,内存不再增长', () => {
  const store = new Map()
  const titled = new Set()
  const sessionId = 's1'
  const userEvent = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
  collectSessionEvents(store, titled, sessionId, userEvent('第一句'))
  assert.equal(titled.has(sessionId), true)
  // 封账后 store 中以标题字符串替代事件数组
  assert.equal(store.get(sessionId), '第一句')
  assert.equal(storedSessionTitle(store, sessionId), '第一句')
  for (let index = 0; index < 100; index += 1) {
    collectSessionEvents(store, titled, sessionId, userEvent('追加 ' + index))
  }
  assert.equal(store.get(sessionId), '第一句')
  // 非用户消息事件不入库
  collectSessionEvents(store, titled, sessionId, { type: 'turn/start', data: {} })
  assert.equal(store.get(sessionId), '第一句')
  // 未提取到标题的会话继续累积,超上限截尾
  collectSessionEvents(store, titled, 's2', { type: 'user/message', data: { content: [{ type: 'text', text: ' ' }] } })
  for (let index = 0; index < SESSION_EVENTS_MAX + 3; index += 1) {
    collectSessionEvents(store, titled, 's2', { type: 'user/message', data: { content: [{ type: 'image' }] } })
  }
  const untitled = store.get('s2')
  assert.equal(Array.isArray(untitled), true)
  assert.equal(untitled.length, SESSION_EVENTS_MAX)
  assert.equal(titled.has('s2'), false)
  assert.equal(storedSessionTitle(store, 's2'), null)
  // 截尾后出现文本:标题提取照常生效并封账
  collectSessionEvents(store, titled, 's2', userEvent('正式内容'))
  assert.equal(titled.has('s2'), true)
  assert.equal(store.get('s2'), '正式内容')
})

test('会话标题读取:未封账数组内含文本时提取,空缺返回 null', () => {
  const store = new Map()
  assert.equal(storedSessionTitle(store, 'none'), null)
  store.set('arr', [{ type: 'user/message', data: { content: [{ type: 'text', text: '数组内标题' }] } }])
  assert.equal(storedSessionTitle(store, 'arr'), '数组内标题')
  store.set('bad', 42)
  assert.equal(storedSessionTitle(store, 'bad'), null)
})

test('会话标题按码点截断:增补平面字符不产生孤立代理项', () => {
  const prefix = 'x'.repeat(TITLE_MAX_CHARS - 1)
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: prefix + '😀😀😀' }] } }]
  const title = sessionTitle(events)
  assert.equal(Array.from(title).length, TITLE_MAX_CHARS)
  for (const unit of title) assert.equal((unit.codePointAt(0) & 0xf800) !== 0xd800, true)
})

test('时间戳惰性回收:超龄条目删除,新鲜与恰等边界保留', () => {
  const map = new Map([['old', 1000], ['fresh', 2000], ['edge', 2000]])
  pruneTimestamps(map, 2000 + SUBAGENT_WAKE_WINDOW_MS, SUBAGENT_WAKE_WINDOW_MS)
  assert.equal(map.has('old'), false)
  assert.equal(map.has('fresh'), true)
  // 恰等阈值不算超龄
  assert.equal(map.has('edge'), true)
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

test('readRawBody error 事件兜底 reject', async () => {
  const req = new EventEmitter()
  req.destroy = () => {}
  const pending = readRawBody(req, 1024)
  req.emit('error', new Error('socket reset'))
  await assert.rejects(() => pending, /socket reset/)
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
