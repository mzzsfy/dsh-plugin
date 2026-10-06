// executor 集成(桩 ctx):BDD 场景见 docs/progress/shell-select-plan.md「executor」。
// 桩 subprocess 用立即可收的假输出;桩 tools/systemPrompt/settings/webServer 记录注册。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ShellSelectExecutor from '../src/executor.mjs'
import { resolveConfig, assertServiceableConfig } from '../src/config.mjs'

// --- 桩具 ---

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

function stubCtx({ withSettings = true, sandboxMode = 'danger-full-access', spawn = stubSpawn() } = {}) {
  const registered = { tools: [], sections: [], promptSections: [], routes: [], policies: [] }
  const settingsImpl = {
    configure: (presentation, fiber) => {
      registered.policies.push({ presentation, fiber })
    },
  }
  const disposers = []
  const childEffects = []
  const ctx = {
    // cordis Service 基类构造期要求 reflect.provide(登记服务实例),桩空转
    reflect: { provide: () => {} },
    logger: { warn: (msg) => registered.warnings?.push(msg) },
    get(service) {
      if (service === 'webServer') {
        return { register: (item) => registered.routes.push(item.path) }
      }
      return undefined
    },
    // 可选子级注入(设置页策略形态):子级立即执行,effect 收集待验
    inject(services, fn) {
      const child = {
        settings: withSettings ? settingsImpl : undefined,
        effect: (effectFn) => {
          const disposer = effectFn()
          childEffects.push(disposer)
          return disposer
        },
      }
      fn(child)
    },
    subprocess: spawn,
    sandbox: {
      confine: (argv, policy) => ({
        argv: ['WRAPPED', ...argv],
        enforcement: 'full',
        denialSignatures: ['file access denied'],
        runnerFailureRules: [{ fatalSignatures: ['runner died'] }],
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
        return () => {
          registered.tools.pop()
        }
      },
    },
    systemPrompt: {
      section: (section) => registered.promptSections.push(section),
      getSectionOrder: (key) => `order:${key}`,
    },
    shellEnv: { collect: () => ({ DSH_TEST: '1' }) },
    settings: withSettings ? settingsImpl : undefined,
    effect: (fn) => {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    _childEffects: childEffects,
  }
  return { ctx, registered, disposers }
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

function build() {
  const { ctx, registered } = stubCtx()
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  return { executor, registered }
}

// --- 断言 ---

test('构造:注册 shell+pwsh 双工具与 systemPrompt 段,路由不再由主行挂载', () => {
  const { registered } = build()
  assert.deepEqual(registered.tools.map((tool) => tool.name).sort(), ['pwsh', 'shell'])
  const shell = registered.tools.find((tool) => tool.name === 'shell')
  const pwsh = registered.tools.find((tool) => tool.name === 'pwsh')
  assert.match(shell.description, /git-bash/)
  // 兼容工具描述一句话:不要调用,使用 shell
  assert.equal(pwsh.description, 'Do not call; use `shell`.')
  assert.ok(!('shell' in pwsh.parameters.properties))
  assert.ok('shell' in shell.parameters.properties)
  assert.equal(registered.promptSections.length, 1)
  // 数据通道迁至 web-routes 行:主行零路由
  const routePaths = registered.routes.filter((path) => String(path).startsWith('/api/shell-select/'))
  assert.equal(routePaths.length, 0)
})

test('settings 在场:注册 auto:false 页面策略挂本行 fiber(自带设置页,官方同构)', () => {
  const { ctx, registered } = stubCtx()
  const fiber = { id: 'fiber-1' }
  ctx.fiber = fiber
  new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(registered.policies.length, 1)
  assert.deepEqual(registered.policies[0].presentation, { auto: false })
  assert.equal(registered.policies[0].fiber, fiber)
})

test('settings 缺席:策略静默跳过,双工具照常注册(业务插件无 settings 也可运行)', () => {
  const { ctx, registered } = stubCtx({ withSettings: false })
  new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(registered.policies.length, 0)
  assert.equal(registered.tools.length, 2)
})

test('pwsh 工具钉死 pwsh 客户端:default 漂移不改变落点(旧会话语义保真)', async () => {
  const spawn = stubSpawn('ok', '', 0)
  const { ctx, registered } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const pwshTool = registered.tools.find((tool) => tool.name === 'pwsh')
  // 模型无 shell 参数可传(pinned 工具),default 漂到 git-bash 也不影响
  executor.refresh({ shells: baseConfig().shells, default: 'git-bash' })
  await pwshTool.execute({ command: 'Get-Date', description: 'probe', workdir: process.cwd() }, { signal: new AbortController().signal })
  assert.equal(spawn.calls[0].argv[0], NODE_EXE)
  assert.match(spawn.calls[0].argv.at(-1), /Get-Date$/)
  assert.deepEqual(spawn.calls[0].argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
})

test('listShells:出厂条目自动解析为真实路径(pwsh/cmd 必在本机)', () => {
  const { executor } = build()
  const listing = executor.listShells()
  assert.equal(listing.default, 'pwsh')
  const pwsh = listing.shells.find((entry) => entry.id === 'pwsh')
  assert.equal(pwsh.available, true)
  assert.equal(pwsh.path, NODE_EXE)
})

test('entryFor:缺省落 default;未知 id 报可用清单;坏路径条目报配置指引', () => {
  const { executor } = build()
  assert.equal(executor.entryFor(undefined).id, 'pwsh')
  assert.throws(() => executor.entryFor('nope'), /nope/)
  const ctx = stubCtx()
  const broken = new ShellSelectExecutor(ctx.ctx, {
    shells: [{ id: 'gone', name: 'G', kind: 'bash', path: 'Z:\\missing\\bash.exe' }],
    default: 'gone',
  })
  assert.throws(() => broken.entryFor(undefined), /gone.*explicit path|explicit path.*gone/s)
})

test('resolve:预算字段生效,策略缺省落部署策略', () => {
  const { executor } = build()
  const spec = executor.resolve({ command: 'x', timeoutMs: 9999999 })
  assert.equal(spec.timeoutMs, 600000)
  assert.equal(spec.sandboxPolicy.mode, 'danger-full-access')
  assert.equal(spec.workdir, process.cwd())
})

test('runFor danger 直跑:argv 按条目组装,不经 confine,stdout/stderr 回传', async () => {
  const spawn = stubSpawn('out-text', 'err-text')
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const entry = executor.entryFor('git-bash')
  const result = await executor.runFor(entry, executor.resolve({ command: 'ls -la', workdir: process.cwd() }))
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(spawn.calls[0].argv, [entry.path, '-c', 'ls -la'])
  assert.equal(result.stdout.text, 'out-text')
  assert.equal(result.stderr.text, 'err-text')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
})

test('deny 拦截:runFor 命中 deny 抛 DenyError 不 spawn', async () => {
  const spawn = stubSpawn('ok', '')
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, { ...baseConfig(), deny: ['format '] })
  const entry = executor.entryFor('git-bash')
  await assert.rejects(
    () => executor.runFor(entry, executor.resolve({ command: 'format c: /q', workdir: process.cwd() })),
    (error) => error.code === 'SHELL_COMMAND_BLOCKED',
  )
  await executor.runFor(entry, executor.resolve({ command: 'git status', workdir: process.cwd() }))
  assert.equal(spawn.calls.length, 1)
})

test('deny 拦截:startFor 同样拒绝(后台入口)', () => {
  const spawn = stubSpawn('', '', 0)
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, { ...baseConfig(), deny: ['shutdown'] })
  const entry = executor.entryFor('cmd')
  assert.throws(
    () => executor.startFor(entry, executor.resolve({ command: 'shutdown /r', workdir: process.cwd() })),
    (error) => error.code === 'SHELL_COMMAND_BLOCKED',
  )
  assert.equal(spawn.calls.length, 0)
})

test('runFor 受限模式:经 confine 包装 argv,结果分类', async () => {
  const spawn = stubSpawn('', 'some file access denied happened', 1)
  const { ctx } = stubCtx({ spawn, sandboxMode: 'read-only' })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const entry = executor.entryFor('cmd')
  const result = await executor.runFor(entry, executor.resolve({ command: 'dir', workdir: process.cwd() }))
  assert.equal(spawn.calls[0].argv[0], 'WRAPPED')
  assert.deepEqual(spawn.calls[0].argv.slice(1, 6), [entry.path, '/d', '/s', '/c', 'dir'])
  assert.equal(result.sandbox.denied, true)
  assert.equal(result.sandbox.mode, 'read-only')
  assert.equal(result.sandbox.enforcement, 'full')
})

test('runFor pwsh 条目:非交互形 + 编码前缀进 argv', async () => {
  const spawn = stubSpawn()
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const entry = executor.entryFor('pwsh')
  await executor.runFor(entry, executor.resolve({ command: 'Get-Date', workdir: process.cwd() }))
  const argv = spawn.calls[0].argv
  assert.equal(argv[0], entry.path)
  assert.deepEqual(argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
  assert.match(argv[5], /;Get-Date$|; Get-Date$|Get-Date$/)
  assert.match(argv[5], /OutputEncoding/)
})

test('entryFor:双反斜杠污染路径被归一后仍可用', () => {
  const { executor } = stubCtxAndBuild()
  const ctx2 = stubCtx()
  const polluted = new ShellSelectExecutor(ctx2.ctx, {
    shells: [{ id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: 'C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe' }],
    default: 'pwsh',
  })
  if (process.platform !== 'win32') return
  const entry = polluted.entryFor(undefined)
  assert.equal(entry.path, 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
})

test('entryFor:login 布尔透传,argv 产出 -lc(配置→执行全链)', async () => {
  const ctx2 = stubCtx()
  const executor = new ShellSelectExecutor(ctx2.ctx, {
    shells: [
      { id: 'm', name: 'MSYS2', kind: 'bash', path: NODE_EXE, login: true },
      { id: 'g', name: 'Git Bash', kind: 'bash', path: NODE_EXE },
    ],
    default: 'm',
  })
  const loginEntry = executor.entryFor('m')
  assert.equal(loginEntry.login, true)
  assert.deepEqual(executor.argvFor(loginEntry, { command: 'uname -a' }).slice(0, 2), [NODE_EXE, '-lc'])
  const plainEntry = executor.entryFor('g')
  assert.equal(plainEntry.login, false)
  assert.deepEqual(executor.argvFor(plainEntry, { command: 'uname -a' }).slice(0, 2), [NODE_EXE, '-c'])
})

function stubCtxAndBuild() {
  const { ctx, registered } = stubCtx()
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  return { executor, registered }
}

test('startFor danger:返回进程句柄,readOutput 增量与 done 定局', async () => {
  const spawn = stubSpawn('bg-out', '')
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const proc = executor.startFor(executor.entryFor('pwsh'), executor.resolve({ command: 'sleep 1', workdir: process.cwd() }))
  assert.equal(proc.status, 'running')
  const first = proc.readOutput()
  assert.match(first.delta, /bg-out/)
  await proc.done
  assert.equal(proc.status, 'completed')
  assert.equal(proc.exitCode, 0)
})

test('assertServiceableConfig:空 shells/default 不在列/重复 id 全拒', () => {
  assert.throws(() => assertServiceableConfig(resolveConfig({ shells: [], default: 'x' })), /shells/)
  assert.throws(() => assertServiceableConfig(resolveConfig({ shells: [{ id: 'a', name: 'A', kind: 'bash', path: '' }], default: 'b' })), /default/)
  assert.throws(() => assertServiceableConfig(resolveConfig({
    shells: [
      { id: 'a', name: 'A', kind: 'bash', path: '' },
      { id: 'a', name: 'A2', kind: 'cmd', path: '' },
    ],
    default: 'a',
  })), /duplicate/)
})

// --- execute 官方契约(ShellExecutor 抽象方法,官方 tool-pwsh 唯一执行入口)---

test('execute 契约:danger 直跑,返回句柄形态,result() 前台投影无 sandbox 键', async () => {
  const spawn = stubSpawn('exec-out', '', 0)
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const handle = await executor.execute(executor.resolve({ command: 'hi', workdir: process.cwd() }))
  assert.ok(['running', 'completed'].includes(handle.status))
  assert.equal(typeof handle.readOutput, 'function')
  assert.equal(typeof handle.kill, 'function')
  assert.equal(typeof handle.observed.stdout.readFrom, 'function')
  const result = await handle.result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.equal(result.stdout.text, 'exec-out')
  assert.equal(result.sandbox, undefined)
  assert.equal(spawn.calls[0].argv[0], NODE_EXE)
  assert.match(spawn.calls[0].argv.at(-1), /hi$/)
})

test('execute 契约:onExpiry none 不武装 deadline(后台注册形态)', async () => {
  const spawn = stubSpawn('bg', '', 0)
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const handle = await executor.execute(executor.resolve({ command: 'x', workdir: process.cwd(), onExpiry: 'none' }))
  const result = await handle.result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
})

test('execute 契约:provider spawn 失败,done 定局 killed 不 reject,result() 携带同一失败', async () => {
  const spawn = { spawn: () => { throw new Error('spawn exploded') } }
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const handle = await executor.execute(executor.resolve({ command: 'x', workdir: process.cwd() }))
  await handle.done
  assert.equal(handle.status, 'killed')
  const read = handle.readOutput()
  assert.match(read.delta, /subprocess failed before reporting an outcome/)
  await assert.rejects(() => handle.result(), /spawn exploded/)
})

test('execute 契约:受限模式经 confine,定案写 proc.sandbox 并入 result', async () => {
  const spawn = stubSpawn('', 'file access denied under read-only', 1)
  const { ctx } = stubCtx({ spawn, sandboxMode: 'read-only' })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const handle = await executor.execute(executor.resolve({ command: 'dir', workdir: process.cwd() }))
  assert.equal(spawn.calls[0].argv[0], 'WRAPPED')
  const result = await handle.result()
  assert.equal(result.sandbox.mode, 'read-only')
  assert.equal(result.sandbox.denied, true)
  assert.equal(result.sandbox.enforcement, 'full')
})

test('execute 契约:deny 命中拒绝执行,不产生句柄', async () => {
  const spawn = stubSpawn('', '', 0)
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, { ...baseConfig(), deny: ['rm -rf'] })
  await assert.rejects(
    () => executor.execute(executor.resolve({ command: 'rm -rf /', workdir: process.cwd() })),
    (error) => error.code === 'SHELL_COMMAND_BLOCKED',
  )
  assert.equal(spawn.calls.length, 0)
})

test('execute 契约:默认客户端解析,显式 onExpiry kill 正常完成', async () => {
  const spawn = stubSpawn('ok', '', 0)
  const { ctx } = stubCtx({ spawn })
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const handle = await executor.execute(executor.resolve({ command: 'x', workdir: process.cwd(), onExpiry: 'kill', timeoutMs: 5000 }))
  const result = await handle.result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.timeoutMs, 5000)
})

test('refresh:换源后执行面即时收紧(已删 id 拒绝,新清单生效)', async () => {
  const { ctx, registered } = stubCtx()
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(executor.entryFor('cmd').id, 'cmd')
  const toolsBefore = registered.tools.length
  executor.refresh({
    shells: baseConfig().shells.filter((entry) => entry.id !== 'cmd'),
    default: 'pwsh',
  })
  assert.throws(() => executor.entryFor('cmd'), /cmd/)
  assert.equal(executor.entryFor('pwsh').id, 'pwsh')
  assert.equal(executor.entryFor(undefined).id, 'pwsh')
  assert.equal(registered.tools.length, toolsBefore)
})

// 真机宿主形态:行 config 经宿主按 static Config resolve,volatile 字段是
// boxed ref({get}),非普通对象。构造/refresh 直存该形态时 resolveConfig 的
// 类型对账会把 ref 全部当非法输入丢弃,执行面静默回落出厂默认(行 config
// 永不生效,真机 0.2.0-rc.2 实证)。回归锁定:boxed 形态必须解箱生效。

// cordis resolve 产物的同构 boxed 形态:每字段值包 {get}
function boxFields(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, { get: () => value }]))
}

