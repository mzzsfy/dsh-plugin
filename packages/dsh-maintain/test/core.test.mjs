import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSemver,
  gtSemver,
  judgeVersion,
  judgeUpgradeFreshness,
  isVersionPendingRestart,
  classifyUpgradeFailure,
  buildUpgradeCommand,
  isValidChannelName,
  isValidRegistryBase,
  shouldReloadAfterRestart,
  VERDICT_OUTDATED,
  VERDICT_UP_TO_DATE,
  VERDICT_UNKNOWN,
  UPGRADE_FAIL_TRANSIENT_NETWORK,
  UPGRADE_FAIL_FILE_LOCKED,
  UPGRADE_FAIL_NPM_MISSING,
  UPGRADE_FAIL_TIMEOUT,
  UPGRADE_FAIL_UNKNOWN,
} from '../src/core.mjs'

const CURRENT = '0.1.1-rc.2'

test('semver 解析:标准版本含 prerelease 与 build', () => {
  const parsed = parseSemver('1.2.3-rc.2+build.7')
  assert.deepEqual(
    { major: parsed.major, minor: parsed.minor, patch: parsed.patch, prerelease: parsed.prerelease },
    { major: 1, minor: 2, patch: 3, prerelease: ['rc', 2] },
  )
})

test('semver 解析:非 semver 字符串返回 null', () => {
  assert.equal(parseSemver('latest'), null)
  assert.equal(parseSemver(''), null)
  assert.equal(parseSemver(null), null)
  assert.equal(parseSemver('1.2'), null)
  assert.equal(parseSemver('01.2.3'), null)
})

test('semver 比较:prerelease 数值序 rc.2 低于 rc.10', () => {
  assert.equal(gtSemver('0.1.1-rc.10', '0.1.1-rc.2'), true)
  assert.equal(gtSemver('0.1.1-rc.2', '0.1.1-rc.10'), false)
})

test('semver 比较:无 prerelease 高于有 prerelease', () => {
  assert.equal(gtSemver('0.1.1', '0.1.1-rc.2'), true)
  assert.equal(gtSemver('0.1.1-rc.2', '0.1.1'), false)
})

test('semver 比较:spec 官方示例链严格升序', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 1; i < chain.length; i++) {
    assert.equal(gtSemver(chain[i], chain[i - 1]), true, chain[i] + ' 应高于 ' + chain[i - 1])
    assert.equal(gtSemver(chain[i - 1], chain[i]), false, chain[i - 1] + ' 不应高于 ' + chain[i])
  }
})

test('semver 比较:build 元数据不参与比较', () => {
  assert.equal(gtSemver('1.0.0+build.1', '1.0.0+build.2'), false)
  assert.equal(gtSemver('1.0.0', '1.0.0+build.2'), false)
})

test('semver 比较:含非法版本返回 false', () => {
  assert.equal(gtSemver('not-a-version', '1.0.0'), false)
  assert.equal(gtSemver('1.0.0', null), false)
})

test('场景:通道落后判定', () => {
  const result = judgeVersion({ currentVersion: CURRENT, tags: { latest: '0.1.2-alpha.3', next: CURRENT }, channel: 'latest' })
  assert.equal(result.verdict, VERDICT_OUTDATED)
  assert.equal(result.channelLatest, '0.1.2-alpha.3')
  assert.equal(result.reason, null)
})

test('场景:通道切换后判定跟随', () => {
  const tags = { latest: '0.1.2-alpha.3', next: CURRENT, alpha: '0.1.2-alpha.3' }
  assert.equal(judgeVersion({ currentVersion: CURRENT, tags, channel: 'alpha' }).verdict, VERDICT_OUTDATED)
  assert.equal(judgeVersion({ currentVersion: CURRENT, tags, channel: 'next' }).verdict, VERDICT_UP_TO_DATE)
})

test('场景:已是最新判定', () => {
  const result = judgeVersion({ currentVersion: CURRENT, tags: { latest: CURRENT }, channel: 'latest' })
  assert.equal(result.verdict, VERDICT_UP_TO_DATE)
})

test('场景:通道不在 dist-tags 判未知', () => {
  const result = judgeVersion({ currentVersion: CURRENT, tags: { latest: CURRENT }, channel: 'beta' })
  assert.equal(result.verdict, VERDICT_UNKNOWN)
  assert.equal(result.channelLatest, null)
  assert.match(result.reason, /beta/)
})

test('场景:当前版本或 tags 缺失判未知', () => {
  assert.equal(judgeVersion({ currentVersion: null, tags: { latest: '1.0.0' }, channel: 'latest' }).verdict, VERDICT_UNKNOWN)
  assert.equal(judgeVersion({ currentVersion: CURRENT, tags: null, channel: 'latest' }).verdict, VERDICT_UNKNOWN)
})

