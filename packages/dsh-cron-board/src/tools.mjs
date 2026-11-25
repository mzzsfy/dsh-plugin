// 看板任务工具(追加模式):在模型工具面暴露 cron-board 自有任务(读 + 写)。
// 与 HTTP 路由共用 job-fields 的归一/校验,执行面复用 executor/store;
// 工具默认不注册,由设置开关按需挂载(见 index.js),开关关闭即撤销。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { nextRunAtOfSchedules, summarizeSchedules } from './cron.mjs'
import { JOB_MESSAGES, JOB_WRITABLE_FIELDS, normalizeJob } from './job-fields.mjs'

// 工具名:前缀 cron_board_ 与官方 schedule_* 区分,追加模式不与官方同名
export const JOB_TOOL_NAMES = ['cron_board_list', 'cron_board_view', 'cron_board_create', 'cron_board_edit']

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500
const MODEL_RUN_LIMIT = 5

// 字段错误 → 稳定错误码:工具输出用 code 供模型判别,message 保留人话
const CODE_BY_MESSAGE = {
  [JOB_MESSAGES.jobNameRequired]: 'invalid_name',
  [JOB_MESSAGES.badKind]: 'invalid_kind',
  [JOB_MESSAGES.commandRequired]: 'invalid_command',
  [JOB_MESSAGES.badSessionMode]: 'invalid_selector',
  [JOB_MESSAGES.badAgentPreset]: 'invalid_selector',
  [JOB_MESSAGES.badSessionModel]: 'invalid_selector',
  [JOB_MESSAGES.noFutureTrigger]: 'not_future',
}

function codeOf(error) {
  const message = String(error && error.message ? error.message : error)
  if (message.startsWith('cron 表达式不合法') || message.startsWith('调度计划')) return 'invalid_schedule'
  return CODE_BY_MESSAGE[message] ?? 'internal_error'
}

function errorResult(error) {
  const message = String(error && error.message ? error.message : error)
  const code = codeOf(error)
  return { code, message: code === 'internal_error' ? 'The cron board operation failed.' : message }
}

// 列表/创建/编辑的对外任务形态:配置 + 运行态摘要,不含命令/提示正文(避免工具结果膨胀)
function modelJob(job) {
  const model = {
    id: job.id,
    name: job.name,
    kind: job.kind,
    schedule: job.schedule,
    summary: summarizeSchedules(job.schedule),
    enabled: job.enabled === true,
    nextRunAt: typeof job.nextRunAt === 'number' ? new Date(job.nextRunAt).toISOString() : null,
    updatedAt: job.updatedAt,
  }
  if (typeof job.lastRunAt === 'number') model.lastRunAt = new Date(job.lastRunAt).toISOString()
  if (job.lastStatus) model.lastStatus = job.lastStatus
  if (job.concurrency !== undefined) model.concurrency = job.concurrency
  if (job.runOnce === true) model.runOnce = true
  return model
}

// 单个任务的完整形态(view):补正文与会话绑定,供模型判断「这是给谁的什么任务」
function fullJob(job, runs) {
  return {
    ...modelJob(job),
    command: job.command,
    prompt: job.prompt,
    workdir: job.workdir,
    session: job.session ?? null,
    timeoutMs: job.timeoutMs,
    recentRuns: runs.map((run) => ({
      status: run.status,
      trigger: run.trigger,
      createdAt: run.createdAt,
      ...(typeof run.durationMs === 'number' ? { durationMs: run.durationMs } : {}),
      ...(run.message ? { message: run.message } : {}),
    })),
  }
}

const NOT_FOUND_RESULT = (id) => ({ code: 'job_not_found', id })
// 输出形态:任务/列表/错误三类结果,字段随 action 变化,只声明对象面(模型按 description 理解)
const JOB_OUTPUT = { type: 'object', additionalProperties: true, properties: {} }

function errorSchema(code) {
  return { type: 'object', properties: { code: { type: 'string', const: code }, message: { type: 'string' } } }
}

/**
 * 构建四个工具定义。
 * @param {object} deps
 * @param {() => Promise<{store: object, logger: object, executor: object}>} deps.getRuntime 惰性装配
 * @param {() => object|undefined} deps.getSessionController 会话服务实时探测
 */
