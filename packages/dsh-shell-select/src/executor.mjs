// shell-select 执行器:ctx.shell 提供者(官方 SandboxPwshExecutor 同构,进程机制
// 继承 dsh-pwsh-local 形态),并把模型可见 shell 工具与 systemPrompt 段挂在本行
// fiber 上;设置页数据通道在 web-routes 行(声明式 webServer 门控),配置事实源
// = 本行 Config(settings 面以行条目为存储,变更经 cordis 行重载活生效)。
//
// 与官方的两处结构差异(其余逐项同构):
// 1. argv 由「本次调用选中的 shell 条目」决定(pwsh/bash/cmd/wsl 四形 + args 模板),
//    confine 包的正是该条目 argv;
// 2. 执行器预算与客户端清单同行 Config,官方拆 'shell' 节 + 行内 Config。
//
// 兼容性:ShellExecutor 基类为官方文档级扩展缝(dsh-shell README 明示子类化);
// dsh-llm 经 tool.mjs 动态 import + 特性检测(HarnessError 缺失即降级),
// dsh-tools/dsh-sandbox 静态 import(官方组合必装,无降级面)。

import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { Config, KINDS, buildArgv, requireEntry, resolveConfig, assertServiceableConfig, normalizeWin32Path } from './config.mjs'
import { matchDeny } from './denylist.mjs'
import { candidateExists, detectCandidates, resolveEntryPath } from './resolve.mjs'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure } from './sandbox-classify.mjs'
import { registerShellTool } from './tool.mjs'

export const name = 'shell-select'

// 单一事实源:loader 消费模块级 inject 导出,Service 类静态与它共用同一常量。
// settings 不在列:配置事实源 = 行 Config(0.1.7 settings 面语义),页面策略经
// apply 内可选子级注入注册,业务插件无 settings 服务也可运行(官方 README 同构)。
export const SHELL_SELECT_INJECT = ['subprocess', 'sandbox', 'sandboxPolicy', 'tools', 'systemPrompt', 'shellEnv']

export const inject = SHELL_SELECT_INJECT

export { Config } from './config.mjs'

// 面向模型的终端环境覆盖(官方 dsh-pwsh-local 同构):禁色禁 pager
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

// WSLENV 分隔符:WSL 白名单变量表,VAR[:VAR...]
const WSLENV_SEPARATOR = ':'

/**
 * spawn env 构造纯函数:内置覆盖集 + 条目 env + 调用方 env 三层并集
 * (ENV_OVERRIDES < entryEnv < callerEnv,同键高右优先);
 * wsl 形把条目与调用方全部键(WSLENV 本身除外)追加进 WSLENV——WSL 只放行
 * 白名单变量,不追加则配置静默失效。base 三级:调用方显式 > 条目显式 > 继承值;
 * 追加在 base 之上(Windows Terminal 等已写入条目,重建=静默丢弃),
 * 规范化去空段并去重;追加段无方向 flag,默认双向(Win32 回流可见同键)。
 * @param {string} kind 条目形态
 * @param {Record<string,string>|undefined} callerEnv 调用方环境(spec.env+dshEnv)
 * @param {Record<string,string>|undefined} entryEnv 条目配置环境(shells[].env)
 * @param {{inheritedWslenv?: string}} [io] 继承 WSLENV(注入以便测试)
 */
export function buildClientEnv(kind, callerEnv, entryEnv, io = {}) {
  const env = { ...ENV_OVERRIDES, ...entryEnv, ...callerEnv }
  if (kind !== 'wsl') return env
  const keys = [...Object.keys(entryEnv ?? {}), ...Object.keys(callerEnv ?? {})]
    .filter((key) => key !== 'WSLENV')
    .filter((key, index, all) => all.indexOf(key) === index)
  const callerDeclared = Object.prototype.hasOwnProperty.call(callerEnv ?? {}, 'WSLENV')
  const entryDeclared = Object.prototype.hasOwnProperty.call(entryEnv ?? {}, 'WSLENV')
  const base = callerDeclared
    ? env.WSLENV
    : entryDeclared
      ? entryEnv.WSLENV
      : (typeof io.inheritedWslenv === 'string' && io.inheritedWslenv.length > 0 ? io.inheritedWslenv : env.WSLENV)
  if (keys.length === 0) {
    // 无追加键也透传 base:spawn 可能整包替换子环境,缺键=继承条目丢失
    if (typeof base === 'string' && base.length > 0) env.WSLENV = base
    return env
  }
  const parts = typeof base === 'string' ? base.split(WSLENV_SEPARATOR) : []
  env.WSLENV = [...new Set([...parts, ...keys])]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(WSLENV_SEPARATOR)
  return env
}

