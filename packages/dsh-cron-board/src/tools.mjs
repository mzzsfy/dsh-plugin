// 看板任务工具(追加模式):在模型工具面暴露 cron-board 自有任务(读 + 写)。
// 与 HTTP 路由共用 job-fields 的归一/校验,执行面复用 executor/store;
// 工具默认不注册,由设置开关按需挂载(见 index.js),开关关闭即撤销。
import { defineTool } from '@deepseek-ai/dsh-tools'

import { nextRunAtOfSchedules, summarizeSchedules } from './cron.mjs'
import { JOB_MESSAGES, normalizeJob } from './job-fields.mjs'

// 工具名:前缀 cron_board_ 与官方 schedule_* 区分,追加模式不与官方同名
export const JOB_TOOL_NAMES = ['cron_board_list', 'cron_board_view', 'cron_board_create', 'cron_board_edit']

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500
const MODEL_RUN_LIMIT = 5

// 字段错误 → 稳定错误码:工具输出用 code 供模型判别,message 保留人话。
// 只登记工具面可达的项:create 强制 session、edit 先拦 kind/command,任务类型与命令的错误到不了这里
const CODE_BY_MESSAGE = {
  [JOB_MESSAGES.jobNameRequired]: 'invalid_name',
  [JOB_MESSAGES.jobNameTooLong]: 'invalid_name',
  [JOB_MESSAGES.badSessionMode]: 'invalid_selector',
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
  }
  if (job.updatedAt !== undefined) model.updatedAt = job.updatedAt
  if (typeof job.lastRunAt === 'number') model.lastRunAt = new Date(job.lastRunAt).toISOString()
  if (job.lastStatus) model.lastStatus = job.lastStatus
  if (job.concurrency !== undefined) model.concurrency = job.concurrency
  if (job.runOnce === true) model.runOnce = true
  return model
}

// 单个任务的完整形态(view):补正文与会话绑定,供模型判断「这是给谁的什么任务」
function fullJob(job, runs) {
  const result = {
    ...modelJob(job),
    session: job.session ?? null,
    // 宿主对工具结果整棵做 lossless 校验:任一 undefined 属性会让整次调用失败,逐字段守卫
    recentRuns: runs.map((run) => ({
      ...(run.status !== undefined ? { status: run.status } : {}),
      ...(run.trigger !== undefined ? { trigger: run.trigger } : {}),
      ...(run.createdAt !== undefined ? { createdAt: run.createdAt } : {}),
      ...(typeof run.durationMs === 'number' ? { durationMs: run.durationMs } : {}),
      ...(run.message ? { message: run.message } : {}),
    })),
  }
  if (job.kind === 'shell') {
    for (const key of ['command', 'workdir', 'timeoutMs']) {
      if (job[key] !== undefined) result[key] = job[key]
    }
  } else {
    for (const key of ['prompt', 'workdir']) {
      if (job[key] !== undefined) result[key] = job[key]
    }
  }
  return result
}

const NOT_FOUND_RESULT = (id) => ({ code: 'job_not_found', id })
// 输出形态:任务/列表/错误三类结果,字段随 action 变化,只声明对象面(模型按 description 理解)
const JOB_OUTPUT = { type: 'object', additionalProperties: true, properties: {} }

const output = {
  schema: JOB_OUTPUT,
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
}

const WRITE_AGENT_REQUIRED = { code: 'agent_required', message: 'This write operation requires a top-level session with a composed agent preset.' }
const SUBAGENT_FORBIDDEN = { code: 'subagent_session', message: 'A delegated subagent cannot modify cron board jobs.' }
const JOB_CONTEXT_MISMATCH = { code: 'job_context_mismatch', message: 'This session cannot modify a job created by another session or pinned to a different session.' }
const INVALID_SELECTOR = { code: 'invalid_selector', message: 'The requested fields or action are not allowed for model-created session jobs.' }
const SHELL_READ_ONLY = { code: 'shell_read_only', message: 'Shell jobs are read-only in model tools.' }
const CWD_REQUIRED = { code: 'cwd_required', message: 'This session has no working directory, so a scheduled session could not inherit one.' }

