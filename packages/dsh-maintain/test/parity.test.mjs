// parity 测试:client.js 的 LOGIC 标记段与 core.mjs 同源函数对拍,
// 数据镜像常量(默认值/VERDICT/API 路径/窗口关系)与 host 侧组合值对照。
// client 半区无法 import ESM,按 LOGIC 标记提取源码文本后工厂化执行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  shouldReloadAfterRestart as coreShouldReload,
  isValidRegistryBase as coreIsValidRegistryBase,
  VERDICT_OUTDATED,
  VERDICT_UP_TO_DATE,
  VERDICT_UNKNOWN,
  TARGET_PACKAGE,
  RELEASE_REPO,
} from '../src/core.mjs'
import { clientSource, extractLogic } from './logic-extract.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
void PKG_ROOT
const CLIENT_SOURCE = clientSource()

function extractConst(name) {
  // 行首锚定 + 全局扫描唯一性:防注释/示例代码中的同名字样静默错抓
  const pattern = new RegExp('^const ' + name + " = '([^']*)'", 'm')
  const all = CLIENT_SOURCE.match(new RegExp(pattern.source, 'gm'))
  assert.ok(all && all.length >= 1, 'client.js 缺少常量: ' + name)
  assert.equal(all.length, 1, 'client.js 常量声明不唯一: ' + name)
  return all[0].match(pattern)[1]
}

function extractNumberConst(name) {
  const pattern = new RegExp('^const ' + name + ' = ([0-9 *]+)$', 'm')
  const all = CLIENT_SOURCE.match(new RegExp(pattern.source, 'gm'))
  assert.ok(all && all.length >= 1, 'client.js 缺少常量: ' + name)
  assert.equal(all.length, 1, 'client.js 常量声明不唯一: ' + name)
  return eval(all[0].match(pattern)[1])
}

const clientShouldReload = extractLogic('shouldReloadAfterRestart')
const clientIsValidRegistryBase = extractLogic('isValidRegistryBase')
const clientInstallDisabled = extractLogic('installDisabled')
// 弹窗文案分支:直接注 core VERDICT 常量,证明文案语义与 host 判定同源
const clientBuildInstallChangeLine = extractLogic('buildInstallChangeLine', {
  VERDICT_OUTDATED,
  VERDICT_UNKNOWN,
})
const clientHasPluginUpgradeFailure = extractLogic('hasPluginUpgradeFailure')
const clientUpgradeResultKind = extractLogic('upgradeResultKind', { hasPluginUpgradeFailure: clientHasPluginUpgradeFailure })
const clientUpgradeFinalText = extractLogic('upgradeFinalText', {
  upgradeResultKind: clientUpgradeResultKind,
  hasPluginUpgradeFailure: clientHasPluginUpgradeFailure,
})
const clientUpgradePhaseLabel = extractLogic('upgradePhaseLabel')