test('场景:版本字符串非法判未知', () => {
  const result = judgeVersion({ currentVersion: 'dev-main', tags: { latest: '1.0.0' }, channel: 'latest' })
  assert.equal(result.verdict, VERDICT_UNKNOWN)
  assert.match(result.reason, /dev-main/)
})

test('场景:升级命令占位符替换', () => {
  const command = buildUpgradeCommand({ template: 'npm install -g @deepseek-ai/dsh@{tag}', tag: 'next' })
  assert.equal(command, 'npm install -g @deepseek-ai/dsh@next')
})

test('场景:升级命令模板可整体自改为无占位符命令', () => {
  const command = buildUpgradeCommand({ template: 'pnpm add -g @deepseek-ai/dsh', tag: 'alpha' })
  assert.equal(command, 'pnpm add -g @deepseek-ai/dsh')
})

test('场景:升级命令占位符多次出现全部替换', () => {
  const command = buildUpgradeCommand({ template: 'echo {tag} {tag}', tag: 'latest' })
  assert.equal(command, 'echo latest latest')
})

test('场景:升级命令模板为空拒绝执行', () => {
  assert.throws(() => buildUpgradeCommand({ template: '   ', tag: 'latest' }), /模板/)
  assert.throws(() => buildUpgradeCommand({ template: null, tag: 'latest' }), /模板/)
})

test('场景:tag 含 shell 元字符拒绝执行(远端数据回流成命令的拦截点)', () => {
  for (const tag of ['latest; rm -rf /', 'x && calc', 'a|b', '$(whoami)', '`id`', 'a b', '']) {
    assert.throws(() => buildUpgradeCommand({ template: 'npm install -g pkg@{tag}', tag }), /非法字符/, tag)
  }
  for (const tag of ['latest', 'next', 'beta-1.2', 'canary_ignored', 'v1.0.0-rc.1']) {
    assert.doesNotThrow(() => buildUpgradeCommand({ template: 'npm install -g pkg@{tag}', tag }), tag)
  }
})

test('场景:tag 白名单形态对齐 npm dist-tag 规则(首尾字母数字,上限 214)', () => {
  assert.equal(isValidChannelName('..'), false)
  assert.equal(isValidChannelName('.a'), false)
  assert.equal(isValidChannelName('a.'), false)
  assert.equal(isValidChannelName('-a'), false)
  assert.equal(isValidChannelName('a'), true)
  assert.equal(isValidChannelName('a' + 'b'.repeat(213)), true, '恰 214 字符放行')
  assert.equal(isValidChannelName('a' + 'b'.repeat(214)), false, '超 214 拒绝')
})

test('场景:registry 基地址合法判定', () => {
  assert.equal(isValidRegistryBase('https://registry.npmmirror.com'), true)
  assert.equal(isValidRegistryBase('http://127.0.0.1:4873'), true)
  assert.equal(isValidRegistryBase('  https://example.com  '), true)
  assert.equal(isValidRegistryBase('HTTPS://example.com'), true)
})

test('场景:registry 基地址非法判定', () => {
  assert.equal(isValidRegistryBase('registry.npmmirror.com'), false)
  assert.equal(isValidRegistryBase('ftp://example.com'), false)
  assert.equal(isValidRegistryBase(''), false)
  assert.equal(isValidRegistryBase('   '), false)
  assert.equal(isValidRegistryBase(null), false)
  assert.equal(isValidRegistryBase(undefined), false)
})

test('场景:重启失联后恢复触发刷新', () => {
  assert.equal(shouldReloadAfterRestart({ lost: true, pid: 100, bootAt: 1 }, { lost: false, pid: 100, bootAt: 1 }), true)
  assert.equal(shouldReloadAfterRestart({ lost: true, pid: null, bootAt: null }, { lost: false, pid: null, bootAt: null }), true)
})

test('场景:快速重启零失联凭 pid 变化触发刷新', () => {
  assert.equal(shouldReloadAfterRestart({ lost: false, pid: 100, bootAt: 1 }, { lost: false, pid: 200, bootAt: 2 }), true)
})

test('场景:容器 pid 恒 1 零失联凭 bootAt 变化触发刷新', () => {
  // Docker entrypoint 常驻 pid 1 + 停机时长小于轮询间隔:pid 信号结构性失效,
  // bootAt(宿主进程启动时刻)变化是唯一可靠代际信号
  assert.equal(shouldReloadAfterRestart({ lost: false, pid: 1, bootAt: 100 }, { lost: false, pid: 1, bootAt: 200 }), true)
})

