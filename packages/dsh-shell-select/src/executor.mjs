// shell-select 执行器:ctx.shell 提供者(官方 SandboxPwshExecutor 同构,进程机制
// 继承 dsh-pwsh-local 形态),并把模型可见 shell 工具、systemPrompt 段、
// shell-select 设置节与浏览器半区路由一并挂在本行 fiber 上。
//
// 与官方的两处结构差异(其余逐项同构):
// 1. argv 由「本次调用选中的 shell 条目」决定(pwsh/bash/cmd/wsl 四形 + args 模板),
//    confine 包的正是该条目 argv;
// 2. 执行器预算与客户端清单同节('shell-select'),官方拆 'shell' 节 + 行内 Config。
//
// 兼容性:ShellExecutor 基类为官方文档级扩展缝(dsh-shell README 明示子类化);
// dsh-llm 经 tool.mjs 动态 import + 特性检测(HarnessError 缺失即降级),
// dsh-tools/dsh-sandbox 静态 import(官方组合必装,无降级面)。

import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { MAX_TIMER_DELAY_MS, clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { Config, KINDS, buildArgv, requireEntry } from './config.mjs'
import { candidateExists, detectCandidates, resolveEntryPath } from './resolve.mjs'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure } from './sandbox-classify.mjs'
import { registerShellTool } from './tool.mjs'
import { mountRoutes } from './api.mjs'
import { beginShellSelectApply, endShellSelectApplyActive } from './apply-state.mjs'

export const name = 'shell-select'

// 单一事实源:loader 消费模块级 inject 导出,Service 类静态与它共用同一常量
export const SHELL_SELECT_INJECT = ['subprocess', 'sandbox', 'sandboxPolicy', 'settings', 'tools', 'systemPrompt', 'shellEnv']

export const inject = SHELL_SELECT_INJECT

export { Config }

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
 * 白名单变量,不追加则配置静默失效。追加在继承值之上(Windows Terminal 等
 * 已写入条目,重建=静默丢弃),split/规范化去空段;调用方显式 WSLENV 优先于继承值。
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
  const declared = Object.prototype.hasOwnProperty.call(callerEnv ?? {}, 'WSLENV')
  const base = declared
    ? env.WSLENV
    : (typeof io.inheritedWslenv === 'string' && io.inheritedWslenv.length > 0 ? io.inheritedWslenv : env.WSLENV)
  if (keys.length === 0) {
    // 无追加键也透传继承值:spawn 可能整包替换子环境,缺键=继承条目丢失
    if (typeof base === 'string' && base.length > 0) env.WSLENV = base
    return env
  }
  const parts = typeof base === 'string' ? base.split(WSLENV_SEPARATOR) : []
  env.WSLENV = [...parts, ...keys.flatMap((key) => key.split(WSLENV_SEPARATOR))]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(WSLENV_SEPARATOR)
  return env
}

function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`shell-select: ${name} must be a positive finite number`)
}

// yaml 无引号标量会把 `\` 字面落盘,任何一层再转义都让路径翻倍(C:\\ 实测):
// 入口统一归一,保证进 schema 的 path 就是干净值
function normalizeWin32Path(path) {
  if (typeof path !== 'string' || path.length === 0) return path
  return path.replace(/\\{2,}/g, '\\').replace(/\//g, '\\')
}

// 更新负载深归一:shells[].path 与任意层字符串值只处理 path 键,避免误伤 args 模板
function normalizeConfigPaths(patch) {
  if (typeof patch !== 'object' || patch === null || !Array.isArray(patch.shells)) return patch
  return {
    ...patch,
    shells: patch.shells.map((entry) => (typeof entry?.path === 'string' ? { ...entry, path: normalizeWin32Path(entry.path) } : entry)),
  }
}

/** 拒绝无法运行的已解析配置节(schema 之外的正数/时限/清单约束,官方 assertServiceable 同构)。 */
export function assertServiceableConfig(config) {
  assertPositiveFinite('timeoutMs', config.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes)
  assertPositiveFinite('graceMs', config.graceMs)
  if (config.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`shell-select: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  if (!Array.isArray(config.shells) || config.shells.length === 0) throw new Error('shell-select: shells must not be empty')
  const ids = new Set()
  for (const entry of config.shells) {
    if (ids.has(entry.id)) throw new Error(`shell-select: duplicate shell id "${entry.id}"`)
    ids.add(entry.id)
  }
  if (!ids.has(config.default)) throw new Error(`shell-select: default "${config.default}" is not a configured shell id`)
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
  /** 当前权威配置来源:设置节(接线后)或行内配置。 */
  source
  /** 工具重注册句柄(onChange 先卸后挂;仅构造期闭包触达,this 恒为裸实例)。 */
  #toolRegistration = null
  /** 托管进程的每进程 confinement 事实(官方同构)。 */
  processFacts = new Map()
  /** SANDBOX_UNAVAILABLE 构造器(动态导入就绪后由官方类顶替降级类)。 */
  unavailableError = FallbackSandboxUnavailableError

  constructor(ctx, config) {
    super(ctx)
    beginShellSelectApply()
    void loadSandboxUnavailable(ctx).then((resolved) => {
      this.unavailableError = resolved
    })
    // settings 为硬依赖(static inject 门控);面异常按降级处理,能力不损
    const settingsOk = typeof ctx.settings?.installSection === 'function'
    if (!settingsOk) ctx.logger?.warn?.('shell-select: 宿主 settings 服务缺 installSection,配置退化为行内 Config,无热更新')

    const entry = config ?? {}
    assertServiceableConfig(Config(entry))
    this.source = () => Config(entry)
    if (settingsOk) {
      ctx.settings.installSection(ctx, 'shell-select', Config, entry, {
        validate: assertServiceableConfig,
        setSource: (current) => {
          this.source = current
        },
        onChange: () => this.#onConfigChange(),
      })
    }
    this.#registerTool()
    this.#mountPromptSection()
    mountRoutes(ctx, {
      listShells: () => this.listShells(),
      readConfig: () => this.source(),
      updateConfig: (patch) => this.updateConfig(patch),
      detect: (kinds) => this.detect(kinds),
      probe: (candidatePath) => candidateExists(candidatePath),
    })
    endShellSelectApplyActive()
  }

  get config() {
    return this.source()
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
          name: entry.name,
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

  /**
   * 客户端半区配置更新入口:wholesale replace(settings merge 对数组是整值
   * 覆盖,部分清单会静默丢条目;设置页语义是保存完整清单);等写队列落定再回读。
   */
  async updateConfig(patch) {
    const current = this.config
    const section = normalizeConfigPaths({
      shells: patch.shells ?? current.shells,
      default: patch.default ?? current.default,
    })
    assertServiceableConfig(Config(section))
    await this.ctx.settings.replace('shell-select', section)
    return this.listShells()
  }

  #onConfigChange() {
    try {
      assertServiceableConfig(this.config)
    } catch (error) {
      // validate hook 已在写入路径拦截;此处兜底防御,保旧配置
      this.ctx.logger?.warn?.(`shell-select: 新配置不可用,保留先前配置: ${error?.message ?? error}`)
      return
    }
    this.#registerTool()
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

  /** 官方 run seam:已解析 spec 按默认客户端前台执行(dsh-pwsh-local run 同构)。 */
  async run(spec) {
    return this.runFor(this.entryFor(), spec)
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