// 弹窗版本变更行:目标=通道最新精确版本,按 未知/重装/升级/无法判定/回退 分支
test('升级弹窗提供可展开的救援命令说明', () => {
  assert.match(CLIENT_SOURCE, /status\.rescueCommand/)
  const dialog = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function UpgradeDialog('), CLIENT_SOURCE.indexOf('// release 正文'))
  assert.match(dialog, /h\('details', \{ className: 'dm-details' \},\s*h\('summary', null, '展开救援说明'/)
  assert.match(dialog, /修复原 profile/)
  assert.match(dialog, /post\(PREFLIGHT_URL, \{ targetVersion: status\.channelLatest \}\)/)
  assert.match(dialog, /点击「开始安装」后.*更新.*rescue\.txt/)
  assert.doesNotMatch(dialog, /rescueGuideWritten/)
  assert.match(dialog, /先在宿主终端将 DSH_HOME 设为/)
  assert.match(dialog, /命令会清除同名救援 profile/)
  assert.match(dialog, /DSH_HOME/)
})

test('parity: buildInstallChangeLine 分支行为', () => {
  const base = { channel: 'latest', channelLatest: null, runningVersion: null, installedVersion: null, verdict: VERDICT_UNKNOWN }
  // 通道目标未知:提示先检查更新,不表述目标
  assert.ok(clientBuildInstallChangeLine({ ...base }).includes('未知'))
  // 重装:目标==运行;已装领先(待生效)时提示将被替换
  const reinstall = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.1.5', installedVersion: '0.2.0-rc.1', verdict: VERDICT_UP_TO_DATE })
  assert.ok(reinstall.includes('重装'), reinstall)
  assert.ok(reinstall.includes('0.2.0-rc.1'), reinstall)
  const reinstallClean = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.1.5', installedVersion: '0.1.5', verdict: VERDICT_UP_TO_DATE })
  assert.ok(!reinstallClean.includes('替换'), reinstallClean)
  // 升级
  const upgrade = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.2.0', runningVersion: '0.1.5', verdict: VERDICT_OUTDATED })
  assert.ok(upgrade.includes('升级') && upgrade.includes('0.2.0'), upgrade)
  // 无法判定:unknown 且目标非空,归因中性
  const undetermined = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.2.0', runningVersion: 'dev-main', verdict: VERDICT_UNKNOWN })
  assert.ok(undetermined.includes('无法判定'), undetermined)
  // 回退:up-to-date 且目标!=运行,表述不断言方向(semver 等值字面不同时同样成立)
  const rollback = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.2.0-rc.1', verdict: VERDICT_UP_TO_DATE })
  assert.ok(rollback.includes('不高于'), rollback)
  assert.ok(rollback.includes('0.1.5'), rollback)
})

test('升级浮条区分等待重启、结果未知、失败与确认成功', () => {
  const waiting = { ok: null, pending: true }
  assert.match(clientUpgradeFinalText({ ...waiting, exitScheduled: true }), /退出.*核验/)
  assert.match(clientUpgradeFinalText({ ...waiting, exitScheduled: false }), /手动重启/)
  assert.doesNotMatch(clientUpgradeFinalText({ ...waiting, exitScheduled: false }), /正在退出|升级完成/)
  assert.match(clientUpgradeFinalText({ ok: null }), /结果未确认/)
  assert.match(clientUpgradeFinalText({ ok: false, error: '锁被占用' }), /升级失败.*锁被占用/)
  assert.match(clientUpgradeFinalText({ ok: true }), /升级完成.*运行目标版本/)
})

// prev/next 为 {lost,pid,bootAt} 快照;lost 强信号优先;bootAt 双侧齐备时以其为唯一
// 实例证据(自洽数据:不同进程 bootAt 必不同),pid 比对是 bootAt 缺失时的退化路径
const RELOAD_CASES = [
  { prev: { lost: true, pid: 1, bootAt: 1 }, next: { lost: false, pid: 1, bootAt: 1 }, expected: true },
  { prev: { lost: false, pid: 7, bootAt: 100 }, next: { lost: false, pid: 8, bootAt: 200 }, expected: true },
  { prev: { lost: false, pid: 7, bootAt: 100 }, next: { lost: false, pid: 7, bootAt: 100 }, expected: false },
  { prev: { lost: false, pid: 1, bootAt: 100 }, next: { lost: false, pid: 1, bootAt: 200 }, expected: true, note: '容器 pid 恒 1 靠 bootAt' },
  { prev: { lost: false, pid: 7, bootAt: null }, next: { lost: false, pid: 8, bootAt: 200 }, expected: true, note: 'bootAt 缺失退化 pid 比对' },
  { prev: { lost: false, pid: 7, bootAt: null }, next: { lost: false, pid: 7, bootAt: 200 }, expected: false, note: 'bootAt 单侧缺失且 pid 未变' },
  { prev: { lost: false, pid: null, bootAt: null }, next: { lost: false, pid: 8, bootAt: 200 }, expected: false },
  { prev: { lost: false, pid: 7, bootAt: 100 }, next: { lost: false, pid: null, bootAt: null }, expected: false },
  { prev: { lost: false, pid: undefined, bootAt: undefined }, next: { lost: false, pid: undefined, bootAt: undefined }, expected: false },
  { prev: { lost: true, pid: null, bootAt: null }, next: { lost: false, pid: null, bootAt: null }, expected: true },
]

const REGISTRY_CASES = [
  { value: 'https://registry.npmjs.org', expected: true },
  { value: 'http://localhost:4873', expected: true },
  { value: 'HTTPS://MIRROR.EXAMPLE', expected: true },
  { value: '  https://padded.example  ', expected: true },
  { value: 'ftp://registry.example', expected: false },
  { value: 'registry.npmjs.org', expected: false },
  { value: '', expected: false },
  { value: null, expected: false },
  { value: undefined, expected: false },
  { value: 123, expected: false },
  // query/hash 会在拼接 dist-tags 路径时吞掉 API 路径,收紧后一律拒绝
  { value: 'https://example.com?mirror=1', expected: false },
  { value: 'https://example.com#frag', expected: false },
]

test('parity: shouldReloadAfterRestart 双实现全场景一致', () => {
  for (const { prev, next, expected, note } of RELOAD_CASES) {
    assert.equal(coreShouldReload(prev, next), expected, 'core ' + JSON.stringify({ prev, next }) + (note ? ' ' + note : ''))
    assert.equal(clientShouldReload(prev, next), expected, 'client ' + JSON.stringify({ prev, next }) + (note ? ' ' + note : ''))
  }
})

test('parity: isValidRegistryBase 双实现全场景一致', () => {
  for (const { value, expected } of REGISTRY_CASES) {
    assert.equal(coreIsValidRegistryBase(value), expected, 'core ' + JSON.stringify(value))
    assert.equal(clientIsValidRegistryBase(value), expected, 'client ' + JSON.stringify(value))
  }
})

test('parity: VERDICT 三常量 client 与 core 一致', () => {
  assert.equal(extractConst('VERDICT_OUTDATED'), VERDICT_OUTDATED)
  assert.equal(extractConst('VERDICT_UP_TO_DATE'), VERDICT_UP_TO_DATE)
  assert.equal(extractConst('VERDICT_UNKNOWN'), VERDICT_UNKNOWN)
})

// host 侧锚点直接 import index.js 实现,防测试内手抄字面量漂移假绿
import {
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_REGISTRY_BASE,
  TICK_MS,
  API_PATHS,
  RESTART_DELAY_MS,
} from '../src/index.js'
import { MANAGED_TIMEOUT_MS } from '../src/managed-upgrade.mjs'
import { progressSnapshot } from '../src/progress.mjs'

test('最终核验与通用安装阶段的客户端文案与宿主一致', () => {
  for (const phase of ['accepted', 'pre-switch', 'preparing', 'installing', 'validating', 'ready-to-switch', 'awaiting-restart', 'failed', 'indeterminate']) {
    const snapshot = progressSnapshot({ phase }, 5000)
    assert.equal(clientUpgradePhaseLabel(snapshot), snapshot.phaseLabel)
  }
})

test('parity: 默认轮询间隔与镜像地址 client 与 host 实现一致', () => {
  assert.equal(extractNumberConst('DEFAULT_POLL_INTERVAL_SEC'), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(extractConst('DEFAULT_REGISTRY_BASE'), DEFAULT_REGISTRY_BASE)
})

test('parity: client 轮询粒度提示与 host TICK_MS 换算一致', () => {
  assert.equal(extractNumberConst('POLL_MIN_TICK_SECONDS'), TICK_MS / 1000)
})

test('parity: client API 路径常量与 host 路由清单逐条一致', () => {
  // client 侧常量名带 _URL 后缀,host 侧 API_PATHS 键名即语义段
  const CLIENT_KEY_BY_HOST_KEY = {
    STATUS: 'STATUS_URL',
    REFRESH: 'REFRESH_URL',
    CHANNEL: 'CHANNEL_URL',
    POLL_INTERVAL: 'POLL_INTERVAL_URL',
    REGISTRY_BASE: 'REGISTRY_BASE_URL',
    SAFE_MODE_WHITELIST: 'SAFE_MODE_WHITELIST_URL',
    PLUGINS: 'PLUGINS_URL',
    UPGRADE: 'UPGRADE_URL',
    RECEIPT_ACK: 'RECEIPT_ACK_URL',
    PREFLIGHT: 'PREFLIGHT_URL',
    SAFE_MODE_RESTORE: 'SAFE_MODE_RESTORE_URL',
    RESTART: 'RESTART_URL',
    RELEASE_NOTES: 'RELEASE_NOTES_URL',
  }
  assert.deepEqual(Object.keys(API_PATHS).sort(), Object.keys(CLIENT_KEY_BY_HOST_KEY).sort())
  for (const [hostKey, hostPath] of Object.entries(API_PATHS)) {
    assert.equal(extractConst(CLIENT_KEY_BY_HOST_KEY[hostKey]), hostPath, 'API 路径漂移: ' + hostKey)
  }
})

// 窗口关系对拍:重启等待总时长必须大于退出延迟,否则宿主还在延迟退出窗口内客户端已报超时
test('parity: 重启等待总时长大于宿主退出延迟,且最多 1 分钟', () => {
  const restartTimeoutMs = extractNumberConst('RESTART_TIMEOUT_MS')
  assert.ok(restartTimeoutMs > RESTART_DELAY_MS,
    'RESTART_TIMEOUT_MS 必须大于 RESTART_DELAY_MS')
  assert.equal(restartTimeoutMs, 60 * 1000, '重启等待总时长必须为 1 分钟')
})

test('parity: 升级观察上限覆盖受管安装超时上限(防抢跑转状态未知)', () => {
  const watchMaxMs = extractNumberConst('UPGRADE_WATCH_MAX_MS')
  assert.ok(
    watchMaxMs >= MANAGED_TIMEOUT_MS,
    'UPGRADE_WATCH_MAX_MS(' + watchMaxMs + ') 必须不小于受管安装超时(' + MANAGED_TIMEOUT_MS + ')',
  )
})

test('parity: npm 版本页链接与追踪包名同源', () => {
  assert.ok(extractConst('NPM_VERSIONS_URL').includes(TARGET_PACKAGE), 'NPM_VERSIONS_URL 应包含 TARGET_PACKAGE 字面量')
})

// release 更新内容事实源在 GitHub Releases:client 兜底链接与 host 拉取仓库必须同源
test('parity: GitHub releases 兜底链接与 host 拉取仓库同源', () => {
  assert.equal(extractConst('RELEASES_PAGE_URL'), 'https://github.com/' + RELEASE_REPO + '/releases')
})

test('源码契约: 重启轮询与升级观察器不得回退 setInterval 重叠拍形态', () => {
  // 顺序循环 + 代际令牌是防重叠拍竞态形态;setInterval 回归即竞态回归
  assert.ok(!/setInterval\(/.test(CLIENT_SOURCE), 'client.js 禁止 setInterval(拍自调度取代)')
  assert.ok(CLIENT_SOURCE.includes('AbortSignal.timeout(UPGRADE_POLL_TIMEOUT_MS)'), '升级观察拍必须带请求超时')
  assert.ok(CLIENT_SOURCE.includes('upgradeWatch.generation !== generation'), '升级观察拍 settle 后必须验代际')
})

function buildStatusObserver() {
  const start = CLIENT_SOURCE.indexOf('const UPGRADE_WATCH_MAX_MS')
  const end = CLIENT_SOURCE.indexOf('function ensureUpgradeFloatStyle()', start)
  const code = CLIENT_SOURCE.slice(start, end)
  let now = 0
  let sequence = 0
  const scheduled = new Map()
  const requests = []
  const floats = []
  const progress = []
  const scope = {
    Date: { now: () => now }, AbortController, AbortSignal,
    STATUS_URL: '/api/maintain/status', UPGRADE_POLL_MS: 2000,
    api: (path, { signal }) => new Promise((resolve) => requests.push({ path, signal, resolve })),
    setTimeout: (callback, ms) => { scheduled.set(++sequence, { callback, ms }); return sequence },
    clearTimeout: (token) => scheduled.delete(token),
    showUpgradeFloat: (value) => floats.push(value), removeUpgradeFloat: () => floats.push('removed'),
    updateUpgradeFloatProgress: (value) => progress.push(value),
  }
  const { ensureUpgradeWatch, subscribeUpgradeStatus } = new Function(...Object.keys(scope), code + '\nreturn { ensureUpgradeWatch, subscribeUpgradeStatus }')(...Object.values(scope))
  return {
    observe: ensureUpgradeWatch, subscribe: subscribeUpgradeStatus, scheduled, requests, floats, progress,
    async accept(status) {
      buildOnUpgrade({ post: async () => ({ ok: true, status }), ensureUpgradeWatch })(status.upgrade.last.targetVersion, false)
      await Promise.resolve()
    },
    async resolve(snapshot, at = now) { now = at; requests.at(-1).resolve(snapshot); await Promise.resolve() },
    async next(at) {
      assert.equal(scheduled.size, 1, '应调度且仅调度一次状态探测')
      const [token, { callback, ms }] = scheduled.entries().next().value
      scheduled.delete(token)
      now = at ?? now + ms
      callback()
      await Promise.resolve()
    },
  }
}

const HEALTH_PENDING = { bootId: 'boot-1', healthChecking: true, upgrade: { running: false } }

test('启动健康检查复用同一单飞状态观察，报告终态后停止且无升级浮条', async () => {
  const observer = buildStatusObserver()
  const received = []
  observer.subscribe((snapshot) => received.push(snapshot))
  observer.observe({ ...HEALTH_PENDING, healthChecking: false })
  assert.equal(observer.requests.length, 0)
  observer.observe(HEALTH_PENDING)
  observer.observe(HEALTH_PENDING)
  assert.equal(observer.requests.length, 1)
  assert.equal(observer.scheduled.size, 0)
  await observer.resolve(HEALTH_PENDING)
  assert.equal(observer.scheduled.size, 1)
  await observer.next()
  const finished = { ...HEALTH_PENDING, healthChecking: false }
  await observer.resolve(finished)
  assert.deepEqual(received, [HEALTH_PENDING, finished])
  assert.equal(observer.scheduled.size, 0)
  assert.deepEqual(observer.floats, [])
})

test('健康检查结束边界包括换 boot、预算耗尽和最后一个订阅卸载', async () => {
  const observer = buildStatusObserver()
  const unsubscribe = observer.subscribe(() => {})
  observer.observe(HEALTH_PENDING)
  await observer.resolve({ ...HEALTH_PENDING, bootId: 'boot-2' })
  assert.equal(observer.scheduled.size, 0)
  observer.observe(HEALTH_PENDING)
  await observer.resolve(HEALTH_PENDING)
  assert.equal(observer.scheduled.size, 1, '同一 boot 尚未结束时应继续探测')
  await observer.next(60 * 1000)
  assert.equal(observer.requests.length, 2)
  assert.equal(observer.scheduled.size, 0)
  observer.observe({ ...HEALTH_PENDING, bootId: 'boot-2' })
  unsubscribe()
  assert.equal(observer.requests.at(-1).signal.aborted, true)
  await observer.resolve(HEALTH_PENDING)
  assert.equal(observer.scheduled.size, 0)
  assert.deepEqual(observer.floats, [])
})

const UPGRADE_ACCEPTED = {
  bootId: HEALTH_PENDING.bootId,
  healthChecking: false,
  upgrade: { running: true, last: { operationId: 'accepted-op', targetVersion: '2.0.0', startedAt: 200, ok: null } },
}
const PREVIOUS_LAST = { operationId: 'previous-op', targetVersion: '2.0.0', startedAt: 100, ok: false, historical: true }

for (const running of [false, true]) {
  test(`POST 接受升级后，迟到的旧健康拍 running=${running} 不影响当前升级`, async () => {
    const observer = buildStatusObserver()
    const received = []
    observer.subscribe((snapshot) => received.push(snapshot))
    observer.observe(HEALTH_PENDING)
    await observer.accept(UPGRADE_ACCEPTED)
    assert.equal(observer.requests.length, 1, '旧 GET 在途时不得并发')
    assert.deepEqual(observer.floats, [null])

    await observer.resolve({
      ...(running ? UPGRADE_ACCEPTED : HEALTH_PENDING),
      upgrade: { running, last: running ? UPGRADE_ACCEPTED.upgrade.last : PREVIOUS_LAST, progress: { phase: 'pre-switch' } },
    })
    assert.deepEqual(received, [], '旧响应不得覆盖 POST 状态或触发重启接管')
    assert.deepEqual(observer.progress, [])
    await observer.next()
    const last = { ...UPGRADE_ACCEPTED.upgrade.last, ok: null, pending: true, exitScheduled: true }
    const finished = { ...UPGRADE_ACCEPTED, upgrade: { running: false, last } }
    await observer.resolve(finished)
    assert.deepEqual(received, [finished], '真实终态无需先看到 running=true')
    assert.deepEqual(observer.floats, [null, last])
    assert.equal(observer.scheduled.size, 0)
  })
}

test('已知 operationId 时不接受其他操作的进度或终态', async () => {
  const observer = buildStatusObserver()
  const received = []
  observer.subscribe((snapshot) => received.push(snapshot))
  await observer.accept(UPGRADE_ACCEPTED)
  const otherLast = { ...UPGRADE_ACCEPTED.upgrade.last, operationId: 'other-op' }
  await observer.resolve({ ...UPGRADE_ACCEPTED, upgrade: { running: true, last: otherLast, progress: { phase: 'pre-switch' } } })
  await observer.next()
  await observer.resolve({ ...UPGRADE_ACCEPTED, upgrade: { running: false, last: { ...otherLast, exitScheduled: true } } })
  assert.deepEqual(received, [])
  assert.deepEqual(observer.progress, [])
  assert.deepEqual(observer.floats, [null])
  await observer.next(32 * 60 * 1000)
  assert.equal(observer.requests.length, 2, '不匹配的状态仍受升级观察预算约束')
  assert.deepEqual(observer.floats, [null, 'unknown'])
})

for (const operationId of [null, 'assigned-after-accept']) {
  test(`POST 的 operationId 为空时，能识别首个有效快照已终止的升级（${operationId ?? '仍无 ID'}）`, async () => {
    const observer = buildStatusObserver()
    const received = []
    observer.subscribe((snapshot) => received.push(snapshot))
    observer.observe(HEALTH_PENDING)
    const acceptedLast = { ...UPGRADE_ACCEPTED.upgrade.last, operationId: null }
    await observer.accept({ ...UPGRADE_ACCEPTED, upgrade: { running: true, last: acceptedLast } })
    await observer.resolve(HEALTH_PENDING)
    await observer.next()
    await observer.resolve({ ...UPGRADE_ACCEPTED, upgrade: { running: false, last: PREVIOUS_LAST } })
    await observer.next()
    const last = { ...acceptedLast, operationId, ok: false, phase: 'failed' }
    const finished = { ...UPGRADE_ACCEPTED, upgrade: { running: false, last } }
    await observer.resolve(finished)
    assert.deepEqual(received, [finished])
    assert.deepEqual(observer.floats, [null, last])
    assert.equal(observer.scheduled.size, 0)
  })
}

test('POST 在发起面板卸载后返回短操作终态，新面板仍收到退出交接', async () => {
  const observer = buildStatusObserver()
  const unsubscribe = observer.subscribe(() => {})
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, pending: true, exitScheduled: true, phase: 'awaiting-restart' }
  const finished = { ...UPGRADE_ACCEPTED, upgrade: { running: false, last } }
  const accepting = observer.accept(finished)
  unsubscribe()
  const received = []
  observer.subscribe((snapshot) => received.push(snapshot))
  observer.observe(HEALTH_PENDING)
  await accepting
  await observer.resolve(HEALTH_PENDING)
  assert.deepEqual(received, [finished], '现存面板须收到一次终态以接管重启')
  assert.deepEqual(observer.floats, [last])
  assert.equal(observer.requests.length, 1)
  assert.equal(observer.scheduled.size, 0)
})

test('旧升级观察错过退出拍时，自动跟进新 boot 的健康结果', async () => {
  const observer = buildStatusObserver()
  const received = []
  observer.subscribe((snapshot) => received.push(snapshot))
  observer.observe({ ...HEALTH_PENDING, bootId: 'previous-boot' })
  const running = { ...UPGRADE_ACCEPTED, bootId: 'old-boot' }
  const accepted = { ...running, upgrade: { running: true, last: { ...running.upgrade.last, operationId: null } } }
  await observer.accept(accepted)
  await observer.resolve({ ...HEALTH_PENDING, bootId: 'previous-boot' })
  await observer.next()
  await observer.resolve(running)
  assert.deepEqual(received, [running], '按 POST 的 boot 和事务开始时间匹配，并绑定此拍分配的 ID')
  await observer.next()
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, landed: true, historical: true }
  await observer.resolve({ ...running, upgrade: { running: false, last: { ...last, historical: false, operationId: 'other-op' } } })
  assert.deepEqual(received, [running], '绑定后相同 boot、目标版本、开始时间仍不能覆盖正确 ID')
  await observer.next()
  const checking = { ...HEALTH_PENDING, upgrade: { running: false, last } }
  await observer.resolve(checking)
  await observer.next()
  const checkingAfterRestart = { ...checking, bootId: 'boot-2' }
  await observer.resolve(checkingAfterRestart)
  observer.observe(running)
  await observer.next()
  await observer.resolve(running)
  await observer.next()
  const finishedUpgrade = { running: false, last: { ...last, ok: false } }
  await observer.resolve({ ...checking, healthChecking: false, upgrade: finishedUpgrade })
  await observer.next()
  const finished = { ...checkingAfterRestart, healthChecking: false, upgrade: finishedUpgrade }
  await observer.resolve(finished)
  assert.deepEqual(received, [running, checking, checkingAfterRestart, finished])
  assert.equal(observer.scheduled.size, 0)
  assert.deepEqual(observer.floats, [null, 'removed'])
})

test('升级交接后连续重启共用原健康预算，重复观察不增加请求', async () => {
  const observer = buildStatusObserver()
  const unsubscribe = observer.subscribe(() => {})
  const closingPanel = observer.subscribe(() => {})
  await observer.accept(UPGRADE_ACCEPTED)
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, landed: true, historical: true }
  const firstBoot = { ...HEALTH_PENDING, bootId: 'boot-2', upgrade: { running: false, last } }
  await observer.resolve(firstBoot)

  const healthBudget = 60 * 1000
  await observer.next(healthBudget / 2)
  const secondBoot = { ...firstBoot, bootId: 'boot-3' }
  closingPanel()
  assert.equal(observer.requests.at(-1).signal.aborted, false)
  observer.observe(secondBoot)
  observer.observe(secondBoot)
  assert.equal(observer.requests.length, 2, '仍在途时不得并发')
  await observer.resolve(secondBoot)
  await observer.next(healthBudget - 2 * 1000)
  assert.equal(observer.requests.length, 3, '原预算到期前仍应探测')
  await observer.resolve(secondBoot)
  await observer.next(healthBudget)

  assert.equal(observer.requests.length, 3, '换 boot 不得延长健康预算')
  assert.equal(observer.scheduled.size, 0)
  assert.deepEqual(observer.floats, [null, 'removed'])
  unsubscribe()
})

test('绑定的健康观察仍接管另一标签页在当前 boot 新发起的升级', async () => {
  const observer = buildStatusObserver()
  const received = []
  observer.subscribe((snapshot) => received.push(snapshot))
  observer.observe(LANDING_STATUS)
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, operationId: 'new-op', startedAt: LANDING_STATUS.bootAt + 1 }
  const otherTab = { ...LANDING_STATUS, healthChecking: false, upgrade: { running: true, last } }
  await observer.resolve(otherTab)

  assert.deepEqual(received, [otherTab])
  assert.deepEqual(observer.floats, [null])
})

test('升级交接后的最后一拍在固定健康预算到期时失效', async () => {
  const observer = buildStatusObserver()
  const received = []
  observer.subscribe((snapshot) => received.push(snapshot))
  await observer.accept(UPGRADE_ACCEPTED)
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, landed: true, historical: true }
  const firstBoot = { ...HEALTH_PENDING, bootId: 'boot-2', upgrade: { running: false, last } }
  await observer.resolve(firstBoot)

  const healthBudget = 60 * 1000
  await observer.next(healthBudget - 1)
  await observer.resolve({ ...firstBoot, healthChecking: false }, healthBudget)

  assert.deepEqual(received, [firstBoot], '到期才返回的健康结果不得广播')
  assert.equal(observer.requests.at(-1).signal.aborted, true)
  assert.equal(observer.scheduled.size, 0)
})

