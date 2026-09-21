// executor 官方 seam 集成(桩 ctx):BDD 场景见本文件与 README「官方工具兼容」。
// 背景:preset 注入的官方 tool-pwsh 经 cordis 服务代理(ctx.shell)调用执行器,
// 代理把方法 this 重定向到阴影对象;执行器公开面必须与官方 PwshLocalExecutor
// 同构地使用公有字段/方法(#私有在阴影 receiver 下触发品牌检查错误)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ShellSelectExecutor from '../src/executor.mjs'
import { Config } from '../src/config.mjs'

function stubReader(text) {
  return { readFrom: () => ({ text, lossy: false, nextOffset: text.length }) }
}

function stubSpawn(stdoutText = '', stderrText = '', exitCode = 0) {
  const calls = []
  const spawn = (spec) => {
    calls.push(spec)
    return {
      collected: {
        stdout: stubReader(stdoutText),
        stderr: stubReader(stderrText),
      },
      done: Promise.resolve({ exitCode, signal: null }),
      terminate: () => true,
    }
  }
  return { spawn, calls }
}

function stubCtx({ sandboxMode = 'danger-full-access', spawn = stubSpawn() } = {}) {
  const registered = { tools: [], sections: [], promptSections: [], routes: [] }
  const settingsImpl = {
    installSection: (ctx, ns, schema, base, hooks) => {
      registered.sections.push({ ns, schema, base, hooks })
      settingsImpl._source = () => Config(base ?? {})
    },
  }
  const ctx = {
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
    get(service) {
      if (service === 'webServer') return { register: (item) => registered.routes.push(item.path) }
      return undefined
    },
    subprocess: spawn,
    sandbox: {
      confine: (argv, policy) => ({
        argv: ['WRAPPED', ...argv],
        enforcement: 'full',
        denialSignatures: ['file access denied'],
        runnerFailureRules: [],
        _policy: policy,
      }),
    },
    sandboxPolicy: {
      defaultMode: sandboxMode,
      resolve: () => ({ mode: sandboxMode, roots: [] }),
    },
    tools: {
      register: (definition) => {
        registered.tools.push(definition)
        return () => registered.tools.pop()
      },
    },
    systemPrompt: {
      section: (section) => registered.promptSections.push(section),
      getSectionOrder: (key) => `order:${key}`,
    },
    shellEnv: { collect: () => ({ DSH_TEST: '1' }) },
    settings: settingsImpl,
    effect: (fn) => fn(),
  }
  return { ctx, registered }
}

/** cordis 阴影 receiver 模拟:服务方法被以非实例 receiver 调用(Reflect.get 语义)。 */
function shadow(executor) {
  return Object.create(executor)
}


// 跨平台显式 path:node 自身在所有平台存在,注入后 entryFor/listShells 不依赖真实 shell
// (CI linux 无 pwsh/cmd/git-bash,出厂 auto 探测必失败)
const NODE_EXE = process.execPath
function baseConfig() {
  return {
    shells: [
      { id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: NODE_EXE },
      { id: 'git-bash', name: 'Git Bash', kind: 'bash', path: NODE_EXE },
      { id: 'cmd', name: 'CMD', kind: 'cmd', path: NODE_EXE },
    ],
    default: 'pwsh',
  }
}

test('官方 run seam:存在且走默认客户端,spec 已解析形态(danger 直跑)', async () => {
  const spawn = stubSpawn('seam-out', '')
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(typeof executor.run, 'function')
  const result = await executor.run(executor.resolve({ command: 'Get-Date', workdir: process.cwd() }))
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].argv[0], executor.entryFor('pwsh').path)
  assert.equal(result.stdout.text, 'seam-out')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
})

test('官方 start seam:存在且返回 ShellProcess 形态句柄', async () => {
  const spawn = stubSpawn('bg', '')
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(typeof executor.start, 'function')
  const proc = executor.start(executor.resolve({ command: 'sleep 1', workdir: process.cwd() }))
  assert.equal(proc.status, 'running')
  await proc.done
  assert.equal(proc.status, 'completed')
})

test('cordis 阴影 receiver:公开面调用不触发私有品牌错误', () => {
  const { ctx } = stubCtx()
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const mirrored = shadow(executor)
  // 官方 tool-pwsh 的调用面:resolve/run/start + apply 期 sandboxMode
  assert.doesNotThrow(() => mirrored.resolve({ command: 'x' }))
  assert.equal(typeof mirrored.run, 'function')
  assert.equal(typeof mirrored.start, 'function')
  assert.equal(mirrored.entryFor(undefined).id, 'pwsh')
  assert.ok(Array.isArray(mirrored.listShells().shells))
  assert.equal(mirrored.config.default, 'pwsh')
  assert.equal(mirrored.sandboxMode, 'danger-full-access')
})

test('cordis 阴影 receiver:受限模式 run 全链路(confine + 结果分类)', async () => {
  const spawn = stubSpawn('', 'file access denied here', 1)
  const { ctx } = stubCtx({ spawn, sandboxMode: 'read-only' })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const mirrored = shadow(executor)
  const result = await mirrored.run(mirrored.resolve({ command: 'dir', workdir: process.cwd() }))
  assert.equal(spawn.calls[0].argv[0], 'WRAPPED')
  assert.equal(result.sandbox.denied, true)
  assert.equal(result.sandbox.mode, 'read-only')
})

test('sandboxMode:透出部署默认模式,策略缺席时 undefined', () => {
  const { ctx } = stubCtx({ sandboxMode: 'workspace-write' })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(executor.sandboxMode, 'workspace-write')
  const bare = new ShellSelectExecutor({ ...ctx, sandboxPolicy: undefined }, baseConfig())
  assert.equal(bare.sandboxMode, undefined)
})
