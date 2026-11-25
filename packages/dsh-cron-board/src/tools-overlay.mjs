// 覆盖模式:在 agent 作用域注册与官方同名的 schedule_* 四工具,遮蔽 preset 的官方定义,
// 转调宿主 ctx.schedule。模型看到的是 cron-board 的实现,数据与官方自动化任务一致。
// 开关关闭 = 撤销 agent 作用域注册,官方工具恢复;任何挂载失败整体回滚。
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const OVERLAY_TOOL_NAMES = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']

const TARGET_CHOICES = ['this_session', 'new_once', 'new']
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500
const MAX_TITLE_LENGTH = 120

const CREATE_DESCRIPTION = 'Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session as a scheduled message from the user. The result includes the task id and the next occurrence. Only create or modify scheduled tasks at the user\'s explicit request.'
const LIST_DESCRIPTION = 'List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by scheduledAt.'
const VIEW_DESCRIPTION = 'View one scheduled task by id.'
const EDIT_DESCRIPTION = 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.'
const TITLE_HELP = `Task name of at most ${MAX_TITLE_LENGTH} characters in the user's language: action plus object. Omit timing, status, ids, and bracketed suffixes.`
const RRULE_HELP = 'Supported RFC 5545 subset: one DTSTART line, a newline, and one RRULE line. DTSTART ends in Z for UTC or carries TZID with an IANA time zone. DTSTART may be in the past; delivery starts with the first occurrence after creation. A one-time delivery is RRULE:FREQ=DAILY;COUNT=1. MINUTELY and HOURLY accept no BY parts; select clock times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. Example: "DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"'
const TARGET_HELP = 'this_session delivers to this session; new_once delivers to the same new session every time, opened at the first delivery; new opens a different new session for every delivery.'
const MANAGEMENT_AUTHORIZATION = "Only create or modify scheduled tasks at the user's explicit request; prior explicit user authorization for the running scheduled task remains valid."

const CALLER_ERRORS = ['subagent_session', 'internal_error']
const CREATE_ERRORS = ['invalid_prompt', 'invalid_rule', 'invalid_time_zone', 'not_future', 'frequency_too_high', ...CALLER_ERRORS]
const EDIT_ERRORS = ['invalid_selector', ...CREATE_ERRORS]
const LIST_ERRORS = ['invalid_rule', ...CALLER_ERRORS]

// 输出形态宽松声明:字段由宿主 schedule 服务返回,模型按 schema 读关键字段;
// render 与官方一致,把结果 JSON 作为文本块呈现
const OUTPUT = { type: 'object', additionalProperties: true, properties: {} }
const renderValue = (args, value) => [{ type: 'text', text: JSON.stringify(value) }]

// 错误码集合:ctx.schedule 抛出的错误带 code 时按工具契约透传,否则收敛 internal_error
function errorOf(error, codes) {
  const code = typeof error?.code === 'string' ? error.code : null
  if (code !== null && codes.includes(code)) return { code, message: String(error?.message ?? code) }
  return { code: 'internal_error', message: 'The scheduled task operation failed.' }
}

// 调用者限定:子代理会话无定时任务权限(与官方一致);缺 agent 视为内部错误
function runForCaller(exec, codes, operation) {
  const agent = exec?.agent
  const depth = Number(agent?.delegationDepth ?? agent?.session?.header?.delegationDepth ?? 0)
  if (depth >= 1) return Promise.resolve({ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' })
  if (!agent?.session?.id) return Promise.resolve({ code: 'internal_error', message: 'This tool can only run inside an agent session.' })
  return Promise.resolve()
    .then(() => operation(agent))
    .catch((error) => errorOf(error, codes))
}

// this_session 直接投递本会话;new_once/new 由宿主按本会话 cwd 与当前预设创建
function targetFor(agent, target) {
  if (target === 'this_session') return { kind: 'session', sessionId: agent.session.id }
  const cwd = agent.session.header?.cwd
  const agentPreset = agent.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx)
  return {
    kind: target,
    create: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
  }
}

/**
 * 注册覆盖工具到 agent 作用域。
 * @param {object} agent 宿主 agent(需 ctx 与 session)
 * @param {object} schedule 宿主 schedule 服务
 * @param {object} logger 宿主 logger(可缺)
 * @returns {() => void|null} 撤销函数;无法挂载返回 null
 */
export function registerOverlayTools(agent, schedule, logger) {
  if (!agent?.ctx) return null
  // 注册必须落在 agent 自有作用域:旧宿主 agent.ctx 无 agent 作用域标签时补建同键子作用域,
  // 否则同名工具会污染全局层,覆盖所有会话的官方工具
  let registerCtx = agent.ctx
  let scope = null
  if (scopeOf(agent.ctx) !== agent) {
    try {
      scope = createScope(agent.ctx, agent)
      registerCtx = scope.ctx
    } catch (error) {
      logger?.warn?.(`[cron-board] 覆盖作用域创建失败: ${String(error?.message ?? error)}`)
      return null
    }
  }
  const tools = registerCtx.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    try { scope?.dispose() } catch {}
    return null
  }
  const disposers = []
  try {
    for (const definition of buildDefinitions(agent, schedule)) disposers.push(tools.register(definition))
  } catch (error) {
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch {}
    }
    try { scope?.dispose() } catch {}
    logger?.warn?.(`[cron-board] 覆盖工具注册失败: ${String(error?.message ?? error)}`)
    return null
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose() } catch {}
    }
    try { scope?.dispose() } catch {}
  }
}