function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`shell-select: ${name} must be a positive finite number`)
}

/** 收集模式的 reader 投影成 CollectedOutput(官方同构)。 */
function finalOutput(reader) {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

/** SANDBOX_UNAVAILABLE 降级构造器:官方类动态导入落地前的同码同名顶替(错误码通道不变)。 */
class FallbackSandboxUnavailableError extends Error {
  constructor(mode, detail) {
    super(`sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.${detail === undefined ? '' : ` Runner failure: ${detail}`}`)
    this.name = 'SandboxUnavailableError'
    this.code = 'SANDBOX_UNAVAILABLE'
  }
}

async function loadSandboxUnavailable(ctx) {
  try {
    const dshSandbox = await import('@deepseek-ai/dsh-sandbox')
    if (typeof dshSandbox.SandboxUnavailableError === 'function') return dshSandbox.SandboxUnavailableError
  } catch (error) {
    ctx.logger?.warn?.(`shell-select: dsh-sandbox SandboxUnavailableError 不可用,降级为同码 Error: ${error?.message ?? error}`)
  }
  return FallbackSandboxUnavailableError
}

export const ShellSelectExecutor = class ShellSelectExecutor extends ShellExecutor {
  static inject = SHELL_SELECT_INJECT

  static Config = Config

  // 官方 PwshLocalExecutor 同构:实例状态一律公有字段。cordis 服务代理
  // (getTraceable/createShadowMethod)会把经 ctx.shell 访问的方法 this 重定向到
  // 阴影对象,#私有字段在阴影 receiver 下触发 V8 品牌检查错误(官方工具
  // tool-pwsh 正是经 ctx.shell 调用,实测复现)。
  /** 当前权威配置:行 Config(0.1.7 settings 面以行为存储,变更即行重载重建本实例)。 */
  source
  /** 工具重注册句柄(仅构造期闭包触达,this 恒为裸实例)。 */
  #toolRegistration = null
  /** 托管进程的每进程 confinement 事实(官方同构)。 */
  processFacts = new Map()
  /** SANDBOX_UNAVAILABLE 构造器(动态导入就绪后由官方类顶替降级类)。 */
  unavailableError = FallbackSandboxUnavailableError

  constructor(ctx, config) {
    super(ctx)
    void loadSandboxUnavailable(ctx).then((resolved) => {
      this.unavailableError = resolved
    })
    const entry = config ?? {}
    assertServiceableConfig(resolveConfig(entry))
    this.source = () => resolveConfig(entry)
    // 自带设置页(客户端半区自定义卡):抑制宿主按 schema 自动生成的原生页
    // (官方 README 同构:可选子级注入声明策略归属 fiber,服务迟加载也采纳)
    ctx.inject?.(['settings'], (child) => {
      if (typeof child.settings?.configure !== 'function') return
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
    this.#registerTool()
    this.#mountPromptSection()
  }

  get config() {
    return this.source()
  }

  // 命令黑名单检查(deny 绝对:命中即拒;沙箱拦截前的内容级护栏)。
  // 公有方法:经 ctx.shell 代理调用的 runFor/startFor 内触达,this 可能是
  // cordis 阴影对象,# 私有会触发 V8 品牌检查错误(与字段同坑)
  assertNotDenied(command) {
    const current = this.config
    matchDeny(command, current.deny)
  }

  /** 能力事实:挂载沙箱执行器语义,工具层据它公示升权面(官方同构)。 */
  get sandboxMode() {
    return this.ctx.sandboxPolicy?.resolve().mode
  }

  /** 会话可见清单:条目 + 解析后的真实路径与可用性(设置页/工具描述共用)。 */
  listShells() {
    const current = this.config
    return {
      default: current.default,
      shells: current.shells.map((entry) => {
        const resolved = normalizeWin32Path(resolveEntryPath(entry, candidateExists))
        return {
          id: entry.id,
          kind: entry.kind,
          args: entry.args,
          path: resolved,
          available: resolved !== undefined,
          login: entry.login === true,
          distro: entry.distro ?? '',
          env: entry.env ?? {},
        }
      }),
    }
  }

  /** 批量探测 kind 候选(设置页「自动探测」)。 */
  detect(kinds) {
    return detectCandidates(kinds ?? [...KINDS], process.env, candidateExists)
  }

  /**
   * 取本次调用生效的可用条目:按 id 解析真实可执行路径;显式路径同样验证存在,
   * 坏路径在调用前报配置指引而非 spawn ENOENT。
   * @param {string|undefined} requested 模型传的 shell 参数
   * @throws 不可用(未知 id/默认缺失/可执行解析失败)——文案带配置指引
   */
  entryFor(requested) {
    const current = this.config
    const entry = requireEntry(current.shells, requested, current.default)
    const resolved = normalizeWin32Path(resolveEntryPath(entry, candidateExists))
    if (resolved === undefined || !candidateExists(resolved)) {
      throw new Error(`shell client "${entry.id}" (${entry.kind}) has no executable on this machine: set an explicit path in the shell-select settings section or reinstall the client`)
    }
    return { id: entry.id, kind: entry.kind, path: resolved, args: entry.args, login: entry.login === true, distro: entry.distro ?? '', env: entry.env ?? {} }
  }

  /** 注册/重注册 shell 工具(描述随客户端清单变化)。 */
  #registerTool() {
    this.#toolRegistration?.()
    this.#toolRegistration = registerShellTool(this.ctx, { executor: this })
  }

  #mountPromptSection() {
    this.ctx.systemPrompt.section({
      name: 'tool:shell',
      order: this.ctx.systemPrompt.getSectionOrder('TOOL_PWSH'),
      text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. Commands run in fresh processes: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Pass the `shell` argument only when the default client cannot run the command; the available clients are listed in the tool description.',
    })
  }

  /** 为本次调用补全策略:工具供给会话策略,直调落部署策略(官方同构)。 */
  resolve(request) {
    const current = this.config
    const timeoutMs = clampTimeout(request.timeoutMs, current.timeoutMs, current.maxTimeoutMs, 'shell-select: request.timeoutMs')
    const stdoutMaxBytes = request.stdoutMaxBytes ?? current.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? current.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
    }
  }

  /** 本条目 + 已解析 spec 的精确 argv(confine 的输入)。 */
  argvFor(entry, spec) {
    return buildArgv(entry, spec.command)
  }

  /** 官方 execute seam:已解析 spec 按默认客户端前台执行(dsh-pwsh-local run 同构)。 */
  async run(spec) {
    return this.runFor(this.entryFor(), spec)
  }

  /**
   * 官方 ctx.shell 唯一执行契约(ShellExecutor 抽象方法,官方 tool-pwsh 与
   * 进程内消费方共同依赖):解析 spec 后按默认客户端 spawn,返回 ShellExecution
   * 句柄(done/readOutput/kill/observed/result)。前台与否是调用方 await 什么的
   * 属性,不是 spawn 的属性。沙箱语义与 runFor 同源:danger 直跑,受限模式
   * confine 包装,定案按 denial/runner-failure 规则附 sandbox 事实。
   * @param {object} spec resolve() 产物(never 原始 request)
   * @returns {Promise<object>} ShellExecution 句柄
   */
  async execute(spec) {
    this.assertNotDenied(spec.command)
    const entry = this.entryFor()
    const policy = spec.sandboxPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      return this.executionArgv(entry, spec)
    }
    const confined = this.ctx.sandbox.confine(this.argvFor(entry, spec), { ...policy, mode })
    return this.executionArgv(entry, spec, confined.argv, {
      mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: spec.workdir,
    })
  }

  /**
   * 官方 executeArgv 同构(条目参数化):deadline 按 spec.onExpiry 武装
   * ('kill' 到期杀,'none'/缺省只跟随调用方信号);done 永不 reject,provider
   * spawn 失败定局 killed + stderr 注记,result() 携带同一 rejection;受限模式
   * 定案事实经 processFacts/onProcessDone 单通道写 proc.sandbox(官方
   * pwsh-sandbox 子类同构),unsandboxed 的 result() 无 sandbox 键。
   */
  executionArgv(entry, spec, forcedArgv, sandboxFacts) {
    const argv = forcedArgv ?? this.argvFor(entry, spec)
    const armDeadline = spec.onExpiry === 'kill'
    const d = armDeadline ? deadline(spec.signal, spec.timeoutMs, 'SHELL_TIMEOUT') : undefined
    const spawnSignal = d ? d.signal : spec.signal
    const classifyState = () => {
      if (d === undefined) return { timedOut: false, aborted: spec.signal?.aborted === true }
      const timedOut = timeoutOf(d.signal, 'SHELL_TIMEOUT') !== undefined
      return { timedOut, aborted: d.signal.aborted === true && !timedOut }
    }
    let running
    let syncSpawnError
    const prepareAborted = spawnSignal?.aborted === true
    if (!prepareAborted) {
      try {
        running = this.ctx.subprocess.spawn(this.spawnSpec(entry, spec, argv, spec.stdoutMaxBytes, spawnSignal))
      } catch (error) {
        syncSpawnError = { error }
      }
    }
    const emptyReader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) }
    const collected = running !== undefined ? ShellSelectExecutor.collected(running) : { stdout: emptyReader, stderr: emptyReader }
    const spawnThrow = () => syncSpawnError.error
    const spawned = prepareAborted
      ? Promise.resolve({ exitCode: null, signal: null })
      : running !== undefined ? running.done : Promise.reject(spawnThrow())
    let providerFailure
    const consumeProviderFailure = () => {
      if (providerFailure === undefined || providerFailure.reported) return ''
      providerFailure.reported = true
      return providerFailure.note
    }
    let stdoutOffset = 0
    let stderrOffset = 0
    const readCollected = (offsets) => ({
      out: collected.stdout.readFrom(offsets.stdout),
      err: collected.stderr.readFrom(offsets.stderr),
    })
    const executor = this
    let resultPromise
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: {
        stdout: collected.stdout,
        stderr: {
          readFrom: (fromByte) => {
            if (providerFailure === undefined) return collected.stderr.readFrom(fromByte)
            const note = Buffer.from(providerFailure.note, 'utf8')
            return { text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'), nextOffset: note.length, lossy: false }
          },
        },
      },
      done: spawned.then((outcome) => {
        if (proc.status === 'running') proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        if (sandboxFacts !== undefined) executor.processFacts.set(proc, sandboxFacts)
        executor.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
        d?.[Symbol.dispose]?.()
      }, (error) => {
        proc.status = 'killed'
        let detail = 'unprintable provider failure'
        try {
          detail = String(error)
        } catch {}
        const isRunnerFailure = sandboxFacts !== undefined && isRunnerSpawnFailure(error, sandboxFacts.runnerProgram, sandboxFacts.workdir)
        if (isRunnerFailure) {
          providerFailure = { error: new executor.unavailableError(sandboxFacts.mode, String(error)), note: String(error), reported: false }
        } else {
          providerFailure = { error, note: `subprocess failed before reporting an outcome: ${detail}`, reported: false }
        }
        executor.onProcessDone(proc, providerFailure.note, true, error)
        d?.[Symbol.dispose]?.()
      }),
      readOutput: () => {
        const { out, err } = readCollected({ stdout: stdoutOffset, stderr: stderrOffset })
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const providerNote = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text + (providerNote.length > 0 ? `${failureSeparator}${providerNote}` : '')
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: () => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running?.terminate()
        return true
      },
      result: () => {
        resultPromise ??= proc.done.then(() => {
          if (providerFailure !== undefined) throw providerFailure.error
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            ...classifyState(),
            timeoutMs: spec.timeoutMs,
            stdout: finalOutput(collected.stdout),
            stderr: finalOutput(collected.stderr),
            ...proc.sandbox !== undefined ? { sandbox: proc.sandbox } : {},
          }
        })
        return resultPromise
      },
    }
    return Promise.resolve(proc)
  }

  /** 官方 start seam:已解析 spec 按默认客户端后台启动(dsh-pwsh-local start 同构)。 */
  start(spec) {
    return this.startFor(this.entryFor(), spec)
  }

  /** 组装一次 spawn 的完整规格(官方 spawnSpec 同构,argv/条目参数化)。 */
  spawnSpec(entry, spec, argv, stdoutMaxBytes, signal) {
    const current = this.config
    const collect = (maxBytes) => ({
      maxBytes,
      spill: { maxBytes: current.maxSpillBytes },
    })
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(current.maxOutputBytes),
      },
      graceMs: current.graceMs,
      signal,
      env: buildClientEnv(entry.kind, {
        ...spec.env,
        ...spec.dshEnv,
      }, entry.env, { inheritedWslenv: process.env.WSLENV }),
    }
  }

  /** 收集模式的 reader 投影(官方静态 collected 同构)。 */
  static collected(handle) {
    const { stdout, stderr } = handle.collected
    if (stdout === undefined || stderr === undefined) throw new Error('shell-select: subprocess implementation dropped a requested collect stream')
    return { stdout, stderr }
  }

  /**
   * 前台运行指定条目(工具直调入口)。
   * @param {{id: string, kind: string, path: string, args: string[]}} entry entryFor 产物
   * @param {object} spec resolve() 产物
   */
  async runFor(entry, spec) {
    this.assertNotDenied(spec.command)
    const policy = spec.sandboxPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const result = await this.runArgv(entry, spec)
      return { ...result, sandbox: { mode, denied: false } }
    }
    const confined = this.ctx.sandbox.confine(this.argvFor(entry, spec), { ...policy, mode })
    let result
    try {
      result = await this.runArgv(entry, spec, confined.argv)
    } catch (error) {
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new this.unavailableError(mode, String(error))
      throw error
    }
    const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules)
    if (runnerFailure !== undefined) throw new this.unavailableError(mode, runnerFailure.detail)
    return {
      ...result,
      sandbox: {
        mode,
        denied: classifyDenial(result, confined.denialSignatures),
        enforcement: confined.enforcement,
      },
    }
  }

  // 动态导入尚未落地时的同步兜底见 unavailableError 初始化(Fallback 类)

  /** 前台运行精确 argv(官方 runArgv 同构,条目参数化)。 */
  async runArgv(entry, spec, forcedArgv) {
    const argv = forcedArgv ?? this.argvFor(entry, spec)
    const d = deadline(spec.signal, spec.timeoutMs, 'SHELL_TIMEOUT')
    try {
      const handle = this.ctx.subprocess.spawn(this.spawnSpec(entry, spec, argv, spec.stdoutMaxBytes, d.signal))
      const outcome = await handle.done
      const collected = ShellSelectExecutor.collected(handle)
      const timedOut = timeoutOf(d.signal, 'SHELL_TIMEOUT') !== undefined
      const aborted = d.signal.aborted && !timedOut
      return {
        ...outcome,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected.stdout),
        stderr: finalOutput(collected.stderr),
      }
    } finally {
      d[Symbol.dispose]?.()
    }
  }

  /**
   * 后台启动指定条目(工具直调入口)。
   * @returns 官方 ShellProcess 形态句柄
   */
  startFor(entry, spec) {
    this.assertNotDenied(spec.command)
    const policy = spec.sandboxPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') return this.startArgv(entry, spec)
    const confined = this.ctx.sandbox.confine(this.argvFor(entry, spec), { ...policy, mode })
    let proc
    try {
      proc = this.startArgv(entry, spec, confined.argv)
    } catch (error) {
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new this.unavailableError(mode, String(error))
      throw error
    }
    const { enforcement, denialSignatures, runnerFailureRules } = confined
    this.processFacts.set(proc, {
      mode,
      enforcement,
      denialSignatures,
      runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: spec.workdir,
    })
    return proc
  }

  /** 后台启动精确 argv(官方 startArgv 同构)。 */
  startArgv(entry, spec, forcedArgv) {
    const current = this.config
    const argv = forcedArgv ?? this.argvFor(entry, spec)
    const running = this.ctx.subprocess.spawn(this.spawnSpec(entry, spec, argv, current.maxOutputBytes, spec.signal))
    const collected = ShellSelectExecutor.collected(running)
    let providerFailureNote
    const consumeProviderFailure = () => {
      const note = providerFailureNote ?? ''
      providerFailureNote = undefined
      return note
    }
    let stdoutOffset = 0
    let stderrOffset = 0
    const executor = this
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        if (proc.status === 'running') proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        executor.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
      }, (error) => {
        proc.status = 'killed'
        let detail = 'unprintable provider failure'
        try {
          detail = String(error)
        } catch {}
        providerFailureNote = `subprocess failed before reporting an outcome: ${detail}`
        executor.onProcessDone(proc, providerFailureNote, true, error)
      }),
      readOutput: () => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const providerFailure = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text + (providerFailure.length > 0 ? `${failureSeparator}${providerFailure}` : '')
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: () => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }

  /** 定案时附加每进程沙箱事实(官方同构;信号死亡非拒绝)。 */
  onProcessDone(proc, stderr, providerRejected, providerError) {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && classifyDenial({ exitCode: proc.exitCode, stderr: { text: stderr } }, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...runnerFailed ? { runnerFailed } : {},
      }
    }
  }
}

export default ShellSelectExecutor