test('构造:boxed volatile 字段(宿主 resolve 产物)解箱生效,不回落出厂默认', () => {
  const { ctx, registered } = stubCtx()
  const userConfig = {
    shells: baseConfig().shells.filter((entry) => entry.id !== 'cmd'),
    default: 'git-bash',
  }
  const executor = new ShellSelectExecutor(ctx, boxFields(userConfig))
  const listing = executor.listShells()
  assert.equal(listing.default, 'git-bash')
  assert.deepEqual(listing.shells.map((entry) => entry.id), ['pwsh', 'git-bash'])
  assert.equal(executor.entryFor(undefined).id, 'git-bash')
  const shell = registered.tools.find((tool) => tool.name === 'shell')
  assert.match(shell.description, /git-bash \(bash\)$|default client is "git-bash"/)
  assert.doesNotMatch(shell.description, /cmd \(cmd\)/)
})

test('refresh:boxed volatile 字段换源同样解箱生效', () => {
  const { ctx } = stubCtx()
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  executor.refresh(boxFields({
    shells: baseConfig().shells,
    default: 'git-bash',
  }))
  assert.equal(executor.entryFor(undefined).id, 'git-bash')
  const listing = executor.listShells()
  assert.equal(listing.default, 'git-bash')
  assert.equal(listing.shells.length, 3)
})

