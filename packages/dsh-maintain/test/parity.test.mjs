// parity 测试:client.js 的 LOGIC 标记段与 core.mjs 同源函数对拍,
// 数据镜像常量(默认值/VERDICT/API 路径/超时窗口)与 host 侧组合值对照。
// client 半区无法 import ESM,按 LOGIC 标记提取源码文本后工厂化执行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  shouldReloadAfterRestart as coreShouldReload,
  isValidRegistryBase as coreIsValidRegistryBase,
  extractPinnedVersion as coreExtractPinnedVersion,
  VERDICT_OUTDATED,
  VERDICT_UP_TO_DATE,
  VERDICT_UNKNOWN,
  TARGET_PACKAGE,
} from '../src/core.mjs'
import { clientSource, extractLogic } from './logic-extract.mjs'
import { KILL_GRACE_MS } from '../src/upgrade.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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
const clientExtractPinnedVersion = extractLogic('extractPinnedVersion')
// 弹窗文案分支依赖钉定检测:直接注 core 实现,顺带证明两侧检测可互换
const clientBuildInstallChangeLine = extractLogic('buildInstallChangeLine', {
  extractPinnedVersion: coreExtractPinnedVersion,
  VERDICT_OUTDATED,
  VERDICT_UNKNOWN,
})
const clientBuildInstallVersionHint = extractLogic('buildInstallVersionHint')

// 命令钉定 token 提取:双实现对拍 + 语义锚(尾部取最后合法者/通道名与 @latest 不命中/shell 粘连截断)
const PINNED_CASES = [
  { command: 'npm install -g @deepseek-ai/dsh@0.1.4', expected: '0.1.4' },
  { command: 'npm install -g @deepseek-ai/dsh@0.1.4 --silent', expected: '0.1.4' },
  { command: 'npm i -g @deepseek-ai/dsh@0.1.4 && echo ok', expected: '0.1.4' },
  { command: '@scope/pkg@1.2.3-rc.1', expected: '1.2.3-rc.1' },
  { command: 'pkg@1.2.3+build.7', expected: '1.2.3+build.7' },
  { command: 'a@1.0.0 b@2.0.0', expected: '2.0.0' },
  { command: 'npm install -g @deepseek-ai/dsh@{tag}', expected: null },
  { command: 'npm install -g @deepseek-ai/dsh@latest', expected: null },
  { command: 'node -e "process.exit(0)"', expected: null },
  { command: 'pkg@0.1.4beta', expected: null },
  { command: 'pkg@01.2.3', expected: null },
  { command: '@@1.0.0', expected: '1.0.0' },
  { command: '', expected: null },
  { command: null, expected: null },
]

test('parity: extractPinnedVersion 双实现全场景一致', () => {
  for (const { command, expected } of PINNED_CASES) {
    assert.equal(coreExtractPinnedVersion(command), expected, 'core ' + JSON.stringify(command))
    assert.equal(clientExtractPinnedVersion(command), expected, 'client ' + JSON.stringify(command))
  }
})

