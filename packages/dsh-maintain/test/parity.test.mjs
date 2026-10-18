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

// 升级浮条终态文案:成功必接退出语义,失败附原因
test('parity: upgradeFinalText 分支行为', () => {
  assert.ok(clientUpgradeFinalText({ ok: true }).includes('退出'))
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
    UPGRADE: 'UPGRADE_URL',
    RESTART: 'RESTART_URL',
    RELEASE_NOTES: 'RELEASE_NOTES_URL',
  }
  assert.deepEqual(Object.keys(API_PATHS).sort(), Object.keys(CLIENT_KEY_BY_HOST_KEY).sort())
  for (const [hostKey, hostPath] of Object.entries(API_PATHS)) {
    assert.equal(extractConst(CLIENT_KEY_BY_HOST_KEY[hostKey]), hostPath, 'API 路径漂移: ' + hostKey)
  }
})

// 窗口关系对拍:重启等待总时长必须大于退出延迟,否则宿主还在延迟退出窗口内客户端已报超时
test('parity: 重启等待总时长大于宿主退出延迟', () => {
  const restartTimeoutMs = extractNumberConst('RESTART_TIMEOUT_MS')
  assert.ok(restartTimeoutMs > RESTART_DELAY_MS,
    'RESTART_TIMEOUT_MS 必须大于 RESTART_DELAY_MS')
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

test('源码契约: 升级请求携带精确 targetVersion,禁止 autoRestart 勾选回归', () => {
  assert.ok(CLIENT_SOURCE.includes('post(UPGRADE_URL, { targetVersion })'), '升级请求必须携带 targetVersion')
  assert.ok(!CLIENT_SOURCE.includes('autoRestart'), 'client 半区不得残留 autoRestart 语义')
  assert.ok(!CLIENT_SOURCE.includes('upgrade-template'), 'client 半区不得残留命令模板入口')
})
