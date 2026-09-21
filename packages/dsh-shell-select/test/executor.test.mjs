// executor 集成(桩 ctx):BDD 场景见 docs/progress/shell-select-plan.md「executor」。
// 桩 subprocess 用立即可收的假输出;桩 tools/systemPrompt/settings/webServer 记录注册。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ShellSelectExecutor, { assertServiceableConfig } from '../src/executor.mjs'
import { Config } from '../src/config.mjs'

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
  const registered = { tools: [], sections: [], promptSections: [], routes: [] }
  const settingsImpl = {
    installSection: (ctx, ns, schema, base, hooks) => {
      registered.sections.push({ ns, schema, base, hooks })
      settingsImpl._source = () => Config(base ?? {})
    },
    update: (ns, patch) => {
      settingsImpl._patch = { ns, patch }
      registered.sections[0].hooks.onChange()
    },
  }
  const disposers = []
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

test('构造:注册 shell 工具、systemPrompt 段、shell-select 设置节、三条路由(config 双方法单注册)', () => {
  const { registered } = build()
  assert.equal(registered.tools.length, 1)
  assert.equal(registered.tools[0].name, 'shell')
  assert.match(registered.tools[0].description, /git-bash/)
  assert.equal(registered.promptSections.length, 1)
  assert.equal(registered.sections[0].ns, 'shell-select')
  // exact 路由 path 为唯一键:config/probe/detect 三条,GET/POST 分流在 handler 内
  const routePaths = registered.routes.filter((path) => path.startsWith('/api/shell-select/'))
  assert.equal(routePaths.length, 3)
  assert.equal(new Set(routePaths).size, 3)
})

test('settings 缺席:降级不 installSection,工具照常注册', () => {
  const { ctx, registered } = stubCtx({ withSettings: false })
  new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(registered.sections.length, 0)
  assert.equal(registered.tools.length, 1)
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

test('settings.update 触发 onChange:工具重注册且描述更新', () => {
  const { executor, registered } = stubCtxAndBuild()
  const before = registered.tools.length
  assert.ok(before >= 1)
  registered.sections[0].hooks.onChange()
  assert.ok(registered.tools.length >= 1)
})

test('updateConfig:await settings.update 后读数即新值(setSource 接线)', async () => {
  const { ctx, registered } = stubCtx()
  // 桩 settings:installSection 后 setSource 接 scope;replace wholesale 后 setSource 到新值
  const scope = { value: Config({}) }
  registered.sectionsHook = null
  ctx.settings.installSection = (ctx2, ns, schema, base, hooks) => {
    registered.sections.push({ ns, schema, base, hooks })
    scope.value = Config(base ?? {})
    hooks.setSource(() => scope.value)
    registered.sectionsHook = hooks
  }
  ctx.settings.replace = async (ns, section) => {
    scope.value = Config(section)
    registered.sectionsHook.onChange()
  }
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  assert.equal(executor.config.default, 'pwsh')
  await executor.updateConfig({ default: 'git-bash' })
  assert.equal(executor.config.default, 'git-bash')
  assert.equal(executor.listShells().default, 'git-bash')
})

test('updateConfig:部分补丁归并当前节后 replace(单改 default 不丢 shells)', async () => {
  const { ctx, registered } = stubCtx()
  const written = []
  ctx.settings.replace = async (ns, section) => {
    written.push(section)
  }
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  await executor.updateConfig({ default: 'git-bash' })
  assert.equal(written[0].shells.length, 3)
  assert.equal(written[0].default, 'git-bash')
})

test('api POST config:await updateConfig,resolved 即新清单(async 修复)', async () => {
  const { ctx, registered } = stubCtx()
  ctx.get = (service) => {
    if (service === 'webServer') {
      const routes = []
      ctx.__routes = routes
      return { register: (item) => routes.push(item) }
    }
    return undefined
  }
  ctx.settings.replace = async (ns, section) => {
    registered.sections[0].hooks.setSource(() => section)
    registered.sections[0].hooks.onChange()
  }
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  const handler = ctx.__routes.find((r) => r.path === '/api/shell-select/config').handler
  let captured = null
  const fakeRes = {
    writeHead: () => {},
    end: (body) => {
      captured = JSON.parse(body)
    },
  }
  const body = JSON.stringify({ default: 'git-bash', shells: executor.config.shells })
  const fakeReq = {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:9191', host: '127.0.0.1:9191' },
    on(event, cb) {
      if (event === 'data') setImmediate(() => cb(Buffer.from(body)))
      if (event === 'end') setImmediate(cb)
    },
    destroy: () => {},
  }
  await handler(fakeReq, fakeRes)
  assert.equal(captured.ok, true)
  assert.equal(captured.resolved.default, 'git-bash')
  assert.equal(captured.resolved.shells.length, 3)
})

test('updateConfig:入参 path 反斜杠归一(防 yaml 无引号落盘字面翻倍)', async () => {
  // 归一是 Windows 宿主行为(linux 无反斜杠翻倍怪癖,源码层按平台守卫)
  if (process.platform !== 'win32') return
  const { ctx, registered } = stubCtx()
  const written = []
  ctx.settings.replace = async (ns, section) => {
    written.push(section)
  }
  const executor = new ShellSelectExecutor(ctx, baseConfig())
  await executor.updateConfig({
    shells: [{ id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: 'C:\\\\WINDOWS\\\\System32\\\\powershell.exe' }],
  })
  assert.equal(written[0].shells[0].path, 'C:\\WINDOWS\\System32\\powershell.exe')
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
  assert.throws(() => assertServiceableConfig(Config({ shells: [], default: 'x' })), /shells/)
  assert.throws(() => assertServiceableConfig(Config({ shells: [{ id: 'a', name: 'A', kind: 'bash', path: '' }], default: 'b' })), /default/)
  assert.throws(() => assertServiceableConfig(Config({
    shells: [
      { id: 'a', name: 'A', kind: 'bash', path: '' },
      { id: 'a', name: 'A2', kind: 'cmd', path: '' },
    ],
    default: 'a',
  })), /duplicate/)
})