test('升级交接后仍以 operation 区分健康结果，最后一个订阅卸载会中止观察', async () => {
  const observer = buildStatusObserver()
  const received = []
  const unsubscribe = observer.subscribe((snapshot) => received.push(snapshot))
  await observer.accept(UPGRADE_ACCEPTED)
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, landed: true, historical: true }
  const firstBoot = { ...HEALTH_PENDING, bootId: 'boot-2', upgrade: { running: false, last } }
  await observer.resolve(firstBoot)
  await observer.next()
  await observer.resolve({
    ...firstBoot,
    bootId: 'boot-3',
    healthChecking: false,
    upgrade: { running: false, last: { ...last, operationId: 'other-op', ok: false } },
  })
  assert.deepEqual(received, [firstBoot], '异操作终态不得覆盖正在观察的健康结果')
  await observer.next()
  unsubscribe()
  assert.equal(observer.requests.at(-1).signal.aborted, true)
  await observer.resolve({ ...firstBoot, bootId: 'boot-3' })
  assert.deepEqual(received, [firstBoot])
  assert.equal(observer.scheduled.size, 0)
})

function mountMaintainPage() {
  let now = 0
  let renderSlot
  let hookIndex = 0
  const state = []
  const effects = []
  const requests = []
  const scheduled = new Map()
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = hookIndex++
      if (!(index in state)) state[index] = initial
      return [state[index], (value) => { state[index] = value }]
    },
    useRef: (current) => ({ current }),
    useEffect: (effect) => effects.push(effect),
  }
  const slots = {
    inject: (_name, register) => register(),
    register: (_slot, render) => { renderSlot = render },
  }
  const window = { __ModuleLoader__: {
    load({ factory }) {
      const module = factory((id) => id === 'react' ? React : { toast: { show: () => {} } })
      module.apply({ slots })
    },
  } }
  const scope = {
    window, AbortController, AbortSignal,
    Date: class extends Date { static now() { return now } },
    fetch: (path, { signal }) => new Promise((resolve) => requests.push({ path, signal, resolve })),
    setTimeout(callback, ms) { scheduled.set(callback, now + ms); return callback },
    clearTimeout: (token) => scheduled.delete(token),
  }
  new Function(...Object.keys(scope), CLIENT_SOURCE)(...Object.values(scope))
  const page = renderSlot()
  const render = () => { hookIndex = 0; return page.type() }
  render()
  const cleanup = effects.splice(0).map((effect) => effect())
  return {
    requests, scheduled,
    async resolve(snapshot, at = now) {
      now = at
      requests.at(-1).resolve({ ok: true, json: async () => snapshot })
      await new Promise(setImmediate)
    },
    next(at) {
      assert.equal(scheduled.size, 1, '应有且只有一个待发状态请求')
      const [[callback, scheduledAt]] = scheduled
      scheduled.delete(callback)
      now = at ?? scheduledAt
      callback()
    },
    receiptText() {
      const card = render().children.find((child) => child?.type?.name === 'UpgradeCard')
      function text(node) { return typeof node === 'string' ? node : node?.children?.map(text).join('') ?? '' }
      return text(card.type(card.props))
    },
    unmount: () => cleanup.forEach((dispose) => dispose?.()),
  }
}