function writeCaller(exec) {
  const agent = exec?.agent
  if (!agent?.session?.id) return { error: WRITE_AGENT_REQUIRED }
  const header = agent.session.header
  if (header?.origin === 'subagent' || header?.delegationDepth > 0 || agent.options?.subagentDepth > 0) {
    return { error: SUBAGENT_FORBIDDEN }
  }
  let agentPreset
  try {
    agentPreset = agent.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx)
  } catch {
    return { error: WRITE_AGENT_REQUIRED }
  }
  if (typeof agentPreset !== 'string' || !agentPreset.trim()) return { error: WRITE_AGENT_REQUIRED }
  const cwd = typeof header?.cwd === 'string' ? header.cwd.trim() : ''
  // 宿主当前目录以 workingDirectory 投影为准(会话内 cd 会改它),header 只是创建时元数据
  let live = ''
  try {
    live = agent.ctx?.get?.('workingDirectory')?.get?.(agent.session) ?? ''
  } catch {
    live = ''
  }
  const workdir = typeof live === 'string' && live.trim() ? live.trim() : cwd
  // 空目录会让定时投递落回宿主默认工作区,超出调用会话拥有的范围
  if (!workdir) return { error: CWD_REQUIRED }
  return { id: agent.session.id, cwd: workdir, agentPreset: agentPreset.trim() }
}

function sameSessionContext(job, caller) {
  const session = job.session ?? {}
  // 固定会话模式必须指向调用方自己:指向别的会话等于让模型往他人会话里写提示词
  if (session.mode === 'pinned' && session.pinnedSessionId !== caller.id) return false
  // 归属只认创建会话:目录与组合预设是投递范围,不是归属;它们被看板改动时
  // API 已清空 createdBySessionId,调用方中途 cd 或换预设不该失去自己任务的写权
  return job.kind === 'session' && job.createdBySessionId === caller.id
}

function forbiddenUpdateFields(args) {
  return ['kind', 'command', 'workdir', 'timeoutMs', 'sessionMode', 'agentPreset'].some((key) => args[key] !== undefined)
}

/**
 * 构建四个工具定义。
 * @param {object} deps
 * @param {() => Promise<{store: object, logger: object, executor: object}>} deps.getRuntime 惰性装配
 * @param {() => object|undefined} deps.getSessionController 会话服务实时探测
 */
// 写后取消的补偿:先按删除路径清场(可能已被 tick 派发),再删任务与日志目录。
// 失败只留痕不外抛——外抛会掩盖原始的取消原因
async function compensateCreated({ store, executor, logger }, job) {
  try {
    await executor?.stopJob?.(job.id)
  } finally {
    executor?.releaseJob?.(job.id)
  }
  await store.jobs.remove(job.id)
  await logger?.removeJob?.(job.id)?.catch?.(() => undefined)
}

function reportCompensationFailure(action, jobId, error) {
  const detail = error && error.message ? error.message : String(error)
  process.stderr.write('[cron-board] 取消补偿失败 ' + action + ' job=' + jobId + ': ' + detail + '\n')
}