export function createJobTools({ getRuntime, getSessionController }) {
  const sessionAvailable = () => Boolean(typeof getSessionController === 'function' && getSessionController())

  return [
    defineTool({
      name: 'cron_board_list',
      description: 'List cron board jobs (shell and session jobs), including jobs created from other sessions. Enabled jobs come first, ordered by next run. Use cron_board_view for commands, prompts, and recent runs.',
      parameters: {
        active: { type: 'boolean', description: 'Only enabled (true) or only disabled (false) jobs.' },
        kind: { type: 'string', enum: ['shell', 'session'], description: 'Only jobs of this kind.' },
        limit: { type: 'integer', description: 'Page size, 1 to ' + LIST_MAX_LIMIT + '. Defaults to ' + LIST_DEFAULT_LIMIT + '.' },
        offset: { type: 'integer', description: 'Rows to skip. Defaults to 0.' },
      },
      output: { schema: JOB_OUTPUT },
      async execute(args) {
        try {
          const { store } = await getRuntime()
          let rows = store.jobs.list()
          if (typeof args.active === 'boolean') rows = rows.filter((job) => (job.enabled === true) === args.active)
          if (args.kind === 'shell' || args.kind === 'session') rows = rows.filter((job) => job.kind === args.kind)
          rows.sort((a, b) => {
            if ((a.enabled === true) !== (b.enabled === true)) return a.enabled === true ? -1 : 1
            const left = typeof a.nextRunAt === 'number' ? a.nextRunAt : Infinity
            const right = typeof b.nextRunAt === 'number' ? b.nextRunAt : Infinity
            return left - right
          })
          const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT
          const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0
          const page = rows.slice(offset, offset + limit).map(modelJob)
          return { items: page, shown: page.length, total: rows.length, limit, offset }
        } catch (error) {
          return errorResult(error)
        }
      },
    }),
    defineTool({
      name: 'cron_board_view',
      description: 'View one cron board job by id, including its command or prompt, session binding, and recent runs.',
      parameters: {
        id: { type: 'string', required: true, description: 'Job id from cron_board_list or cron_board_create.' },
      },
      output: { schema: JOB_OUTPUT },
      async execute(args) {
        try {
          const { store } = await getRuntime()
          const job = store.jobs.get(args.id)
          if (!job) return NOT_FOUND_RESULT(args.id)
          const runs = store.runs.list(args.id).slice(-MODEL_RUN_LIMIT).reverse()
          return fullJob(job, runs)
        } catch (error) {
          return errorResult(error)
        }
      },
    }),
    defineTool({
      name: 'cron_board_create',
      description: 'Create a cron board job. schedule is one or more cron expressions separated by newlines (with optional fixed-offset timezone suffix T+N, e.g. "0 9 * * *T+8"). A shell job runs command on the host; a session job delivers prompt to a dsh session at each occurrence. Only create jobs at the user\'s explicit request.',
      parameters: {
        name: { type: 'string', required: true, description: 'Job name in the user\'s language, action plus object; at most 120 characters.' },
        schedule: { type: 'string', required: true, description: 'Cron expressions separated by newlines; each may carry a timezone suffix T+N.' },
        kind: { type: 'string', enum: ['shell', 'session'], description: 'Execution kind. Defaults to shell.' },
        command: { type: 'string', description: 'Shell command. Required for shell jobs.' },
        prompt: { type: 'string', description: 'Prompt delivered to the session at each occurrence. Required for session jobs.' },
        workdir: { type: 'string', description: 'Working directory.' },
        sessionMode: { type: 'string', enum: ['fresh', 'pinned'], description: 'Session job mode: fresh creates a session each time; pinned reuses one session. Defaults to fresh.' },
        agentPreset: { type: 'string', description: 'Agent preset id for session jobs.' },
        enabled: { type: 'boolean', description: 'Defaults to true.' },
        timeoutMs: { type: 'integer', description: 'Shell timeout in milliseconds; defaults to the host default.' },
        concurrency: { type: 'integer', description: 'Per-job concurrency limit; omit to use the global limit.' },
      },
      output: { schema: JOB_OUTPUT },
      async execute(args) {
        try {
          const { store } = await getRuntime()
          if (args.kind === 'session' && !sessionAvailable()) {
            return { code: 'session_unavailable', message: JOB_MESSAGES.sessionUnavailable ?? 'Session service is unavailable.' }
          }
          const fields = normalizeJob({
            name: args.name,
            kind: args.kind ?? 'shell',
            schedule: args.schedule,
            command: args.command,
            prompt: args.prompt,
            workdir: args.workdir,
            session: args.kind === 'session' ? { mode: args.sessionMode, agentPreset: args.agentPreset } : undefined,
            enabled: args.enabled,
            timeoutMs: args.timeoutMs,
            concurrency: args.concurrency,
          })
          const job = await store.jobs.create(fields)
          return modelJob(job)
        } catch (error) {
          return errorResult(error)
        }
      },
    }),
    defineTool({
      name: 'cron_board_edit',
      description: 'Update, enable/disable, run immediately, or delete one cron board job by id. Deleting stops queued and running executions first; it fails with job_not_terminated while a run cannot be stopped. Pass expectedUpdatedAt from cron_board_view to reject concurrent edits.',
      parameters: {
        id: { type: 'string', required: true, description: 'Job id.' },
        action: { type: 'string', required: true, enum: ['update', 'delete', 'run'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'New name.' },
        schedule: { type: 'string', description: 'New cron expressions, newline separated.' },
        command: { type: 'string', description: 'New shell command.' },
        prompt: { type: 'string', description: 'New session prompt.' },
        workdir: { type: 'string', description: 'New working directory.' },
        enabled: { type: 'boolean', description: 'Enable or disable the job.' },
        timeoutMs: { type: 'integer', description: 'New shell timeout.' },
        concurrency: { type: 'integer', description: 'New per-job concurrency limit.' },
        expectedUpdatedAt: { type: 'integer', description: 'UpdatedAt from cron_board_view; rejects the update if the job changed meanwhile.' },
      },
      output: { schema: JOB_OUTPUT },
      async execute(args) {
        try {
          const { store, logger, executor } = await getRuntime()
          const existing = store.jobs.get(args.id)
          if (!existing) return NOT_FOUND_RESULT(args.id)
          if (args.action === 'delete') {
            const stopped = await executor.stopJob(args.id)
            if (!stopped.settled) {
              executor.releaseJob(args.id)
              return { code: 'job_not_terminated', id: args.id, message: JOB_MESSAGES.jobNotTerminated ?? 'The job still has a running execution.' }
            }
            try {
              const removed = await store.jobs.remove(args.id)
              if (!removed) return NOT_FOUND_RESULT(args.id)
            } catch (error) {
              executor.releaseJob(args.id)
              throw error
            }
            try {
              await logger.removeJob(args.id)
            } catch {
              // 日志目录清理失败不翻案删除结果
            }
            return { id: args.id, deleted: true }
          }
          if (args.action === 'run') {
            const runIds = await executor.dispatch(existing, 'manual')
            return { id: args.id, runIds }
          }
          const fields = normalizeJob(
            { ...existing, ...pickUpdate(args, existing) },
            { requireFutureTrigger: args.schedule !== undefined },
          )
          if (fields.kind === 'session' && existing.kind !== 'session' && !sessionAvailable()) {
            return { code: 'session_unavailable', message: JOB_MESSAGES.sessionUnavailable ?? 'Session service is unavailable.' }
          }
          const patch = {}
          for (const key of JOB_WRITABLE_FIELDS) {
            if (args[key] !== undefined) patch[key] = fields[key]
          }
          if (args.kind !== undefined || args.sessionMode !== undefined || args.agentPreset !== undefined) patch.session = fields.session
          if (args.schedule !== undefined) patch.nextRunAt = nextRunAtOfSchedules(fields.schedule)
          const outcome = await store.jobs.updateIf(args.id, args.expectedUpdatedAt, patch)
          if (!outcome.ok) {
            if (outcome.reason === 'missing') return NOT_FOUND_RESULT(args.id)
            return { code: 'job_conflict', id: args.id, message: JOB_MESSAGES.jobConflict ?? 'The job changed meanwhile.' }
          }
          return modelJob(outcome.row)
        } catch (error) {
          return errorResult(error)
        }
      },
    }),
  ]
}

// 只取显式提交的字段:未提交字段沿用 existing,不得被 undefined 覆盖
function pickUpdate(args, existing) {
  const patch = {}
  for (const key of ['name', 'kind', 'schedule', 'command', 'prompt', 'workdir', 'enabled', 'timeoutMs', 'concurrency']) {
    if (args[key] !== undefined) patch[key] = args[key]
  }
  if (args.kind !== undefined || args.sessionMode !== undefined || args.agentPreset !== undefined) {
    // 会话子对象按字段合并:只改 mode 时不得丢掉既有固定会话绑定/预设/模型
    patch.session = {
      ...(existing.session ?? {}),
      ...(args.sessionMode === undefined ? {} : { mode: args.sessionMode }),
      ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
    }
  }
  return patch
}

export { errorResult, modelJob, fullJob }
