// session-driver:HostApiDriver 会话编排(设计 §4.3,生产实现唯一)。
// 发起 = 新建/复用会话 + queue 投递;完成判定 = agents 状态脱离 running(轮询 + timeoutMs 收尾);
// pinned 忙跳过、丢失自愈、发起成功即写 RunRecord.sessionId。变量折叠与掩码由 env 文本构造承担。

import { randomUUID } from 'node:crypto'

import { buildPromptText } from './env-text.mjs'

const BUSY_MESSAGE = '上一轮仍在进行'
const RECREATED_MESSAGE = '原会话丢失已重建'
const REJECTED_MESSAGE = '会话输入投递被拒绝'

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

export function createSessionDriver({ getSessionController, agents, sessionQuery, pollIntervalMs = 2 * 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  // pinned 会话存在性:持久层 headers 比对(冷会话不在 agents 注册表)
  async function pinnedExists(sessionId) {
    if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return Boolean(agents.get(sessionId))
    const records = await sessionQuery.listSessions()
    return records.some((record) => record && record.id === sessionId)
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
      // pinned 串行:上轮未完成直接跳过(不排队)
      const entry = agents ? agents.get(sessionId) : undefined
      if (entry && entry.status === 'running') {
        return { status: 'skipped', message: BUSY_MESSAGE }
      }
      if (!sessionId || !(await pinnedExists(sessionId))) {
        recreated = true
      }
    }

    if (recreated || !isPinned) {
      const created = await sessionController.create(job.workdir ? { cwd: job.workdir } : undefined)
      sessionId = created.sessionId
    }

    const submission = await sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: buildPromptText({ prompt: job.prompt || '', env, mask }) }],
    })
    if (!submission || submission.accepted !== true) {
      return { status: 'fail', message: REJECTED_MESSAGE, sessionId }
    }
    if (typeof updateRecord === 'function') {
      await updateRecord({ sessionId })
    }

    // 完成等待:状态脱离 running 即结算,timeoutMs 到点收尾
    const timeoutMs = Number.isInteger(job.timeoutMs) && job.timeoutMs > 0 ? job.timeoutMs : DEFAULT_TIMEOUT_MS
    const deadline = now() + timeoutMs
    while (now() < deadline) {
      const entry = agents ? agents.get(sessionId) : undefined
      if (!entry || entry.status !== 'running') {
        return {
          status: 'success',
          sessionId,
          ...(recreated ? { pinnedNewId: sessionId, message: RECREATED_MESSAGE } : {}),
        }
      }
      await sleep(pollIntervalMs)
    }
    return {
      status: 'timeout',
      sessionId,
      ...(recreated ? { pinnedNewId: sessionId, message: RECREATED_MESSAGE + ';超时未完成' } : {}),
    }
  }

  return {
    run,
  }
}