// 弹窗版本变更行:钉定优先(含改回 {tag} 指引),通道语义按 未知/重装/升级/无法判定/回退 分支
test('parity: buildInstallChangeLine 分支行为', () => {
  const base = { channel: 'latest', channelLatest: null, runningVersion: null, installedVersion: null, verdict: VERDICT_UNKNOWN }
  // 钉定:模板含 @x.y.z 即按指定版本表述,并提示改回 {tag}
  const pinned = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.1.5' },
    'npm install -g @deepseek-ai/dsh@0.1.4')
  assert.ok(pinned.includes('0.1.4'), pinned)
  assert.ok(pinned.includes('指定版本'), pinned)
  assert.ok(pinned.includes('{tag}'), pinned)
  // 通道目标未知
  assert.ok(clientBuildInstallChangeLine({ ...base }, 'npm install -g @deepseek-ai/dsh@latest').includes('未知'))
  // 重装:目标==运行;已装领先(待生效)时提示将被替换
  const reinstall = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.1.5', installedVersion: '0.2.0-rc.1', verdict: VERDICT_UP_TO_DATE },
    'npm install -g @deepseek-ai/dsh@latest')
  assert.ok(reinstall.includes('重装'), reinstall)
  assert.ok(reinstall.includes('0.2.0-rc.1'), reinstall)
  const reinstallClean = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.1.5', installedVersion: '0.1.5', verdict: VERDICT_UP_TO_DATE },
    'npm install -g @deepseek-ai/dsh@latest')
  assert.ok(!reinstallClean.includes('替换'), reinstallClean)
  // 升级
  const upgrade = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.2.0', runningVersion: '0.1.5', verdict: VERDICT_OUTDATED },
    'npm install -g @deepseek-ai/dsh@latest')
  assert.ok(upgrade.includes('升级') && upgrade.includes('0.2.0'), upgrade)
  // 无法判定:unknown 且目标非空,归因中性(目标非法/运行非法两种来源)
  const undetermined = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.2.0', runningVersion: 'dev-main', verdict: VERDICT_UNKNOWN },
    'npm install -g @deepseek-ai/dsh@latest')
  assert.ok(undetermined.includes('无法判定'), undetermined)
  // 回退:up-to-date 且目标!=运行,表述不断言方向(semver 等值字面不同时同样成立)
  const rollback = clientBuildInstallChangeLine(
    { ...base, channelLatest: '0.1.5', runningVersion: '0.2.0-rc.1', verdict: VERDICT_UP_TO_DATE },
    'npm install -g @deepseek-ai/dsh@latest')
  assert.ok(rollback.includes('不高于'), rollback)
  assert.ok(rollback.includes('0.1.5'), rollback)
  // semver 形态通道名:命令中的 @1.0.0 是 {tag} 展开产物,按通道语义(重装)而非钉定表述
  const semverChannel = clientBuildInstallChangeLine(
    { ...base, channel: '1.0.0', channelLatest: '1.0.0', runningVersion: '1.0.0', installedVersion: '1.0.0', verdict: VERDICT_UP_TO_DATE },
    'npm install -g @deepseek-ai/dsh@1.0.0')
  assert.ok(!semverChannel.includes('指定版本'), semverChannel)
  assert.ok(semverChannel.includes('重装'), semverChannel)
})

// 弹窗当前版本行:缺失回退"未知"(渲染级防回归——该行曾在组件内联,作用域变量删除后渲染即崩)
test('parity: buildInstallVersionHint 缺失回退未知', () => {
  assert.equal(clientBuildInstallVersionHint({ runningVersion: '0.1.5', installedVersion: '0.1.5' }), '版本变更:当前 运行 0.1.5 / 已装 0.1.5')
  assert.equal(clientBuildInstallVersionHint({ installedVersion: '0.1.5' }), '版本变更:当前 运行 未知 / 已装 0.1.5')
  assert.equal(clientBuildInstallVersionHint({}), '版本变更:当前 运行 未知 / 已装 未知')
})