const LANDING_STATUS = {
  bootId: 'boot-B', bootAt: 300, healthChecking: true,
  upgrade: { running: false, last: { ...UPGRADE_ACCEPTED.upgrade.last, landed: true, historical: true } },
}

test('首次页面加载 B 的健康检查跨到 C，忽略旧 boot 和外操作并展示 C 的终态', async (t) => {
  const page = mountMaintainPage()
  t.after(page.unmount)
  const bootC = { ...LANDING_STATUS, bootId: 'boot-C', bootAt: 400 }
  const failed = { ...LANDING_STATUS.upgrade.last, ok: false, error: 'C 健康检查失败' }
  const finished = { ...bootC, healthChecking: false, upgrade: { running: false, last: failed } }

  await page.resolve(LANDING_STATUS)
  assert.equal(page.requests.length, 2, '首次加载和接管各发一次 GET')
  assert.equal(page.scheduled.size, 0, '接管请求在途时不调度下一拍')
  const checkingReceipt = page.receiptText()
  await page.resolve({ ...finished, bootId: 'boot-A', bootAt: 100 })
  assert.equal(page.receiptText(), checkingReceipt, '首次加载前的旧 boot 也不能发布终态')
  page.next()
  await page.resolve(bootC)
  for (const stale of [
    { ...finished, bootId: LANDING_STATUS.bootId, bootAt: LANDING_STATUS.bootAt },
    { ...finished, upgrade: { running: true, last: { ...failed, operationId: 'foreign-op' } } },
    { ...finished, upgrade: { running: false, last: { ...failed, operationId: 'foreign-op' } } },
  ]) {
    page.next()
    assert.equal(page.scheduled.size, 0, '在途时不得启动重叠探测')
    await page.resolve(stale)
    assert.equal(page.receiptText(), checkingReceipt, '旧 boot 和外操作不能改变正在观察的回执')
  }
  page.next()
  await page.resolve(finished)

  assert.match(page.receiptText(), /C 健康检查失败/)
  assert.equal(page.requests.length, 7)
  assert.ok(page.requests.every(({ path }) => path === '/api/maintain/status'))
  assert.equal(page.scheduled.size, 0)
})