test('构造:混合形态(部分字段 boxed 部分普通)逐字段解箱生效', () => {
  const { ctx } = stubCtx()
  const executor = new ShellSelectExecutor(ctx, {
    shells: boxFields({ shells: baseConfig().shells }).shells,
    default: 'git-bash',
    timeoutMs: 30000,
  })
  assert.equal(executor.entryFor(undefined).id, 'git-bash')
  assert.equal(executor.config.timeoutMs, 30000)
})

test('入参缺省:null/undefined 落出厂默认,不抛', () => {
  const { ctx } = stubCtx()
  const fromNull = new ShellSelectExecutor(ctx, null)
  assert.equal(fromNull.entryFor(undefined).id, 'pwsh')
  fromNull.refresh(null)
  assert.equal(fromNull.entryFor(undefined).id, 'pwsh')
  const fromUndefined = new ShellSelectExecutor(ctx, undefined)
  assert.equal(fromUndefined.entryFor(undefined).id, 'pwsh')
})

test('fail-loud:解箱后仍非法的形态炸在挂载点,不静默回落出厂默认', () => {
  const { ctx } = stubCtx()
  // ref 容器但解箱值非法(模拟宿主 resolve 形态契约变化):strict 必须抛
  assert.throws(
    () => new ShellSelectExecutor(ctx, { shells: { get: () => 'not-array' }, default: 'pwsh' }),
    /形态非法.*shells/,
  )
  // 同形态宽容路径(resolveConfig)不抛——降级语义仅保留给持久化读回
  assert.doesNotThrow(() => new ShellSelectExecutor(ctx, baseConfig()))
})
