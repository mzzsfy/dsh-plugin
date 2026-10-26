// session-driver:HostApiDriver 会话编排(设计 §4.3,生产实现唯一)。
// 发起 = 分组解析 + 新建/复用会话 + queue 投递;投递成功即终态(crontab 语义:看板只管触发,
// 执行状态归会话本身);pinned 忙跳过、未绑定/丢失自愈(三态区分)、发起成功即写 RunRecord.sessionId。
// 变量折叠与掩码由 env 文本构造承担。

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import { buildPromptText } from './env-text.mjs'

const BUSY_MESSAGE = '上一轮仍在进行'
const REBOUND_MESSAGE = '首次运行已创建并绑定会话'
const RECREATED_MESSAGE = '原会话丢失已重建'
const REJECTED_MESSAGE = '会话输入投递被拒绝'
const DELIVERED_MESSAGE = '已投递会话'
const MODEL_UNAVAILABLE_PREFIX = '模型不可用'
const MODEL_UNSUPPORTED_MESSAGE = '宿主会话服务不支持指定模型,任务模型设置无法生效'

// 宿主入口(prompt 准入 / listSessions 读取)逐版本形态有差异:prompt 各版本均非可选链校验
// signal,listSessions 各版本为可选链;进程内调用无取消来源,统一传永不中止的信号,
// 宿主仅在入口读一次不保留,共享单例安全,宿主将来收紧为非可选链亦无需再改
const ADMISSION_SIGNAL = new AbortController().signal

// pinned 自愈三态:未绑定过(首跑)/已绑定但会话丢失;两者都回写新绑定,仅文案不同
function recreatedMessage(recreated) {
  return recreated === 'unbound' ? REBOUND_MESSAGE : RECREATED_MESSAGE
}

// 分组解析(dsh-im workspaceId 同构):按任务 workdir 找已有分组,未命中建同名分组;
// registry 缺失或 workdir 不存在时降级为无分组,由调用方回落 cwd 路径
async function resolveWorkspaceId(registry, workdir) {
  if (!registry || typeof registry.resolveByPath !== 'function' || typeof registry.createCanonical !== 'function') {
    return undefined
  }
  const existing = await registry.resolveByPath(workdir)
  if (existing) return existing.id
  const canonical = await realpath(workdir)
  const created = await registry.createCanonical(canonical)
  return created.id
}

// 模型标签(记录面):'provider/model' 或指定 effort 时 'provider/model(effort)'
function modelLabel(model) {
  return model.reasoningEffort ? model.provider + '/' + model.model + '(' + model.reasoningEffort + ')' : model.provider + '/' + model.model
}

// 投递前模型可用性校验:目录是运行时事实,未列出即不可用(不猜宿主解析行为);
// failures 携带宿主原始原因(凭据缺失等),拼接保证可读。返回 undefined 表示不可用
function catalogSelection(raw, modelCatalog) {
  const routable = Array.isArray(modelCatalog.routableProviders) ? modelCatalog.routableProviders : []
  if (!routable.includes(raw.provider)) {
    const failure = (Array.isArray(modelCatalog.failures) ? modelCatalog.failures : []).find((item) => item && item.id === raw.provider)
    return { error: MODEL_UNAVAILABLE_PREFIX + ':provider "' + raw.provider + '" 未注册或目录加载失败' + (failure && failure.message ? '(' + failure.message + ')' : '') }
  }
  const group = (Array.isArray(modelCatalog.groups) ? modelCatalog.groups : []).find((item) => item && item.id === raw.provider)
  const entry = group && Array.isArray(group.models) ? group.models.find((item) => item && item.id === raw.model) : undefined
  if (!entry) {
    return { error: MODEL_UNAVAILABLE_PREFIX + ':模型 "' + raw.model + '" 不在 provider "' + raw.provider + '" 的目录中' }
  }
  if (raw.reasoningEffort !== undefined) {
    const efforts = entry.reasoning && Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts : []
    if (!efforts.some((effort) => effort && effort.id === raw.reasoningEffort)) {
      return { error: MODEL_UNAVAILABLE_PREFIX + ':推理强度 "' + raw.reasoningEffort + '" 不被模型 "' + raw.model + '" 支持' }
    }
  }
  return { selection: { provider: raw.provider, model: raw.model, ...(raw.reasoningEffort !== undefined ? { reasoningEffort: raw.reasoningEffort } : {}) } }
}

// 任务显式指定模型时的能力与目录校验(建会话前,失败不留残缺会话);
// 目录是运行时事实,未列出即不可用(不猜宿主解析行为),failures 携带宿主原始原因。
// 能力面稳定性:sessionController.agents 在宿主类型为 private(0.2.x 实现细节非服务契约),
// modelCatalog 为公开面;私有面重构时此处在 typeof 门控下干净退化为「不支持指定模型」,
// 不崩溃不误投递——依赖等级即「探测可用则用,不可用即拒」,不随宿主内部形态漂移产生部分生效
async function validateModelSelection(sessionController, raw) {
  if (typeof sessionController.modelCatalog !== 'function' || !sessionController.agents || typeof sessionController.agents.selectForNextRequest !== 'function' || typeof sessionController.agents.resolveAgent !== 'function') {
    return { fail: MODEL_UNSUPPORTED_MESSAGE }
  }
  let modelCatalog
  try {
    modelCatalog = await sessionController.modelCatalog()
  } catch (error) {
    return { fail: MODEL_UNAVAILABLE_PREFIX + ':模型目录读取失败(' + String(error && error.message || error) + ')' }
  }
  const checked = catalogSelection(raw, modelCatalog || {})
  if (checked.error) return { fail: checked.error }
  return { selection: checked.selection }
}