test('首次页面加载接管后的跨 boot 健康请求仍受原截止时间约束', async (t) => {
  const page = mountMaintainPage()
  t.after(page.unmount)
  const healthBudget = 60 * 1000
  const bootC = { ...LANDING_STATUS, bootId: 'boot-C' }
  await page.resolve(LANDING_STATUS)
  await page.resolve(bootC, healthBudget / 2)
  page.next(healthBudget - 1)
  const failed = { ...bootC.upgrade.last, ok: false, error: '超时返回的健康结果' }
  await page.resolve({ ...bootC, healthChecking: false, upgrade: { running: false, last: failed } }, healthBudget)

  assert.equal(page.requests.length, 3)
  assert.equal(page.requests.at(-1).signal.aborted, true)
  assert.equal(page.scheduled.size, 0)
  assert.doesNotMatch(page.receiptText(), /超时返回的健康结果/)
})

for (const trigger of ['收到健康终态', '面板卸载']) {
  test(`初始状态请求在${trigger}后返回时，不覆盖状态、接管退出或重启观察`, async () => {
    const observer = buildStatusObserver()
    const mountStart = CLIENT_SOURCE.indexOf('  function load(')
    const mountEnd = CLIENT_SOURCE.indexOf('  function takeOverSwitchExit(', mountStart)
    const render = CLIENT_SOURCE.slice(mountStart, mountEnd)
    const received = []
    const exits = []
    const initialSnapshot = Promise.withResolvers()
    const mount = new Function('statusPrefetch', 'useEffect', 'subscribeUpgradeStatus', 'ensureUpgradeWatch',
      'setStatus', 'setError', 'takeOverSwitchExit', render)
    let cleanup
    mount(initialSnapshot.promise, (effect) => { cleanup = effect() }, observer.subscribe, observer.observe,
      (snapshot) => received.push(snapshot), (error) => { if (error !== null) assert.fail(error) },
      (snapshot) => exits.push(snapshot))
    if (trigger === '面板卸载') cleanup()
    else {
      await observer.accept(UPGRADE_ACCEPTED)
      const last = { ...UPGRADE_ACCEPTED.upgrade.last, landed: true, historical: true }
      const checking = { ...HEALTH_PENDING, bootId: 'boot-2', upgrade: { running: false, last } }
      await observer.resolve(checking)
      await observer.next()
      await observer.resolve({ ...checking, healthChecking: false })
    }
    const observed = [...received]
    const expectedRequests = observer.requests.length
    initialSnapshot.resolve({ ...UPGRADE_ACCEPTED, upgrade: { running: true,
      last: { ...UPGRADE_ACCEPTED.upgrade.last, exitScheduled: true } } })
    await new Promise(setImmediate)

    assert.deepEqual(received, observed)
    assert.deepEqual(exits, observed)
    assert.equal(observer.requests.length, expectedRequests)
    cleanup()
  })
}

