// shell 工具:官方 dsh-tool-pwsh 逐调用镜像,三处参数化——
// 1. 工具名 shell(含 shell 枚举参数,模型按名选择客户端);
// 2. 描述动态含可用客户端清单与方言提示(settings onChange 重注册);
// 3. 执行经 executor.entryFor/runFor/startFor 按条目 argv 运行。
// 输出 schema、后台任务语义、升权流程、terminal 卡呈现与官方逐字同构。
// 另注册 pwsh 名字工具(镜像官方定义,钉死 pwsh 客户端):旧会话 preset
// 快照里的 pwsh 工具语义是"PowerShell 专用",缺省落 config.default 会随
// 用户改默认客户端而炸方言;本注册给新会话提供同名工具保语义,模型点名
// pwsh 时永远 PowerShell。

import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import { isAbsolute, resolve } from 'node:path'
import { renderResult, renderProcessRead } from './render.mjs'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'

/** 拒升权/Abort 错误构造:dsh-llm HarnessError 缺失时以同码 Error 降级(错误码通道不变)。 */
async function loadHarnessError(ctx) {
  try {
    const dshLlm = await import('@deepseek-ai/dsh-llm')
    if (typeof dshLlm.HarnessError === 'function') return dshLlm.HarnessError
  } catch (error) {
    ctx.logger?.warn?.(`shell-select: dsh-llm HarnessError 不可用,abort 错误降级为普通 Error: ${error?.message ?? error}`)
  }
  return class FallbackHarnessError extends Error {
    constructor(message, code) {
      super(message)
      this.code = code
    }
  }
}

/** DenyError 判定:跨层类型检查靠 code(动态 import 环境下 instanceof 不可靠)。 */
function isDenyError(error) {
  return error?.code === 'SHELL_COMMAND_BLOCKED'
}

/** 拒绝 → 模型可见标记文本(与沙箱拒绝标记同风格)。 */
function blockedMarker(error) {
  return `[blocked by shell-select: matches deny pattern ${error.pattern}]`
}

/** 显式 workdir 先行,相对者落会话工作区;否则用会话 cwd,执行器默认兜底(官方同构)。 */
function resolveWorkdir(modelWorkdir, exec) {
  const headerCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}

/** 后台进程定局 → 通用任务结果词汇(官方同构)。 */
function processOutcome(proc) {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

/** 前台结果 DTO 去只读化(官方 canonical 同构);shellId 为执行事实,随块落存储供卡片徽章回放。 */
function canonicalResult(result, shellId) {
  const output = (stream) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...shellId !== undefined ? { shell: shellId } : {},
    ...result.sandbox !== undefined ? { sandbox: {
      mode: result.sandbox.mode,
      denied: result.sandbox.denied,
      ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
      ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
    } } : {},
  }
}

/** 后台输出并集公共键(官方同构);shell 同前台,执行事实随 DTO 供渲染。 */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  shell: { type: 'string' },
}

/** 前台输出分支(官方同构,逐字段)。 */
function foregroundOutputProperties() {
  const streamSchema = {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: {
      text: { type: 'string', required: true },
      truncated: { type: 'boolean', required: true },
      spillPath: { type: 'string' },
    },
  }
  return {
    kind: { type: 'string', required: true, const: 'foreground' },
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    timeoutMs: { type: 'number', required: true },
    stdout: streamSchema,
    stderr: streamSchema,
    shell: { type: 'string' },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', required: true },
        denied: { type: 'boolean', required: true },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' },
      },
    },
  }
}

/** 工具描述:客户端清单与方言随配置动态变化。 */
function shellDescription({ executor, backgroundEnabled, escalationModes }) {
  const listing = executor.listShells()
  const lines = listing.shells
    .map((entry) => `${entry.id} (${entry.kind}${entry.available ? '' : ', executable not found'})`)
    .join(', ')
  const base = 'Execute a command in one of the configured shell clients and return its stdout/stderr. '
    + `Available clients: ${lines}. The default client is "${listing.default}"; pass \`shell\` only when this command needs a different client (dialects differ: pwsh = PowerShell, bash/wsl = POSIX, cmd = cmd.exe). `
    + 'Each call runs in a fresh process: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. '
    + 'Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed through managed environment variables (`DSH_*`); inspect them when needed. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + (backgroundEnabled
      ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
      : 'Background execution is not available; long-running commands must finish within the timeout.')
  if (escalationModes.length === 0) return base
  return base + ' Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Never escalate speculatively: ground the request in a real denial. If the session states approval prompts are disabled, a denial is final — do not set `sandbox_permissions`.'
}

/** pwsh 工具描述:兼容保留工具,开头一句禁止调用。 */
function pwshDescription({ backgroundEnabled, escalationModes }) {
  const base = 'Do not call this tool. It is kept only for backward compatibility with old sessions — call the `shell` tool instead. '
    + 'It executes a PowerShell command and returns its stdout/stderr. '
    + 'Each call runs in a fresh pwsh process: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. '
    + 'Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed through managed environment variables (`DSH_*`); inspect them when needed. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + (backgroundEnabled
      ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
      : 'Background execution is not available; long-running commands must finish within the timeout.')
  if (escalationModes.length === 0) return base
  return base + ' Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Never escalate speculatively: ground the request in a real denial. If the session states approval prompts are disabled, a denial is final — do not set `sandbox_permissions`.'
}