test('场景:未失联且实例标识未变不刷新', () => {
  assert.equal(shouldReloadAfterRestart({ lost: false, pid: 100, bootAt: 1 }, { lost: false, pid: 100, bootAt: 1 }), false)
  // 单侧缺失退化为 pid 比对;pid/bootAt 双双缺失不构成重启证据
  assert.equal(shouldReloadAfterRestart({ lost: false, pid: null, bootAt: null }, { lost: false, pid: 200, bootAt: 2 }), false)
  assert.equal(shouldReloadAfterRestart({ lost: false, pid: 100, bootAt: 1 }, { lost: false, pid: undefined, bootAt: undefined }), false)
  // bootAt 单侧出现不构成证据(防旧宿主快照缺字段误判)
  assert.equal(shouldReloadAfterRestart({ lost: false, pid: 100, bootAt: null }, { lost: false, pid: 100, bootAt: 200 }), false)
})

// 升级失败分类:npm 输出特征取自 npm 10/11 真实错误行形态(npm error code/syscall),
// 特征未命中一律宽松归 unknown,不可重试类绝不重试。
test('分类:Windows 文件锁形态归 file-locked 且可重试', () => {
  const samples = [
    'npm error code EBUSY\nnpm error syscall rename\nnpm error path C:\\nvm\\node_modules\\@deepseek-ai\\dsh\\package.json',
    'npm error code EPERM\nnpm error syscall unlink\nnpm error path C:\\nvm\\node_modules\\.bin\\dsh.cmd',
    'npm error code ENOENT\nnpm error syscall rename\nnpm error path C:\\nvm\\node_modules\\@deepseek-ai\\dsh',
    'C:\\nvm\\node_modules\\@deepseek-ai\\dsh\\lib\\index.js is being used by another process',
    'EBUSY: resource busy or locked, unlink C:\\nvm\\node_modules\\@deepseek-ai\\dsh\\lib\\index.js',
  ]
  for (const stderrTail of samples) {
    const result = classifyUpgradeFailure({ code: 1, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail })
    assert.equal(result.kind, UPGRADE_FAIL_FILE_LOCKED, stderrTail)
    assert.equal(result.retryable, true, stderrTail)
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  }
})

test('分类:网络瞬断形态归 transient-network 且可重试', () => {
  const samples = [
    'npm error network request to https://registry.npmjs.org/@deepseek-ai%2fdsh failed, reason: socket hang up',
    'npm error code ECONNRESET\nnpm error errno ECONNRESET\nnpm error network This is a problem related to network connectivity.',
    'npm error code EAI_AGAIN\nnpm error syscall getaddrinfo',
    'npm error code ECONNREFUSED',
    'fetch failed',
    'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/dsh',
  ]
  for (const stderrTail of samples) {
    const result = classifyUpgradeFailure({ code: 1, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail })
    assert.equal(result.kind, UPGRADE_FAIL_TRANSIENT_NETWORK, stderrTail)
    assert.equal(result.retryable, true, stderrTail)
  }
})

test('分类:命令未找到形态归 npm-missing 且不可重试', () => {
  const samples = [
    "'npmm' 不是内部或外部命令,也不是可运行的程序或批处理文件。",
    '/bin/sh: 1: npmm: command not found',
    '/bin/sh: 1: npmm: not found',
    'spawn npmm ENOENT',
  ]
  for (const stderrTail of samples) {
    const result = classifyUpgradeFailure({ code: 1, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail })
    assert.equal(result.kind, UPGRADE_FAIL_NPM_MISSING, stderrTail)
    assert.equal(result.retryable, false, stderrTail)
  }
})

test('分类:超时强杀优先归 timeout,尾流含文件锁特征也不重试', () => {
  const result = classifyUpgradeFailure({ code: null, timedOut: true, stillRunning: false, stdoutTail: '', stderrTail: 'npm error code EBUSY' })
  assert.equal(result.kind, UPGRADE_FAIL_TIMEOUT)
  assert.equal(result.retryable, false)
})

test('分类:未识别输出归 unknown 兜底且不可重试', () => {
  for (const input of [
    { code: 3, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail: 'boom-fail' },
    { code: 1, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail: '' },
    { code: null, timedOut: false, stillRunning: true, stdoutTail: '', stderrTail: '' },
    { code: 1, timedOut: false, stillRunning: false, stdoutTail: 'npm warn deprecated x', stderrTail: 'exit 1' },
  ]) {
    const result = classifyUpgradeFailure(input)
    assert.equal(result.kind, UPGRADE_FAIL_UNKNOWN, JSON.stringify(input))
    assert.equal(result.retryable, false, JSON.stringify(input))
  }
})

