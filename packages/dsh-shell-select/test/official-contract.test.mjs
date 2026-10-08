// 官方 ctx.shell 契约钉死 pwsh + 工具层六场景矩阵(前台/后台 × pwsh/git-bash):
// BDD:官方 dsh-pwsh-local 契约即 PowerShell 专用,execute/run/start 落默认
// 客户端会随配置漂移炸方言(官方 pwsh 工具调用在 git-bash 里执行 PowerShell)。
// 后台分支 owner 必须是 agent id(resolveOwner 以 id 查 registry,传对象报
// "[object Object] has no live agent");deny 探测不得真实 spawn(命令双跑)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ShellSelectExecutor from '../src/executor.mjs'
import { registerShellTool } from '../src/tool.mjs'

function stubReader(text) {
  return { readFrom: () => ({ text, lossy: false, nextOffset: text.length }) }
}

function stubSpawn(stdoutText = '', stderrText = '', exitCode = 0) {
  const calls = []
  const spawn = (spec) => {
    calls.push(spec)
    return {
      collected: { stdout: stubReader(stdoutText), stderr: stubReader(stderrText) },
      done: Promise.resolve({ exitCode, signal: null }),
      terminate: () => true,
    }
  }
  return { spawn, calls }
}

const SHELLS = [
  { id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: process.execPath },
  { id: 'git-bash', name: 'Git Bash', kind: 'bash', path: process.execPath },
]