function buildDefinitions(agent, schedule) {
  return [
    defineTool({
      name: 'schedule_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        title: { type: 'string', required: true, description: TITLE_HELP },
        prompt: { type: 'string', required: true, description: 'Instruction delivered at each occurrence.' },
        rrule: { type: 'string', required: true, description: RRULE_HELP },
        target: { type: 'string', required: true, enum: TARGET_CHOICES, description: TARGET_HELP },
      },
      output: { schema: OUTPUT, render: renderValue },
      execute(args, exec) {
        return runForCaller(exec, CREATE_ERRORS, (caller) => schedule.create({
          title: args.title,
          prompt: args.prompt,
          timing: { kind: 'rrule', rrule: args.rrule },
          target: targetFor(caller, args.target),
        }, caller.session.id, exec.signal))
      },
    }),
    defineTool({
      name: 'schedule_list',
      description: LIST_DESCRIPTION,
      parameters: {
        active: { type: 'boolean', description: 'true for active tasks only; false for paused and ended tasks only; omitted for all tasks.' },
        limit: { type: 'integer', description: `Page size from 1 to ${MAX_LIST_LIMIT}; defaults to ${DEFAULT_LIST_LIMIT}.` },
        offset: { type: 'integer', description: 'Number of tasks to skip; defaults to 0.' },
      },
      output: { schema: OUTPUT, render: renderValue },
      execute({ active, limit, offset }, exec) {
        return runForCaller({}, LIST_ERRORS, () => schedule.list({
          ...(active === undefined ? {} : { active }),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        }))
      },
    }),
    defineTool({
      name: 'schedule_view',
      description: VIEW_DESCRIPTION,
      parameters: { id: { type: 'string', required: true, description: 'Task id.' } },
      output: { schema: OUTPUT, render: renderValue },
      execute(args, exec) {
        return runForCaller(exec, CALLER_ERRORS, () => schedule.view({ id: args.id }))
      },
    }),
    defineTool({
      name: 'schedule_edit',
      description: EDIT_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Task id.' },
        action: { type: 'string', required: true, enum: ['update', 'delete'], description: 'update applies the provided fields, at least one; delete removes the task.' },
        title: { type: 'string', description: TITLE_HELP },
        prompt: { type: 'string', description: 'New instruction delivered at each occurrence.' },
        rrule: { type: 'string', description: 'New recurrence in the schedule_create rrule format.' },
        target: { type: 'string', enum: TARGET_CHOICES, description: 'Omit to retain the destination and its creation settings.' },
        active: { type: 'boolean', description: 'false pauses the task; true resumes only if its timing has a future occurrence.' },
        expectedUpdatedAt: { type: 'string', description: 'updatedAt from the latest result that returned this task; if the task changed after that result, the result is schedule_conflict and nothing changes.' },
      },
      output: { schema: OUTPUT, render: renderValue },
      execute(args, exec) {
        return runForCaller(exec, EDIT_ERRORS, (caller) => {
          const expected = args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: args.expectedUpdatedAt }
          if (args.action === 'delete') {
            const extra = ['title', 'prompt', 'rrule', 'target', 'active'].filter((field) => args[field] !== undefined)
            if (extra.length > 0) return { code: 'invalid_selector', message: 'delete accepts only id, action, and expectedUpdatedAt.' }
            return schedule.edit({ id: args.id, action: 'delete', ...expected }, caller.session.id, exec.signal)
          }
          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            ...(args.rrule === undefined ? {} : { timing: { kind: 'rrule', rrule: args.rrule } }),
            ...(args.target === undefined ? {} : { target: targetFor(caller, args.target) }),
            ...(args.active === undefined ? {} : { active: args.active }),
          }
          if (Object.keys(patch).length === 0) return { code: 'invalid_selector', message: 'update requires at least one of title, prompt, rrule, target, or active.' }
          return schedule.edit({ id: args.id, action: 'update', patch, ...expected }, caller.session.id, exec.signal)
        })
      },
    }),
  ]
}

/**
 * 覆盖工具挂载管理:开关打开对已有与新建 agent 挂载,关闭全部撤销。
 * @param {object} ctx 插件根 ctx(需 on/get)
 * @param {object} options
 * @param {() => boolean} options.readEnabled 设置开关实时读取
 * @param {() => object|undefined} options.getSchedule 宿主 schedule 服务实时探测
 * @param {object} options.logger 宿主 logger(可缺)
 */
export function createOverlayManager(ctx, { readEnabled, getSchedule, logger }) {
  const mounted = new Map()
  const mountAgent = (agent) => {
    if (!agent || mounted.has(agent)) return
    const schedule = getSchedule()
    if (!schedule) return
    const dispose = registerOverlayTools(agent, schedule, logger)
    if (dispose) mounted.set(agent, dispose)
  }
  const unmountAgent = (agent) => {
    const dispose = mounted.get(agent)
    if (!dispose) return
    mounted.delete(agent)
    try { dispose() } catch {}
  }
  const reconcile = () => {
    const wanted = readEnabled()
    if (!wanted) {
      for (const agent of [...mounted.keys()]) unmountAgent(agent)
      return
    }
    const agents = ctx.get('agents')
    const list = typeof agents?.list === 'function' ? agents.list() : []
    for (const agent of list) mountAgent(agent)
  }
  // agent/created 是 serial 事件:监听器抛错会打断会话创建,挂载失败只记录不抛出
  const offCreated = ctx.on?.('agent/created', ({ agent } = {}) => {
    try {
      if (readEnabled()) mountAgent(agent)
    } catch (error) {
      logger?.warn?.(`[cron-board] 覆盖工具挂载失败: ${String(error?.message ?? error)}`)
    }
  })
  const dispose = () => {
    offCreated?.()
    for (const agent of [...mounted.keys()]) unmountAgent(agent)
  }
  return { reconcile, dispose, mounted }
}