/**
 * 注册 shell + pwsh 双工具,返回卸载 disposer(重注册 = 先卸后挂)。
 * pwsh 工具钉死 pwsh 客户端(config 删 pwsh 条目时 requireEntry 明确拒绝)。
 * @param {object} ctx cordis context(需 tools/shellEnv 服务在场)
 * @param {{executor: object}} faces 执行器实例
 */
export function registerShellTool(ctx, { executor }) {
  const backgroundEnabled = true
  const escalationModes = ESCALATION_TARGETS
  let HarnessErrorClass = undefined
  let disposed = false
  let HarnessErrorReady = loadHarnessError(ctx).then((resolved) => {
    HarnessErrorClass = resolved
    return resolved
  })

  async function abortError(message) {
    await HarnessErrorReady
    const error = new HarnessErrorClass(message, TOOL_ABORTED)
    error.name = 'AbortError'
    return error
  }

  function validateArgs(args) {
    if (args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
    if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
    if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
      throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
    }
    validateEscalationArgs(args.sandbox_permissions, args.justification)
  }

  const makeDefinition = (toolName, pinned) => (faces) => defineTool({
    name: toolName,
    description: pinned === undefined
      ? shellDescription({ executor: faces.executor, backgroundEnabled, escalationModes })
      : pwshDescription({ backgroundEnabled, escalationModes }),
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: pinned === undefined
          ? 'The command to execute, in the dialect of the selected shell client (default client when `shell` is omitted).'
          : 'The PowerShell command to execute.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).',
      },
      ...pinned === undefined ? { shell: {
        type: 'string',
        description: 'Shell client id from the tool description list (e.g. pwsh, git-bash, cmd). Omit to use the configured default client.',
      } } : {},
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
      },
      ...backgroundEnabled ? { run_in_background: {
        type: 'boolean',
        description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
      } } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string',
          enum: [...escalationModes],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string',
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
        },
      } : {},
    },
    output: {
      schema: { oneOf: [{
        type: 'object',
        additionalProperties: false,
        properties: BACKGROUND_OUTPUT_PROPERTIES,
      }, {
        type: 'object',
        additionalProperties: false,
        properties: foregroundOutputProperties(),
      }] },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}${value.shell !== undefined ? `\n[shell: ${value.shell}]` : ''}`
          : renderResult(value, escalationModes, value.shell),
      }],
    },
    async execute(args, exec) {
      validateArgs(args)
      const standingPolicy = resolveStandingPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveShellEscalation(toolName, args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec)
      const entry = faces.executor.entryFor(pinned ?? args.shell)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        dshEnv: ctx.shellEnv.collect(exec),
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }
      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (exec.signal.aborted) throw await abortError('tool call aborted')
        try {
          faces.executor.startFor(entry, faces.executor.resolve(request))
        } catch (error) {
          if (isDenyError(error)) return { kind: 'foreground', shell: entry.id, blocked: true, blockedBy: error.pattern, exitCode: null, signal: null, timedOut: false, aborted: false, timeoutMs: 0, stdout: { text: '', truncated: false }, stderr: { text: blockedMarker(error), truncated: false } }
          throw error
        }
        return {
          kind: 'background',
          shell: entry.id,
          jobId: jobs.start({
            kind: 'shell',
            label: args.command,
            ...exec.agent ? { owner: exec.agent } : {},
            run: () => {
              const proc = faces.executor.startFor(entry, faces.executor.resolve(request))
              return {
                cancel: () => void proc.kill(),
                done: proc.done.then(() => processOutcome(proc)),
                readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
              }
            },
          }),
        }
      }
      let result
      try {
        result = await faces.executor.runFor(entry, faces.executor.resolve({
          ...request,
          signal: exec.signal,
        }))
      } catch (error) {
        if (isDenyError(error)) return { kind: 'foreground', shell: entry.id, blocked: true, blockedBy: error.pattern, exitCode: null, signal: null, timedOut: false, aborted: false, timeoutMs: 0, stdout: { text: '', truncated: false }, stderr: { text: blockedMarker(error), truncated: false } }
        throw error
      }
      if (result.aborted) throw await abortError('tool call aborted')
      return canonicalResult(result, entry.id)
    },
    presentCall: (args) => {
      if (args.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: args.description }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...args.workdir !== undefined ? { cwd: args.workdir } : {},
      }
    },
    presentResult: (args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      if (typeof args === 'object' && args !== null && args.run_in_background === true || result.isError) {
        return {
          card: 'generic',
          content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
        }
      }
      const { body, ...exit } = parseExitStatus(raw)
      return {
        card: 'terminal',
        output: body,
        ...exit,
      }
    },
  })

  /** 会话在场时解析其完整标准策略,直调落部署策略(官方同构)。 */
  function resolveStandingPolicy(exec) {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy === undefined) return undefined
    return sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  }

  /** 升权审批:先于执行,共享 fail-closed 序列交 approveEscalation(官方同构)。 */
  function approveShellEscalation(toolName, mode, justification, exec, standingPolicy) {
    if (escalationModes.length === 0) throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    const approver = ctx.get('approval')
    return approveEscalation({
      requestedMode: mode,
      justification,
      effectiveMode: standingPolicy.mode,
      subject: 'command',
    }, {
      approver,
      agent: exec.agent,
      callId: exec.callId,
      toolName,
      signal: exec.signal,
    })
  }

  const faces = { executor }
  const disposers = [
    ctx.tools.register(makeDefinition('shell', undefined)(faces)),
    ctx.tools.register(makeDefinition('pwsh', 'pwsh')(faces)),
  ]
  return () => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers) disposer()
  }
}
