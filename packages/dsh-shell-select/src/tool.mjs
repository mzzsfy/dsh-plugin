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
import { PWSH_TAKEOVER_BLOCK } from './pwsh-takeover.mjs'
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

/**
 * deny 命中 → schema 合法的前台结果:拒绝事实全在 stderr 标记文本,
 * 禁止携带 blocked/blockedBy 等声明外字段——输出 oneOf 各分支
 * additionalProperties:false,违者被宿主判 INVALID_TOOL_OUTPUT,拒绝文案不可达。
 */
function deniedForeground(error, shellId) {
  return {
    kind: 'foreground',
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 0,
    stdout: { text: '', truncated: false },
    stderr: { text: blockedMarker(error), truncated: false },
    shell: shellId,
  }
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

/** Bash 命令内路径与宿主工具参数使用不同拼写。 */
const BASH_PATH_GUIDANCE = 'Use Windows-style paths (C:/...) in workdir and file-tool arguments; MSYS paths (/c/..., /tmp) are valid only inside Bash commands.'
const SHELL_ENVIRONMENTS = { pwsh: 'PowerShell', bash: 'Bash', cmd: 'Windows cmd.exe', wsl: 'WSL' }

/** 工具描述只展示当前配置与常规调用方式。 */
export function shellDescription({ executor, backgroundEnabled }) {
  const listing = executor.listShells()
  const clients = listing.shells.map((entry) => {
    const distro = entry.kind === 'wsl' && entry.distro ? ` (${entry.distro})` : ''
    const availability = entry.available ? '' : ' (unavailable)'
    return `- ${entry.id} — ${SHELL_ENVIRONMENTS[entry.kind]}${distro}${availability}`
  }).join('\n')
  const bashPresent = listing.shells.some((entry) => entry.kind === 'bash' && entry.available)
  return [
    `Execute commands using shell=${JSON.stringify(listing.default)} by default and return stdout/stderr.`,
    'Omit shell to use the default; set it to one of:',
    clients,
    '',
    'Each call starts a fresh process; cwd, variables, and functions do not persist.',
    'Use workdir to set the working directory.',
    ...bashPresent ? [BASH_PATH_GUIDANCE] : [],
    '',
    ...backgroundEnabled ? [
      'For long-running commands, set run_in_background=true.',
      'Use job_output to read background output and job_kill to stop the job.',
    ] : ['Background execution is not available; long-running commands must finish within the timeout.'],
    'Long output is truncated; the full-output file path is reported when available.',
  ].join('\n')
}

/** pwsh 工具描述:兼容保留工具,只声明不要调用与去向,零执行语义。 */
function pwshDescription() {
  return 'Do not call; use `shell`.'
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
      ? shellDescription({ executor: faces.executor, backgroundEnabled })
      : pwshDescription(),
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
        description: 'Override the default shell using an id listed above.',
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
          description: 'Wider sandbox access mode for this command; requires justification and user approval.',
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
      }, ...(toolName === 'pwsh' ? [PWSH_TAKEOVER_BLOCK] : [])],
    },
    async execute(args, exec) {
      validateArgs(args)
      const standingPolicy = resolveStandingPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveShellEscalation(toolName, args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec)
      // pwsh 契约:钉死工具永远 PowerShell,配置删条目也现场探测,不落默认客户端
      const entry = pinned !== undefined ? faces.executor.contractEntry() : faces.executor.entryFor(args.shell)
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
          faces.executor.assertNotDenied(request.command)
        } catch (error) {
          if (isDenyError(error)) return deniedForeground(error, entry.id)
          throw error
        }
        return {
          kind: 'background',
          shell: entry.id,
          jobId: jobs.start({
            kind: 'shell',
            label: args.command,
            ...exec.agent ? { owner: exec.agent.id } : {},
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
        if (isDenyError(error)) return deniedForeground(error, entry.id)
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
      const block = result.content.filter(part => part.type === 'text').length === 1 ? result.content.find(part => part.type === 'text') : undefined
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