export function createSessionDriver({ getSessionController, getWorkspaceRegistry, agents, sessionQuery }) {
  // pinned 会话存在性:持久层 headers 比对(冷会话不在 agents 注册表);
  // 记录形态为官方 SessionRecord(dsh-session-query),id 在 header.id
  async function pinnedExists(sessionId) {
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return Boolean(agents.get(sessionId))
    const records = await sessionQuery.listSessions(ADMISSION_SIGNAL)
    return records.some((record) => record && record.header && record.header.id === sessionId)
  }

  // pinned 可用性:已删除(不在持久层)或已归档(从所有分组视图隐藏)均视为丢失,触发重建
  async function pinnedUsable(sessionId) {
    const registry = getWorkspaceRegistry ? getWorkspaceRegistry() : undefined
    const archivedIds = registry?.archivedSessionIds
    if (Array.isArray(archivedIds) && archivedIds.includes(sessionId)) return false
    return pinnedExists(sessionId)
  }

  // 建会话请求:分组按 workdir 挂载(dsh-im 同构);执行预设非空才带字段,
  // 缺省时省略 agentPreset 由宿主解析当前默认
  async function createSession(sessionController, workdir, agentPreset) {
    const payload = {}
    if (workdir) {
      const registry = getWorkspaceRegistry ? getWorkspaceRegistry() : undefined
      const workspaceId = await resolveWorkspaceId(registry, workdir).catch(() => undefined)
      if (workspaceId) payload.workspaceId = workspaceId
      else payload.cwd = workdir
    }
    if (agentPreset) payload.agentPreset = agentPreset
    // 宿主 host 方法签名无默认参(create(request) 首行即读 request.workspaceId),
    // 进程内直调空载必须传空对象而非 undefined
    return sessionController.create(payload)
  }

  async function run({ job, env, mask, updateRecord }) {
    // 控制器运行时动态解析:装配可能先于宿主挂载 sessionController(异步就绪等待中)
    const sessionController = getSessionController ? getSessionController() : undefined
    if (!sessionController) return { status: 'fail', message: '会话服务不可用' }
    const session = job.session || {}
    const isPinned = session.mode === 'pinned'
    let sessionId = isPinned ? session.pinnedSessionId : null
    let recreated = false

    if (isPinned) {
      // pinned 串行:上轮未完成直接跳过(不排队,agents 实时状态判定)
      const entry = agents ? agents.get(sessionId) : undefined
      if (entry && entry.status === 'running') {
        return { status: 'skipped', message: BUSY_MESSAGE }
      }
      if (!sessionId) {
        recreated = 'unbound'
      } else if (!(await pinnedUsable(sessionId))) {
        recreated = 'lost'
      }
    }

    // 模型指定面:任务显式配置才走,校验在建会话前(失败不残留新会话);
    // 未指定零动作,行为与未提供该设置的版本一致
    let model
    if (session.model && session.model.provider && session.model.model) {
      const resolved = await validateModelSelection(sessionController, session.model)
      if (resolved.fail) return { status: 'fail', message: resolved.fail }
      model = modelLabel(resolved.selection)
    }

    if (recreated || !isPinned) {
      const created = await createSession(sessionController, job.workdir, session.agentPreset)
      sessionId = created.sessionId
    }

    // 会话内安装(纯会话面,无宿主全局副作用):宿主 resolveAgent 返回 {agent}/{error} 包装
    // (ApiSessionAgentController 契约),fresh 复用与 pinned 冷会话都经它解包;
    // 解析失败(会话被写句柄占用等)在投递前 fail 并透传宿主原因
    if (model) {
      const found = await sessionController.agents.resolveAgent(sessionId)
      if (!found || found.error || !found.agent) {
        const detail = found && found.error && found.error.message ? found.error.message : 'agent 未就绪'
        return { status: 'fail', message: MODEL_UNAVAILABLE_PREFIX + ':会话不可用(' + detail + ')', sessionId }
      }
      try {
        sessionController.agents.selectForNextRequest(found.agent, session.model)
      } catch (error) {
        // 宿主安装面异常(modelSelection 投影未注册等)在投递前收敛为可读 fail,不落原始异常串
        return { status: 'fail', message: MODEL_UNAVAILABLE_PREFIX + ':模型安装失败(' + String(error && error.message || error) + ')', sessionId }
      }
    }

    const submission = await sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: buildPromptText({ prompt: job.prompt || '', env, mask }) }],
    }, ADMISSION_SIGNAL)
    if (!submission || submission.accepted !== true) {
      return { status: 'fail', message: REJECTED_MESSAGE, sessionId }
    }
    if (typeof updateRecord === 'function') {
      await updateRecord({ sessionId })
    }
    // 投递即终态:运行记录反映触发结果,执行进展在会话内查看
    return {
      status: 'success',
      sessionId,
      ...(model ? { model } : {}),
      message: recreated ? recreatedMessage(recreated) : DELIVERED_MESSAGE,
      ...(recreated ? { pinnedNewId: sessionId } : {}),
    }
  }

  return {
    run,
  }
}
