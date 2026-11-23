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
const clientUpgradeFinalText = extractLogic('upgradeFinalText')

// 弹窗版本变更行:目标=通道最新精确版本,按 未知/重装/升级/无法判定/回退 分支
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

// 升级浮条终态文案:调度退出必接退出语义,未调度(单次意图关闭)必须引导手动重启,失败附原因
test('parity: upgradeFinalText 分支行为', () => {
  assert.ok(clientUpgradeFinalText({ ok: true, exitScheduled: true }).includes('退出'))
  assert.ok(clientUpgradeFinalText({ ok: true, exitScheduled: false }).includes('手动重启'))
  assert.ok(!clientUpgradeFinalText({ ok: true, exitScheduled: false }).includes('正在退出'), '未调度退出不得宣称宿主退出')
  assert.ok(clientUpgradeFinalText({ ok: false, error: '锁被占用' }).includes('锁被占用'))
  assert.ok(clientUpgradeFinalText({ ok: false }).includes('详情'))
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

test('源码契约: 升级入口可用,确认弹窗链路完整', () => {
  // 禁用态残留即回归:验证已下沉 validateCandidate,入口不得再携带禁用文案
  assert.ok(!CLIENT_SOURCE.includes('暂不可用'), '升级入口不得残留禁用文案')
  assert.ok(!CLIENT_SOURCE.includes('尚未实现'), 'client 半区不得残留未实现声明')
  assert.ok(CLIENT_SOURCE.includes("'确认安装'"), '确认弹窗必须存在且可达')
})

test('源码契约: 升级请求携带精确 targetVersion、单次 autoRestart、安全模式与插件同步意图', () => {
  assert.ok(CLIENT_SOURCE.includes('post(UPGRADE_URL, { targetVersion, autoRestart, safeMode, upgradePlugins })'), '升级请求必须携带 targetVersion/autoRestart/safeMode/upgradePlugins')
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
  assert.ok(CLIENT_SOURCE.includes('!canStartInstall(status, props.busy, props.restarting, preflight, safeMode, upgradeBeforeSwitch)'),
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

// 插件前置升级协议字面量:host 常量与 client 门禁必须同一值,单侧改名会让开关永久禁用而无人察觉
test('源码契约: client 的前置升级模式字面量与 host 常量一致', async () => {
  const { PLUGIN_UPGRADE_MODE } = await import('../src/plugin-upgrade.mjs')
  const literals = CLIENT_SOURCE.match(/'pre-switch'|'post-restart'/g) || []
  assert.ok(literals.length > 0, 'client.js 必须按模式字面量决定开关可用性')
  assert.deepEqual([...new Set(literals)], ["'" + PLUGIN_UPGRADE_MODE + "'"])
})
