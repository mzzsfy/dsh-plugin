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

export function createSessionDriver({ getSessionController, getWorkspaceRegistry, agents, sessionQuery }) {
  // pinned 会话存在性:持久层 headers 比对(冷会话不在 agents 注册表)
  async function pinnedExists(sessionId) {
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return Boolean(agents.get(sessionId))
    const records = await sessionQuery.listSessions(ADMISSION_SIGNAL)
    return records.some((record) => record && record.id === sessionId)
  }

  // pinned 可用性:已删除(不在持久层)或已归档(从所有分组视图隐藏)均视为丢失,触发重建
  async function pinnedUsable(sessionId) {
    const registry = getWorkspaceRegistry ? getWorkspaceRegistry() : undefined
    const archivedIds = registry?.archivedSessionIds
    if (Array.isArray(archivedIds) && archivedIds.includes(sessionId)) return false
    return pinnedExists(sessionId)
  }

  async function createSession(sessionController, workdir) {
    if (!workdir) return sessionController.create(undefined)
    const registry = getWorkspaceRegistry ? getWorkspaceRegistry() : undefined
    const workspaceId = await resolveWorkspaceId(registry, workdir).catch(() => undefined)
    if (workspaceId) return sessionController.create({ workspaceId })
    return sessionController.create({ cwd: workdir })
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

    if (recreated || !isPinned) {
      const created = await createSession(sessionController, job.workdir)
      sessionId = created.sessionId
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
      message: recreated ? recreatedMessage(recreated) : DELIVERED_MESSAGE,
      ...(recreated ? { pinnedNewId: sessionId } : {}),
    }
  }

  return {
    run,
  }
}