export function createJobTools({ getRuntime, getSessionController, notifyChange, readMaxJobs }) {
  const changed = (result) => {
    notifyChange?.()
    return result
  }
  const sessionAvailable = () => Boolean(typeof getSessionController === 'function' && getSessionController())
  // 配额取整:配置面已限制整数,这里兜住手改配置的小数
  const maxJobs = () => {
    const value = typeof readMaxJobs === 'function' ? readMaxJobs() : 0
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  // 配额判定与落库串行化:同会话两个并发 create 各自读到 N-1 会双双通过,超出上限
  const quotaChain = new Map()
  const withQuotaLock = async (callerId, action) => {
    const previous = quotaChain.get(callerId) ?? Promise.resolve()
    const run = previous.then(action, action)
    const tail = run.catch(() => {})
    quotaChain.set(callerId, tail)
    try {
      return await run
    } finally {
      // 队列尾仍是本次:说明后面没人排队,可以回收条目,避免按会话无限增长
      if (quotaChain.get(callerId) === tail) quotaChain.delete(callerId)
    }
  }

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
      output,
      async execute(args, exec) {
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
          if (exec?.signal?.aborted) throw error
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
      output,
      async execute(args, exec) {
        try {
          const { store } = await getRuntime()
          const job = store.jobs.get(args.id)
          if (!job) return NOT_FOUND_RESULT(args.id)
          const runs = store.runs.list(args.id).slice(-MODEL_RUN_LIMIT).reverse()
          return fullJob(job, runs)
        } catch (error) {
          if (exec?.signal?.aborted) throw error
          return errorResult(error)
        }
      },
    }),
    defineTool({
      name: 'cron_board_create',
      description: 'Create a session cron board job only. The new session inherits the calling session working directory and composed agent preset; model input cannot choose either. schedule is one or more cron expressions separated by newlines (with optional fixed-offset timezone suffix T+N, e.g. "0 9 * * *T+8"). Only create jobs at the user\'s explicit request.',
      parameters: {
        name: { type: 'string', required: true, description: 'Job name in the user\'s language, action plus object; at most 120 characters.' },
        schedule: { type: 'string', required: true, description: 'Cron expressions separated by newlines; each may carry a timezone suffix T+N.' },
        kind: { type: 'string', enum: ['session'], description: 'Omit; only session jobs can be created here.' },
        prompt: { type: 'string', required: true, description: 'Prompt delivered to the inherited session context.' },
        sessionMode: { type: 'string', enum: ['fresh', 'pinned'], description: 'Session job mode: fresh creates a session each time; pinned reuses one session. Defaults to fresh.' },
        enabled: { type: 'boolean', description: 'Defaults to true.' },
        runOnce: { type: 'boolean', description: 'Disable after the first run is admitted.' },
        concurrency: { type: 'integer', description: 'Per-job concurrency limit; 0 or a negative number means no per-job limit.' },
      },
      output,
      async execute(args, exec) {
        const caller = writeCaller(exec)
        if (caller.error) return caller.error
        try {
          const runtime = await getRuntime()
          const { store } = runtime
          const fields = normalizeJob({
            name: args.name,
            kind: 'session',
            schedule: args.schedule,
            prompt: args.prompt,
            workdir: caller.cwd,
            // 模型没有指定固定会话的入口:pinned 只能钉住调用方自己,否则首跑绑定他人会话后再也写不了
            session: { mode: args.sessionMode, pinnedSessionId: args.sessionMode === 'pinned' ? caller.id : undefined, agentPreset: caller.agentPreset },
            enabled: args.enabled,
            runOnce: args.runOnce,
            concurrency: args.concurrency,
          })
          if (!sessionAvailable()) {
            return { code: 'session_unavailable', message: JOB_MESSAGES.sessionUnavailable ?? 'Session service is unavailable.' }
          }
          // 会话级配额:本会话通过工具可见的任务数已达上限即拒绝,避免模型无界造任务。
          // 判定与落库在同一会话锁内,并发 create 不能一起越限
          const limit = maxJobs()
          const job = await withQuotaLock(caller.id, async () => {
            if (limit > 0) {
              const mine = store.jobs.list((row) => row.createdBySessionId === caller.id).length
              if (mine >= limit) {
                return { code: 'quota_exceeded', message: 'This session already owns ' + mine + ' cron board jobs (limit ' + limit + ').' }
              }
            }
            exec?.signal?.throwIfAborted()
            return store.jobs.create({ ...fields, createdBySessionId: caller.id })
          })
          if (job.code === 'quota_exceeded') return job
          // 写入与取消之间的窗口:任务已落库而宿主会把结果改写成 aborted,
          // 模型看不到成功只能重试;此处按删除路径清场并补偿删除,不留重复任务
          if (exec?.signal?.aborted) {
            await compensateCreated(runtime, job).catch((error) => {
              reportCompensationFailure('create', job.id, error)
            })
            exec.signal.throwIfAborted()
          }
          return changed(modelJob(job))
        } catch (error) {
          // 取消不是失败:交回宿主,别把 abort 记成内部错误
          if (exec?.signal?.aborted) throw error
          return errorResult(error)
        }
      },
    }),
    defineTool({
      name: 'cron_board_edit',
      description: 'Update or delete one session cron board job created by the current top-level session. Both actions require expectedUpdatedAt, the updatedAt you read: a stale value returns job_conflict and changes nothing. Shell jobs and session jobs created by another session are read-only. Updates are limited to name, schedule, prompt, enabled, runOnce, and concurrency; working directory, agent preset, session mode, command, and immediate run are unavailable. Deleting stops queued and running executions first; it fails with job_not_terminated while a run cannot be stopped.',
      parameters: {
        id: { type: 'string', required: true, description: 'Job id.' },
        action: { type: 'string', required: true, enum: ['update', 'delete'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'New name.' },
        schedule: { type: 'string', description: 'New cron expressions, newline separated.' },
        command: { type: 'string', description: 'Not allowed; shell jobs are read-only.' },
        prompt: { type: 'string', description: 'New session prompt.' },
        workdir: { type: 'string', description: 'Not allowed; the original calling-session directory is immutable.' },
        enabled: { type: 'boolean', description: 'Enable or disable the session job.' },
        timeoutMs: { type: 'integer', description: 'Not allowed; session jobs have no shell timeout.' },
        concurrency: { type: 'integer', description: 'New per-job concurrency limit; 0 clears it.' },
        kind: { type: 'string', description: 'Not allowed; job kind is immutable.' },
        sessionMode: { type: 'string', description: 'Not allowed; session mode is immutable.' },
        agentPreset: { type: 'string', description: 'Not allowed; the original calling-session preset is immutable.' },
        run: { type: 'boolean', description: 'Not supported; immediate execution is not a model operation.' },
        runOnce: { type: 'boolean', description: 'Disable after the first run is admitted.' },
        expectedUpdatedAt: { type: 'integer', required: true, description: 'updatedAt from the cron_board_view, cron_board_list, or cron_board_create result you are acting on. A different current version returns job_conflict and changes nothing.' },
      },
      output,
      async execute(args, exec) {
        const caller = writeCaller(exec)
        if (caller.error) return caller.error
        try {
          const { store, logger, executor } = await getRuntime()
          const existing = store.jobs.get(args.id)
          if (!existing) return NOT_FOUND_RESULT(args.id)
          if (!sameSessionContext(existing, caller)) return existing.kind === 'shell' ? SHELL_READ_ONLY : JOB_CONTEXT_MISMATCH
          if (forbiddenUpdateFields(args) || args.run !== undefined) return INVALID_SELECTOR
          // 版本取模型读到的值而非调用瞬间现读:只有前者能挡住「读后被改」这一真实冲突窗口
          const version = args.expectedUpdatedAt
          const conflict = { code: 'job_conflict', id: args.id, message: JOB_MESSAGES.jobConflict }
          if (existing.updatedAt !== version) return conflict
          const selected = pickUpdate(args)
          if (args.action === 'delete') {
            if (Object.keys(selected).length !== 0) return INVALID_SELECTOR
            let removed = false
            try {
              // 取消判定要早于清场:已被取消的删除不该先杀掉在途运行
              exec?.signal?.throwIfAborted()
              const stopped = await executor.stopJob(args.id)
              if (!stopped.settled) return { code: 'job_not_terminated', id: args.id, message: JOB_MESSAGES.jobNotTerminated }
              exec?.signal?.throwIfAborted()
              removed = await store.jobs.remove(args.id, version)
              if (!removed) return store.jobs.get(args.id) ? conflict : NOT_FOUND_RESULT(args.id)
            } finally {
              // 删除窗口结束后必须解除拒绝态:成功删除也不留永久 id,失败则让任务恢复可调度
              executor.releaseJob(args.id)
            }
            try {
              await logger.removeJob(args.id)
            } catch {
              // 日志目录清理失败不翻案删除结果
            }
            return changed({ id: args.id, deleted: true })
          }
          if (args.action !== 'update' || Object.keys(selected).length === 0) return INVALID_SELECTOR
          const fields = normalizeJob(
            { ...existing, ...selected },
            { requireFutureTrigger: args.schedule !== undefined, checkName: args.name !== undefined },
          )
          const patch = {}
          for (const key of ['name', 'prompt', 'enabled', 'runOnce', 'concurrency']) {
            if (args[key] !== undefined) patch[key] = fields[key]
          }
          if (args.schedule !== undefined) {
            patch.schedule = fields.schedule
            patch.nextRunAt = nextRunAtOfSchedules(fields.schedule)
          }
          exec?.signal?.throwIfAborted()
          const outcome = await store.jobs.updateIf(args.id, version, patch)
          if (!outcome.ok) return outcome.reason === 'missing' ? NOT_FOUND_RESULT(args.id) : conflict
          // 同 create:写后取消要让改动回滚,否则模型重试会把结果写两遍。
          // 回滚按本次写入后的版本做 CAS:补偿窗口内别人的改动不会被旧值覆盖
          if (exec?.signal?.aborted) {
            const restore = {}
            for (const key of Object.keys(patch)) restore[key] = existing[key]
            await store.jobs.updateIf(args.id, outcome.row.updatedAt, restore).catch((error) => {
              reportCompensationFailure('update', args.id, error)
            })
            exec.signal.throwIfAborted()
          }
          return changed(modelJob(outcome.row))
        } catch (error) {
          // 取消不是失败:交回宿主,别把 abort 记成内部错误
          if (exec?.signal?.aborted) throw error
          return errorResult(error)
        }
      },
    }),
  ]
}

// 只取会话任务允许且显式提交的字段:未提交字段沿用 existing
function pickUpdate(args) {
  const patch = {}
  for (const key of ['name', 'schedule', 'prompt', 'enabled', 'runOnce', 'concurrency']) {
    if (args[key] !== undefined) patch[key] = args[key]
  }
  return patch
}

export { errorResult, modelJob, fullJob }