test('健康观察收到另一标签页发起的升级后转入升级模式', async () => {
  const observer = buildStatusObserver()
  const unsubscribe = observer.subscribe(() => {})
  observer.observe(HEALTH_PENDING)
  await observer.resolve(UPGRADE_ACCEPTED)
  assert.deepEqual(observer.floats, [null])
  unsubscribe()
  assert.equal(observer.scheduled.size, 1, '真实升级不随最后一个面板卸载停止')
  await observer.next()
  const last = { ...UPGRADE_ACCEPTED.upgrade.last, ok: false }
  await observer.resolve({ ...UPGRADE_ACCEPTED, upgrade: { running: false, last } })
  assert.deepEqual(observer.floats, [null, last])
  assert.equal(observer.scheduled.size, 0)
})

test('源码契约: 升级入口可用,确认弹窗链路完整', () => {
  // 禁用态残留即回归:验证已下沉 validateCandidate,入口不得再携带禁用文案
  assert.ok(!CLIENT_SOURCE.includes('暂不可用'), '升级入口不得残留禁用文案')
  assert.ok(!CLIENT_SOURCE.includes('尚未实现'), 'client 半区不得残留未实现声明')
  assert.ok(CLIENT_SOURCE.includes("'确认安装'"), '确认弹窗必须存在且可达')
})