// 弹窗渲染冒烟:整函数工厂化执行,自由变量全桩注入,断言不抛错且关键行在树中。
// 动态文案(版本行/变更行)已抽 LOGIC 段,此测试兜住组件体对桩外符号的引用回归
test('渲染冒烟: UpgradeDialog 工厂化执行不抛错且含版本变更行', () => {
  const match = CLIENT_SOURCE.match(/function UpgradeDialog\(props\) \{[\s\S]*?\n\}/)
  assert.ok(match, 'client.js 缺少 UpgradeDialog')
  const calls = []
  const h = (type, propsArg, ...children) => { calls.push(String(type)); return { type, propsArg, children } }
  const useState = (init) => [init, () => {}]
  const Switch = (propsArg) => h('label', propsArg)
  const dialog = new Function('h', 'useState', 'Switch', 'DEFAULT_UPGRADE_TEMPLATE', 'AUTO_RESTART_DELAY_SEC',
    'RUNTIME_KIND_MANUAL', 'buildInstallChangeLine', 'buildInstallVersionHint',
    'return (' + match[0] + ')')(
    h, useState, Switch, 'npm install -g @deepseek-ai/dsh@{tag}', 3, 'manual-start-likely',
    (status, command) => '变更:' + command, (status) => '提示:' + status.runningVersion)
  const status = { channel: 'latest', upgradeTemplate: '', runningVersion: '0.1.5', installedVersion: '0.1.5', runtimeEnv: null }
  const tree = dialog({ status, onCancel: () => {}, onConfirm: () => {} })
  assert.equal(tree.type, 'div', '弹窗根为遮罩 div')
  assert.ok(calls.some((type) => type === 'pre'), '命令 pre 节点应在树中')
  assert.deepEqual(dialog({ status, onCancel: () => {}, onConfirm: () => {} }).type, 'div', '二次渲染稳定')
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

// host 侧锚点直接 import runtime.mjs 实现,防测试内手抄字面量漂移假绿
import { RUNTIME_KINDS } from '../src/runtime.mjs'

test('parity: 手动直跑运行环境常量 client 与 host 一致', () => {
  assert.equal(extractConst('RUNTIME_KIND_MANUAL'), RUNTIME_KINDS.MANUAL_START)
})

test('parity: 弹窗文案自动重启延迟秒与 host AUTO_RESTART_DELAY_MS 换算一致', () => {
  assert.equal(extractNumberConst('AUTO_RESTART_DELAY_SEC'), AUTO_RESTART_DELAY_MS / 1000)
})

// host 侧锚点直接 import index.js 实现,防测试内手抄字面量漂移假绿
import {
  DEFAULT_UPGRADE_TEMPLATE,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_REGISTRY_BASE,
  TICK_MS,
  API_PATHS,
  UPGRADE_TIMEOUT_MS,
  UPGRADE_MAX_ATTEMPTS,
  UPGRADE_RETRY_BACKOFF_MS,
  AUTO_RESTART_DELAY_MS,
} from '../src/index.js'

test('parity: 默认升级命令模板 client 字面量与 host 实现一致', () => {
  assert.equal(extractConst('DEFAULT_UPGRADE_TEMPLATE'), DEFAULT_UPGRADE_TEMPLATE)
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
    UPGRADE_TEMPLATE: 'TEMPLATE_URL',
    POLL_INTERVAL: 'POLL_INTERVAL_URL',
    REGISTRY_BASE: 'REGISTRY_BASE_URL',
    UPGRADE: 'UPGRADE_URL',
    RESTART: 'RESTART_URL',
    RELEASE_NOTES: 'RELEASE_NOTES_URL',
  }
  for (const [hostKey, hostPath] of Object.entries(API_PATHS)) {
    assert.equal(extractConst(CLIENT_KEY_BY_HOST_KEY[hostKey]), hostPath, 'API 路径漂移: ' + hostKey)
  }
})

// 窗口关系对拍:重启等待总时长必须大于宿主退出延迟,否则宿主还在延迟退出窗口内客户端已报超时
import { RESTART_DELAY_MS } from '../src/index.js'

test('parity: 重启等待总时长大于宿主退出延迟', () => {
  const restartTimeoutMs = extractNumberConst('RESTART_TIMEOUT_MS')
  assert.ok(restartTimeoutMs > RESTART_DELAY_MS, 'RESTART_TIMEOUT_MS 必须大于 RESTART_DELAY_MS')
})

test('parity: 升级观察上限覆盖宿主重试链上限(防抢跑转状态未知)', () => {
  // 重试链上限 = 尝试次数×单次超时 + 最大退避累计 + 强杀宽限;超时强杀只会终止链,不叠加
  const maxBackoffTotal = Object.values(UPGRADE_RETRY_BACKOFF_MS)
    .reduce((max, seq) => Math.max(max, seq.reduce((sum, ms) => sum + ms, 0)), 0)
  const chainUpperBound = UPGRADE_MAX_ATTEMPTS * UPGRADE_TIMEOUT_MS + maxBackoffTotal + KILL_GRACE_MS
  const watchMaxMs = extractNumberConst('UPGRADE_WATCH_MAX_MS')
  assert.ok(
    watchMaxMs >= chainUpperBound,
    'UPGRADE_WATCH_MAX_MS(' + watchMaxMs + ') 必须不小于重试链上限(' + chainUpperBound + ')',
  )
})

test('parity: npm 版本页链接与追踪包名同源', () => {
  assert.ok(extractConst('NPM_VERSIONS_URL').includes(TARGET_PACKAGE), 'NPM_VERSIONS_URL 应包含 TARGET_PACKAGE 字面量')
})

// release 更新内容事实源在 GitHub Releases:client 兜底链接与 host 拉取仓库必须同源
import { RELEASE_REPO } from '../src/core.mjs'

test('parity: GitHub releases 兜底链接与 host 拉取仓库同源', () => {
  assert.equal(extractConst('RELEASES_PAGE_URL'), 'https://github.com/' + RELEASE_REPO + '/releases')
})

test('parity: 落定补查宽限覆盖宿主自动重启调度延迟', () => {
  // 落定拍与调度置位之间存在宿主侧 await 窗口:client 补查宽限必须不小于调度延迟 + 观察裕量
  const graceMs = extractNumberConst('UPGRADE_AUTO_RESTART_GRACE_MS')
  assert.ok(
    graceMs >= AUTO_RESTART_DELAY_MS + 1 * 1000,
    'UPGRADE_AUTO_RESTART_GRACE_MS(' + graceMs + ') 必须不小于 AUTO_RESTART_DELAY_MS(' + AUTO_RESTART_DELAY_MS + ') 加观察裕量',
  )
})

test('源码契约: 重启轮询与升级观察器不得回退 setInterval 重叠拍形态', () => {
  // 顺序循环 + 代际令牌是 R4 修复形态;setInterval 回归即重叠拍竞态回归
  assert.ok(!/setInterval\(/.test(CLIENT_SOURCE), 'client.js 禁止 setInterval(拍自调度取代)')
  assert.ok(CLIENT_SOURCE.includes('AbortSignal.timeout(UPGRADE_POLL_TIMEOUT_MS)'), '升级观察拍必须带请求超时')
  assert.ok(CLIENT_SOURCE.includes('upgradeWatch.generation !== generation'), '升级观察拍 settle 后必须验代际')
})

test('源码契约: 安装入口全版本状态可点,verdict 不得回归为禁用门', () => {
  // 重装修复与回退是面板显式意图:按钮与弹窗派生门控不得含 verdict 比较;
  // VERDICT_UP_TO_DATE 仅允许出现两次(常量声明 + 结论徽章展示)
  const occurrences = CLIENT_SOURCE.split('VERDICT_UP_TO_DATE').length - 1
  assert.equal(occurrences, 2, 'VERDICT_UP_TO_DATE 只允许声明与徽章展示两处,禁用门回归即超限')
  assert.ok(CLIENT_SOURCE.includes("}, '安装'),"), '升级按钮文案必须为「安装」')
  assert.ok(CLIENT_SOURCE.includes("'确认安装'"), '弹窗标题必须为「确认安装」')
  assert.ok(CLIENT_SOURCE.includes("'开始安装'"), '弹窗确认按钮必须为「开始安装」')
  assert.ok(CLIENT_SOURCE.includes('重装'), '弹窗必须说明重装(修复)场景')
  assert.ok(CLIENT_SOURCE.includes('回退'), '弹窗必须说明回退场景')
})