test('分类:stdout 尾流特征同样参与匹配', () => {
  const result = classifyUpgradeFailure({ code: 1, timedOut: false, stillRunning: false, stdoutTail: 'npm error code EBUSY', stderrTail: '' })
  assert.equal(result.kind, UPGRADE_FAIL_FILE_LOCKED)
  assert.equal(result.retryable, true)
})

test('分类:输入字段缺省容忍不抛错', () => {
  const result = classifyUpgradeFailure({})
  assert.equal(result.kind, UPGRADE_FAIL_UNKNOWN)
  assert.equal(result.retryable, false)
  assert.ok(typeof result.reason === 'string')
})

// 升级后磁盘版本复读判定:stale=版本未前进或未达通道目标;信息缺失宽松不误报。
test('复读:版本前进且达通道目标判 fresh', () => {
  assert.deepEqual(judgeUpgradeFreshness({ previousVersion: '1.0.0', installedVersion: '2.0.0', channelLatest: '2.0.0' }), { stale: false, reason: null })
  // prerelease 目标达成也算 fresh;prerelease 低于正式版属未达目标(见下例)
  assert.deepEqual(judgeUpgradeFreshness({ previousVersion: '2.0.0', installedVersion: '2.1.0-rc.1', channelLatest: '2.1.0-rc.1' }), { stale: false, reason: null })
})

test('复读:磁盘版本未前进或回退判 stale', () => {
  const same = judgeUpgradeFreshness({ previousVersion: '1.0.0', installedVersion: '1.0.0', channelLatest: '2.0.0' })
  assert.equal(same.stale, true)
  assert.match(same.reason, /未前进/)
  const rollback = judgeUpgradeFreshness({ previousVersion: '2.0.0', installedVersion: '1.9.0', channelLatest: '2.0.0' })
  assert.equal(rollback.stale, true)
})

test('复读:前进但未达通道目标判 stale', () => {
  const result = judgeUpgradeFreshness({ previousVersion: '1.0.0', installedVersion: '1.5.0', channelLatest: '2.0.0' })
  assert.equal(result.stale, true)
  assert.match(result.reason, /未达/)
})

// 运行/已装版本区分:磁盘版本领先运行版本即待重启生效;任一侧不可解析一律 false 不误报。
test('重启待生效:仅已装版本严格领先运行版本时为真', () => {
  assert.equal(isVersionPendingRestart({ runningVersion: '1.0.0', installedVersion: '2.0.0' }), true)
  assert.equal(isVersionPendingRestart({ runningVersion: '2.1.0-rc.1', installedVersion: '2.1.0' }), true)
  assert.equal(isVersionPendingRestart({ runningVersion: '2.0.0', installedVersion: '2.0.0' }), false)
  assert.equal(isVersionPendingRestart({ runningVersion: '3.0.0', installedVersion: '2.0.0' }), false)
  assert.equal(isVersionPendingRestart({ runningVersion: null, installedVersion: '2.0.0' }), false)
  assert.equal(isVersionPendingRestart({ runningVersion: '2.0.0', installedVersion: null }), false)
  assert.equal(isVersionPendingRestart({ runningVersion: 'dev-main', installedVersion: '2.0.0' }), false)
})

test('复读:installed 解析失败判 stale,previous 缺失不豁免未达目标', () => {
  const broken = judgeUpgradeFreshness({ previousVersion: '1.0.0', installedVersion: null, channelLatest: '2.0.0' })
  assert.equal(broken.stale, true)
  assert.match(broken.reason, /解析失败|读取/)
  const garbage = judgeUpgradeFreshness({ previousVersion: '1.0.0', installedVersion: 'dev-main', channelLatest: '2.0.0' })
  assert.equal(garbage.stale, true)
  // 旧版本未知只豁免"未前进"分支:磁盘低于通道目标仍判 stale
  const unknownPrevious = judgeUpgradeFreshness({ previousVersion: null, installedVersion: '1.5.0', channelLatest: '2.0.0' })
  assert.equal(unknownPrevious.stale, true)
  assert.match(unknownPrevious.reason, /未达/)
  assert.deepEqual(judgeUpgradeFreshness({ previousVersion: null, installedVersion: '2.0.0', channelLatest: '2.0.0' }), { stale: false, reason: null })
  // 通道目标缺失时无法证明未达标,宽松判 fresh
  assert.deepEqual(judgeUpgradeFreshness({ previousVersion: '1.0.0', installedVersion: '2.0.0', channelLatest: null }), { stale: false, reason: null })
})