function buildOnUpgrade(overrides) {
  const start = CLIENT_SOURCE.indexOf('function onUpgrade(')
  const body = CLIENT_SOURCE.slice(start, CLIENT_SOURCE.indexOf('function onRestoreSafeMode()', start))
  const scope = {
    UPGRADE_URL: '/api/maintain/upgrade',
    setUpgradeDialogOpen: () => {}, markBusy: () => {}, setStatus: () => {}, setError: () => {},
    notify: (message) => assert.fail(message), ...overrides,
  }
  return new Function(...Object.keys(scope), 'return (' + body.trim() + ')')(...Object.values(scope))
}

test('宿主升级 POST 仅携带精确版本与单次重启意图', () => {
  const calls = []
  const onUpgrade = buildOnUpgrade({
    post: (url, payload) => { calls.push({ url, payload: JSON.parse(JSON.stringify(payload)) }); return new Promise(() => {}) },
  })
  onUpgrade('2.0.0', false, true, true)
  assert.deepEqual(calls, [{ url: '/api/maintain/upgrade', payload: { targetVersion: '2.0.0', autoRestart: false } }])
  assert.ok(!CLIENT_SOURCE.includes('upgrade-template'), 'client 半区不得残留命令模板入口')
})

// 通道最新版未知时提交必 400(host 缺省目标按 dist-tags 解析,拿不到精确版本即拒绝):
// 安装入口与确认弹窗的「开始安装」都必须一并禁用,不留"点了必失败"的路径
test('源码契约: 安装入口在通道最新版未知时禁用', () => {
  const idle = { channelLatest: null, upgrade: { running: false, last: null } }
  const idleBusy = { upgrade: false }
  assert.equal(clientInstallDisabled(idle, idleBusy, false), true, '通道目标未知必须禁用安装')
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: undefined }, idleBusy, false), true, '缺字段等价未知')
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '' }, idleBusy, false), true, '空串等价未知')
  // 目标就绪且无瞬态门:放行(含重装/回退场景,verdict 不参与门控)
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9' }, idleBusy, false), false)
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9', verdict: VERDICT_UNKNOWN }, idleBusy, false), false)
  // 远端 tag 非法 semver:host 入口必 400,安装按钮必须禁用(通道明确标记非法)
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: 'not-a-version', channelLatestValid: false }, idleBusy, false), true)
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9', channelLatestValid: true }, idleBusy, false), false)
  // 瞬态门:安装中/重启中/宿主侧升级进行中
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9' }, { upgrade: true }, false), true)
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9' }, idleBusy, true), true)
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9', upgrade: { running: true, last: null } }, idleBusy, false), true)
  // busy 缺省(弹窗未接 busy 时)不得抛错
  assert.equal(clientInstallDisabled({ ...idle, channelLatest: '9.9.9' }, undefined, false), false)
  // 版本卡「安装」共用 installDisabled;确认弹窗在它之上叠加预检门 canStartInstall
  assert.equal(CLIENT_SOURCE.split('disabled: installDisabled(status, props.busy, props.restarting)').length - 1, 1,
    '版本卡安装按钮必须使用 installDisabled')
  assert.ok(CLIENT_SOURCE.includes('!canStartInstall(status, props.busy, props.restarting, preflight)'),
    '确认弹窗开始安装必须叠加预检门')
  assert.ok(!CLIENT_SOURCE.includes("disabled: props.busy.upgrade || props.restarting || (status.upgrade"), '不得回退到无 channelLatest 守卫的旧表达式')
})

