import test from 'node:test'
import assert from 'node:assert/strict'
import {
  judgeProbeText, judgeActivationSnapshot, judgeUpstreamSeen, judgeLlm, judgeImportFailures, judgeFinal,
} from '../scripts/compat/compat-judges.mjs'
import { WORKSPACE_TEXT, FAIL_BANNER, IMPORT_FAIL_RE, TOKEN_RE, UPSTREAM_PATHS, PLATFORM_GATED_BUNDLES } from '../scripts/compat/compat-criteria.mjs'

/**
 * 判定链纯归约的变异锁:合成「假绿输入」必须产出 false。
 * 对应组 E 变异种子 M1(汇总恒真)/M2(上游留档放松)/M3(activation 折叠)/M4-M5(串漂移);
 * 常量非平凡性断言 = 秒级自检(文件变异轮的替代:常量被改坏时此处先红)。
 */

test('常量_非平凡性_串漂移自检', t => {
  assert.equal(WORKSPACE_TEXT.test('工作区'), true)
  assert.equal(WORKSPACE_TEXT.test('Workspace'), true)
  assert.equal(WORKSPACE_TEXT.test(''), false, '恒真变异(如 /.*/)在此暴露')
  assert.equal(WORKSPACE_TEXT.test('Internal Server Error'), false)
  assert.ok(FAIL_BANNER.length > 0, '空串使 includes 恒真恒红')
  assert.equal(judgeProbeText(`工作区 ${FAIL_BANNER}`), false, '横幅串漂移使检测死,此处锁判定取反')
  assert.equal(IMPORT_FAIL_RE.test('error: failed to import @mzzsfy/dsh-x: boom'), true)
  assert.equal(IMPORT_FAIL_RE.test('error: did not activate @mzzsfy/dsh-x'), true)
  assert.equal(IMPORT_FAIL_RE.test('plugin activated ok'), false)
  TOKEN_RE.lastIndex = 0
  assert.ok(TOKEN_RE.test('boot: http://127.0.0.1:3080/?token=Abc12345_-xyz ready'), 'token 提取串漂移自检')
  assert.deepEqual(UPSTREAM_PATHS, ['/chat/completions', '/messages'])
  assert.ok(PLATFORM_GATED_BUNDLES.length > 0, '空名单使 POSIX liveAll 判定恒红(平台门控包按设计不 live)')
  assert.ok(PLATFORM_GATED_BUNDLES.every((name) => name.startsWith('@mzzsfy/')), '豁免名单只收自有包')
})

test('渲染判定_文案与横幅四象限', t => {
  assert.equal(judgeProbeText('工作区\n模型列表'), true)
  assert.equal(judgeProbeText(''), false)
  assert.equal(judgeProbeText('Failed to load plugins'), false)
  assert.equal(judgeProbeText('工作区 Failed to load plugins'), false)
})

test('activation判定_折叠变异锁', t => {
  assert.equal(judgeActivationSnapshot({ liveAll: true, findingsCount: 0 }), true)
  assert.equal(judgeActivationSnapshot({ liveAll: true, findingsCount: 1 }), false)
  assert.equal(judgeActivationSnapshot({ liveAll: false, findingsCount: 0 }), false)
  assert.equal(judgeActivationSnapshot({ liveAll: true }), false, 'findingsCount 缺失折叠为 0 即假绿(M3)')
  assert.equal(judgeActivationSnapshot(null), false)
  assert.equal(judgeActivationSnapshot(undefined), false)
})

test('上游留档判定_ambient放松变异锁', t => {
  assert.equal(judgeUpstreamSeen([{ path: '/v1/chat/completions' }]), true)
  assert.equal(judgeUpstreamSeen([{ path: '/messages' }]), true)
  assert.equal(judgeUpstreamSeen([{ path: '/v1/models' }]), false, '放松为 lines.length>0 即假绿(M2)')
  assert.equal(judgeUpstreamSeen([]), false)
  assert.equal(judgeUpstreamSeen([{ path: '/v1/models' }, { path: '/chat/completions' }]), true)
})

test('llm判定_三合取', t => {
  assert.equal(judgeLlm(null), false)
  assert.equal(judgeLlm({ providerRegistered: true, chatDriven: true, upstreamSeen: true }), true)
  assert.equal(judgeLlm({ providerRegistered: true, chatDriven: true, upstreamSeen: false }), false)
  assert.equal(judgeLlm({ providerRegistered: false, chatDriven: true, upstreamSeen: true }), false)
  assert.equal(judgeLlm({ providerRegistered: true, chatDriven: false, upstreamSeen: true }), false)
})

test('行级失败提取_正则漂移变异锁', t => {
  assert.deepEqual(
    judgeImportFailures(['error: failed to import @mzzsfy/dsh-x: boom', 'ok line', '@mzzsfy/dsh-y did not activate', 'failed to import loader entry preset-shell-select (@deepseek-ai/dsh-agent-preset): Cannot find package']),
    ['error: failed to import @mzzsfy/dsh-x: boom', '@mzzsfy/dsh-y did not activate', 'failed to import loader entry preset-shell-select (@deepseek-ai/dsh-agent-preset): Cannot find package'],
    '官方包崩因行必须计入(0.1.5 实爆行不在 @mzzsfy 名单,包名过滤即漏检)',
  )
  assert.deepEqual(
    judgeImportFailures(['@mzzsfy/dsh-x did not activate (expected in legacy mode)'], ['legacy mode']),
    [],
    'allowlist 显式豁免已知良性串',
  )
  assert.deepEqual(judgeImportFailures(['@mzzsfy/dsh-x activated']), [])
})

test('终局判定_crashOnly与full合取', t => {
  const full = { crashOnly: false, page: true, browserOk: true, activation: { liveAll: true, findingsCount: 0 }, llm: { providerRegistered: true, chatDriven: true, upstreamSeen: true }, importFailures: [] }
  assert.equal(judgeFinal(full), true)
  for (const [key, bad] of [
    ['page', false],
    ['browserOk', false],
    ['activation', { liveAll: true, findingsCount: 1 }],
    ['activation', { liveAll: false, findingsCount: 0 }],
    ['llm', { providerRegistered: true, chatDriven: true, upstreamSeen: false }],
    ['llm', null],
    ['importFailures', ['x failed to import']],
  ]) {
    assert.equal(judgeFinal({ ...full, [key]: bad }), false, `full 口径 ${key} 劣化必须 FAIL(M1 汇总恒真锁)`)
  }
  assert.equal(judgeFinal({ ...full, crashOnly: true, llm: null, activation: null }), true, '基线口径只判不崩溃三联')
  assert.equal(judgeFinal({ ...full, crashOnly: true, browserOk: false }), false)
})