function buildExecutor({ defaultId = 'git-bash', deny = [] } = {}) {
  const stub = stubSpawn('out', '', 0)
  const registered = { tools: [] }
  const jobs = { starts: [] }
  const ctx = {
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
    get(service) {
      if (service === 'webServer') return { register: () => {} }
      if (service === 'jobs') return jobsApi()
      return undefined
    },
    inject(services, fn) {
      fn({ settings: undefined, effect: (effectFn) => effectFn() })
    },
    subprocess: stub,
    sandbox: { confine: (argv) => ({ argv: ['WRAPPED', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) },
    sandboxPolicy: { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', roots: [] }) },
    tools: { register: (definition) => { registered.tools.push(definition); return () => registered.tools.pop() } },
    systemPrompt: { section: () => {}, getSectionOrder: (key) => key },
    shellEnv: { collect: () => ({}) },
    effect: (fn) => fn(),
  }
  function jobsApi() {
    return {
      start(spec) {
        jobs.starts.push(spec)
        const outcome = spec.run()
        return { id: `job-${jobs.starts.length}`, done: outcome.done, read: () => outcome.readOutput() }
      },
    }
  }
  const executor = new ShellSelectExecutor(ctx, { shells: SHELLS, default: defaultId, deny })
  return { executor, ctx, stub, registered, jobs }
}

const execFor = (id) => ({ signal: new AbortController().signal, agent: { id, session: { header: { cwd: process.cwd() } } } })
const EXEC = execFor('agent-0')

test('execute 契约钉死 pwsh:default=git-bash 时仍走 pwsh argv', async () => {
  const { executor, stub } = buildExecutor({ defaultId: 'git-bash' })
  const handle = await executor.execute(executor.resolve({ command: 'Get-Date', workdir: process.cwd() }))
  await handle.result()
  assert.match(stub.calls[0].argv.at(-1), /Get-Date$/)
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

test('start 契约钉死 pwsh:default=git-bash 时仍走 pwsh argv', () => {
  const { executor, stub } = buildExecutor({ defaultId: 'git-bash' })
  const proc = executor.start(executor.resolve({ command: 'Get-Date', workdir: process.cwd(), onExpiry: 'none' }))
  return proc.done.then(() => {
    assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
  })
})

test('配置删除 pwsh 条目:契约现场探测仍走 pwsh,不落默认客户端', async () => {
  const { executor, stub } = buildExecutor({ defaultId: 'git-bash' })
  executor.refresh({ shells: SHELLS.filter((entry) => entry.id !== 'pwsh'), default: 'git-bash' })
  assert.throws(() => executor.entryFor('pwsh'), /pwsh/)
  const entry = executor.contractEntry()
  assert.equal(entry.kind, 'pwsh')
  const handle = await executor.execute(executor.resolve({ command: 'Get-Date', workdir: process.cwd() }))
  await handle.result()
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

// --- 工具层六场景矩阵 ---

test('矩阵:shell 前台 pwsh(git-bash 默认)', async () => {
  const { executor, ctx, stub, registered } = buildExecutor({ defaultId: 'git-bash' })
  registerShellTool(ctx, { executor })
  const shellTool = registered.tools.find((tool) => tool.name === 'shell')
  const value = await shellTool.execute({ command: 'Write-Output hi', description: 'probe', shell: 'pwsh', workdir: process.cwd() }, EXEC)
  assert.equal(value.kind, 'foreground')
  assert.equal(value.shell, 'pwsh')
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

test('矩阵:shell 前台 git-bash(默认)', async () => {
  const { executor, ctx, stub, registered } = buildExecutor({ defaultId: 'git-bash' })
  registerShellTool(ctx, { executor })
  const shellTool = registered.tools.find((tool) => tool.name === 'shell')
  const value = await shellTool.execute({ command: 'echo hi', description: 'probe', workdir: process.cwd() }, EXEC)
  assert.equal(value.kind, 'foreground')
  assert.equal(value.shell, 'git-bash')
  assert.deepEqual(stub.calls[0].argv.slice(1, 3), ['-c', 'echo hi'])
})

test('矩阵:pwsh 工具前台(钉死 pwsh)', async () => {
  const { executor, ctx, stub, registered } = buildExecutor({ defaultId: 'git-bash' })
  registerShellTool(ctx, { executor })
  const pwshTool = registered.tools.find((tool) => tool.name === 'pwsh')
  const value = await pwshTool.execute({ command: 'Get-Date', description: 'probe', workdir: process.cwd() }, EXEC)
  assert.equal(value.shell, 'pwsh')
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

async function backgroundCase({ shellArg, defaultId }) {
  const { executor, ctx, stub, registered, jobs } = buildExecutor({ defaultId })
  registerShellTool(ctx, { executor })
  const shellTool = registered.tools.find((tool) => tool.name === 'shell')
  const args = { command: 'echo hi', description: 'probe', run_in_background: true, workdir: process.cwd() }
  if (shellArg !== undefined) args.shell = shellArg
  const value = await shellTool.execute(args, { signal: new AbortController().signal, agent: execFor('agent-1').agent })
  assert.equal(value.kind, 'background')
  assert.equal(jobs.starts.length, 1)
  assert.equal(jobs.starts[0].owner, 'agent-1', 'owner 必须是 agent id 而非对象')
  const expectedKind = shellArg === 'pwsh' || (shellArg === undefined && defaultId === 'pwsh') ? 'pwsh' : 'bash'
  assert.equal(executor.entryFor(shellArg).kind, expectedKind)
  return { stub, jobs }
}

test('矩阵:后台 default(git-bash)', async () => {
  const { stub, jobs } = await backgroundCase({ defaultId: 'git-bash' })
  await jobs.starts[0].run // run() 已在 start 内同步执行
  await Promise.resolve()
  assert.equal(stub.calls.length, 1, 'deny 探测不得真实 spawn,整个后台任务只 spawn 一次')
  assert.deepEqual(stub.calls[0].argv.slice(1, 3), ['-c', 'echo hi'])
})

test('矩阵:后台 shell=pwsh', async () => {
  const { stub } = await backgroundCase({ shellArg: 'pwsh', defaultId: 'git-bash' })
  await Promise.resolve()
  assert.equal(stub.calls.length, 1)
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

test('矩阵:后台 default=pwsh(默认即 pwsh)', async () => {
  const { stub } = await backgroundCase({ defaultId: 'pwsh' })
  await Promise.resolve()
  assert.equal(stub.calls.length, 1)
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

test('矩阵:后台 pwsh 工具(钉死 pwsh)', async () => {
  const { executor, ctx, stub, registered, jobs } = buildExecutor({ defaultId: 'git-bash' })
  registerShellTool(ctx, { executor })
  const pwshTool = registered.tools.find((tool) => tool.name === 'pwsh')
  const value = await pwshTool.execute(
    { command: 'Get-Date', description: 'probe', run_in_background: true, workdir: process.cwd() },
    { signal: new AbortController().signal, agent: execFor('agent-2').agent },
  )
  assert.equal(value.kind, 'background')
  assert.equal(jobs.starts[0].owner, 'agent-2')
  await Promise.resolve()
  assert.equal(stub.calls.length, 1)
  assert.deepEqual(stub.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

test('矩阵:后台 deny 命中,启动前拒绝且零 spawn', async () => {
  const { executor, ctx, stub, registered, jobs } = buildExecutor({ defaultId: 'git-bash', deny: ['forbidden'] })
  registerShellTool(ctx, { executor })
  const shellTool = registered.tools.find((tool) => tool.name === 'shell')
  const value = await shellTool.execute(
    { command: 'echo forbidden thing', description: 'probe', run_in_background: true, workdir: process.cwd() },
    { signal: new AbortController().signal, agent: execFor('agent-3').agent },
  )
  assert.equal(value.kind, 'foreground', 'deny 命中回退前台拒绝形态')
  assert.equal(jobs.starts.length, 0)
  assert.equal(stub.calls.length, 0)
})
