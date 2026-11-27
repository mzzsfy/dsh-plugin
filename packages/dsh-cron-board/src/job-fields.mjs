// 任务字段归一与校验:HTTP 路由与模型工具共用同一套规则(名称/类型/命令/计划/会话绑定),
// 保证两条入口对同一输入给出同一结果与同一错误文案;只做纯函数,持久化与执行面由调用方注入。
import {
  assertValidSchedule,
  normalizeSchedule,
  nextRunAtOf,
  splitSchedules,
} from './cron.mjs'
import { DEFAULT_TIMEOUT_MS, SESSION_UNAVAILABLE_REASON } from './config.mjs'

// 名称随任务清单回给每个 agent,需要上限;提示词长度由请求体上限约束,不在此另设
export const JOB_NAME_MAX = 120

// 任务级错误文案:路由层 MESSAGES 展开引用,工具层按 code 映射
export const JOB_MESSAGES = {
  jobNotFound: '任务不存在',
  jobConflict: '任务已被其他操作修改,请关闭后重新打开编辑再保存',
  jobNotTerminated: '任务仍有在途运行未能终止,已取消删除,请稍后重试',
  sessionUnavailable: SESSION_UNAVAILABLE_REASON,
  jobNameRequired: '任务名称不能为空',
  commandRequired: '任务命令不能为空',
  badKind: '任务类型不合法',
  badSessionMode: '会话模式仅支持 fresh 或 pinned',
  badSessionModel: '模型指定不合法:provider 与 model 必须为非空文本,reasoningEffort 可省略',
  noFutureTrigger: 'cron 表达式没有可执行的未来触发点,请调整表达式',
  jobNameTooLong: '任务名称最多 ' + JOB_NAME_MAX + ' 个字符',
}

// 预设 id 由宿主定义(只要求非空),本包不约束形态

// PATCH 可写字段白名单:未列出的字段(运行态/持久化元数据)不得经更新路径写入
export const JOB_WRITABLE_FIELDS = ['name', 'kind', 'command', 'prompt', 'workdir', 'schedule', 'enabled', 'timeoutMs', 'runOnce', 'concurrency']

export function normalizeSessionModel(raw) {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object') throw new Error(JOB_MESSAGES.badSessionModel)
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' && model === '') return undefined
  if (provider === '' || model === '') throw new Error(JOB_MESSAGES.badSessionModel)
  const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
  if (raw.reasoningEffort !== undefined && reasoningEffort === '') throw new Error(JOB_MESSAGES.badSessionModel)
  return reasoningEffort === '' ? { provider, model } : { provider, model, reasoningEffort }
}

// 会话任务专有字段(设计 §3.2 job.session 子对象)
export function normalizeSession(body) {
  if (body.kind !== 'session') return undefined
  const raw = body.session && typeof body.session === 'object' ? body.session : {}
  if (raw.mode !== undefined && raw.mode !== 'fresh' && raw.mode !== 'pinned') throw new Error(JOB_MESSAGES.badSessionMode)
  const agentPreset = typeof raw.agentPreset === 'string' ? raw.agentPreset.trim() : ''
  // 预设 id 由宿主定义(只要求非空字符串),这里不校验形态:校验会拒掉宿主声明合法的 id,
  // 也会让存量任务改不动;目录展示侧的形态过滤是 UI 关注点,不参与任务写入
  const session = {
    mode: raw.mode === 'pinned' ? 'pinned' : 'fresh',
    pinnedSessionId: typeof raw.pinnedSessionId === 'string' ? raw.pinnedSessionId.trim() : '',
    // 空串 = 跟随宿主当前默认(driver 建会话时对空值省略字段)
    agentPreset,
  }
  const model = normalizeSessionModel(raw.model)
  if (model) session.model = model
  // 投递前自动取消归档:任务级开关,只有固定会话会用到(新建会话与归档无关)
  if (raw.autoUnarchive === true) session.autoUnarchive = true
  return session
}

export function normalizeJob(body, { requireFutureTrigger = true, checkName = true } = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') throw new Error(JOB_MESSAGES.jobNameRequired)
  // 只在本次提交名称时校验长度:存量超长名称仍需能停用/改期
  if (checkName && name.length > JOB_NAME_MAX) throw new Error(JOB_MESSAGES.jobNameTooLong)
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  const kind = body.kind === 'session' ? 'session' : 'shell'
  if (body.kind !== 'shell' && body.kind !== 'session') throw new Error(JOB_MESSAGES.badKind)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (kind === 'shell' && command === '') throw new Error(JOB_MESSAGES.commandRequired)
  const schedule = normalizeSchedule(body.schedule)
  assertValidSchedule(schedule)
  // 无未来触发点(如 2 月 30 日)的表达式合法但永不执行:新建或改期时逐条拒绝
  // (任一表达式永不触发即整份计划不完整);旧数据里的此类表达式仍允许停用/改名等维护性 PATCH
  // 逐行只求值一次:校验用的下一次触发点与合并 nextAt 共用同一批结果
  const lineNext = splitSchedules(schedule).map((line) => nextRunAtOf(line))
  if (requireFutureTrigger && lineNext.includes(null)) throw new Error(JOB_MESSAGES.noFutureTrigger)
  const nextAt = lineNext.reduce((min, at) => (at === null ? min : min === null || at < min ? at : min), null)
  const normalized = {
    name,
    kind,
    command,
    prompt,
    workdir: typeof body.workdir === 'string' ? body.workdir.trim() : '',
    schedule,
    enabled: body.enabled !== false,
    session: normalizeSession(body),
  }
  if (normalized.session === undefined) delete normalized.session
  // 会话任务投递即终态无超时语义,timeoutMs 仅为 shell 真实执行保留
  if (kind === 'shell') {
    normalized.timeoutMs = Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_TIMEOUT_MS
  }
  // 单次运行:真实运行入队即禁用(executor dispatch 承担),缺省关闭
  normalized.runOnce = body.runOnce === true
  // 任务级并发上限:合法正整数才落库,缺省走全局闸门(executor min 规则);
  // 显式 null = 清空该键(mutate 按 undefined 删键),表达「不限并发」
  if (body.concurrency === null) normalized.concurrency = undefined
  else if (Number.isInteger(body.concurrency) && body.concurrency > 0) normalized.concurrency = body.concurrency
  // nextRunAt:调用方可显式指定(导入任务保留原状态 / 测试注入到期时刻),缺省按 schedule 计算
  normalized.nextRunAt = typeof body.nextRunAt === 'number' && Number.isFinite(body.nextRunAt)
    ? body.nextRunAt
    : nextAt
  return normalized
}
