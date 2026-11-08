// F18 回归守护(可失败行为测试):设置面(settings 行条目)与执行器挂载快照两个配置
// 真源,写路径落盘后必须由「写侧 validated 快照」收口执行面——执行面立即换源,且不回读
// describe 的陈旧投影;官方行代挂配置以 settings.yaml 的 shell 节为准(guard-config)。
import test from 'node:test'
import assert from 'node:assert/strict'
import ShellSelectExecutor from '../src/executor.mjs'
import { SECTION_NS, buildFaces } from '../src/web-routes.mjs'
import { officialRowConfig } from '../src/guard-config.mjs'

const NODE_EXE = process.execPath

// ---- 执行器桩 ctx(与 executor.test.mjs 同构,只保留本用例触达面) ----
function stubExecutorCtx() {
  const disposers = []
  const registered = { tools: [], promptSections: [] }
  const sandboxPolicy = { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', roots: [] }) }
  const ctx = {
    reflect: { provide: () => {} },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    get: () => undefined,
    inject: (services, fn) => fn({ settings: undefined, effect: (effectFn) => effectFn() }),
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    subprocess: () => ({ collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => true }),
    sandbox: { confine: (argv) => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) },
    sandboxPolicy,
    tools: {
      register: (definition) => {
        registered.tools.push(definition)
        return () => registered.tools.pop()
      },
      get: () => undefined,
      schemas: () => [],
    },
    systemPrompt: { section: (section) => registered.promptSections.push(section), getSectionOrder: () => 'order:t' },
    shellEnv: { collect: () => ({}) },
  }
  return { ctx, registered, disposers }
}

function shells(withGitBash = true) {
  const list = [{ id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: NODE_EXE, args: [], login: false, distro: '', env: {} }]
  if (withGitBash) list.push({ id: 'git-bash', name: 'Git Bash', kind: 'bash', path: NODE_EXE, args: [], login: false, distro: '', env: {} })
  return list
}

/** settings 服务桩:stored 是唯一落盘事实,describe 是页面读投影。 */
function stubSettings(initial) {
  const state = { stored: initial, replaces: [] }
  return {
    state,
    describe: () => [{ ns: SECTION_NS, value: state.stored }],
    replace: async (ns, section) => {
      state.replaces.push({ ns, section })
      state.stored = section
    },
  }
}

test('F18-a 写路径收口:设置面保存后执行面立即换源(deny 生效、删除客户端即时失效)', async () => {
  const { ctx } = stubExecutorCtx()
  const mounted = { shells: shells(true), default: 'pwsh', deny: [] }
  const executor = new ShellSelectExecutor(ctx, mounted)
  // 挂载快照视角:deny 空 → 命令放行;git-bash 可用
  assert.doesNotThrow(() => executor.assertNotDenied('format C:'))
  assert.equal(executor.entryFor('git-bash').id, 'git-bash')

  const settings = stubSettings({ ...mounted })
  const faces = buildFaces({ logger: { warn: () => {} } }, settings)
  const listing = await faces.updateConfig({ deny: ['^format\\s'], shells: shells(false), default: 'pwsh' })
  assert.deepEqual(listing.shells.map((entry) => entry.id), ['pwsh'], '写响应投影按新清单')

  // 执行面必须已经换源(不依赖行重载)
  assert.throws(() => executor.assertNotDenied('format C:'), /blocked by shell-select deny pattern/)
  assert.throws(() => executor.entryFor('git-bash'), /git-bash/, '已删除客户端不得继续可用')
  assert.deepEqual(executor.config.deny, ['^format\\s'])
})

test('F18-b 以哪一侧为准:执行面认写侧 validated 快照,describe 陈旧投影不回退它', async () => {
  const { ctx } = stubExecutorCtx()
  const mounted = { shells: shells(true), default: 'pwsh', deny: [] }
  const executor = new ShellSelectExecutor(ctx, mounted)
  const settings = stubSettings({ ...mounted })
  const faces = buildFaces({ logger: { warn: () => {} } }, settings)
  await faces.updateConfig({ deny: ['^format\\s'], shells: shells(true), default: 'pwsh' })
  assert.throws(() => executor.assertNotDenied('format C:'))

  // 第二个写口(或读回落后)把 settings 面回退成挂载时的旧值
  settings.state.stored = { ...mounted }
  assert.deepEqual(executor.config.deny, ['^format\\s'], '执行面跟随写侧快照,不 lazy 重读 describe')
  assert.throws(() => executor.assertNotDenied('format C:'))
})

test('F18-c guard-config:官方行代挂配置以 settings.yaml 的 shell 节为准,缺节/坏读回落空对象', async () => {
  const section = { timeoutMs: 45_000, mode: 'workspace-write' }
  assert.deepEqual(await officialRowConfig(async () => ({ shell: section })), section, '文档 shell 节原样透传')
  assert.deepEqual(await officialRowConfig(async () => ({})), {}, '缺节交 schema 默认')
  assert.deepEqual(await officialRowConfig(async () => ({ shell: ['nope'] })), {}, '非对象节按缺节处理')
  assert.deepEqual(await officialRowConfig(async () => { throw new Error('read failed') }), {}, '读取失败不阻断代挂')
})