// 追踪通道 select:持久化通道不在 tags 中时以标注项保留并选中,不得显示成另一个通道
test('源码契约: 通道 select 选中持久化通道(含不在 tags 的标注项)', () => {
  const selectStart = CLIENT_SOURCE.indexOf("h('select', {")
  assert.ok(selectStart > 0, '缺少通道 select')
  const select = CLIENT_SOURCE.slice(selectStart, CLIENT_SOURCE.indexOf('h(\'span\', { className: \'dm-meta\' }, status.channel', selectStart))
  assert.match(select, /value: status\.channel/, '选中值必须是持久化通道')
  assert.ok(!select.includes('tagNames[0]'), '不得回退到 tagNames[0](会显示非保存通道)')
  assert.match(select, /不在通道表中，请重新选择|不在通道表中,请重新选择/, '标注项文案必须保留')
})

// 升级进行中重启 409:观察器必须存活,stop 只能在 POST 受理成功之后
test('源码契约: 重启请求先受理再停升级观察器(409 时保持跟踪)', () => {
  const start = CLIENT_SOURCE.indexOf('function onRestart()')
  assert.ok(start > 0, '缺少 onRestart')
  const body = CLIENT_SOURCE.slice(start, CLIENT_SOURCE.indexOf('if (status === null)', start))
  const postIndex = body.indexOf('post(RESTART_URL')
  const stopIndex = body.indexOf('stopUpgradeWatch()')
  assert.ok(postIndex >= 0 && stopIndex > postIndex, 'stopUpgradeWatch 必须在重启受理成功之后调用')
})

// 设置是不常用功能,固定在面板最底部;位置回退到重启卡之前即回归
test('源码契约: 设置卡位于重启卡之后', () => {
  const opsIndex = CLIENT_SOURCE.indexOf('h(OpsCard, {')
  const settingsIndex = CLIENT_SOURCE.indexOf('h(SettingsCard, {')
  assert.ok(opsIndex > 0 && settingsIndex > opsIndex, '设置卡必须位于重启卡之后')
})

// 设置分区标题按 L1 规范 18px/600,说明行 13px;退回 14px 即视觉尺度断层回归
test('源码契约: 分区标题为 18px/600(L1 设置类)', () => {
  const match = CLIENT_SOURCE.match(/^ {2}'\.dm-head__title \{([^}]*)\}',$/m)
  assert.ok(match, 'client.js 缺少 .dm-head__title 规则')
  assert.match(match[1], /font-size:18px/, '分区标题必须 18px')
  const weight = match[1].match(/font-weight:(\d+)/)
  assert.equal(weight && weight[1], '600', '分区标题权重必须 600')
  assert.ok(!/font-size:1[0-6]px/.test(match[1]), '分区标题不得回退到小字号')
})
