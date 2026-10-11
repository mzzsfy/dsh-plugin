// 通知编排:事件先持久化 notice,投递经受管 prompt 通道(requestId=noticeId 重放去重,暂停期积压不投)。
// 自动唤醒未验证前不启用:投递仅由显式 deliver 动作触发(架构设计 通知投递条)。
import { fail, pass } from './command.mjs'

// 事件→notice 持久化(幂等:同 noticeId 重放返回原记录)
export function recordNotice(aggregate, { noticeId, kind, detail, now = Date.now() }) {
  if (!noticeId || !kind) return fail('INVALID_ARGUMENT', 'noticeId 与 kind 必填')
  const existing = aggregate.notices[noticeId]
  if (existing) return pass({ aggregate, replayed: true, notice: existing })
  const next = {
    ...aggregate,
    notices: { ...aggregate.notices, [noticeId]: { noticeId, kind, detail: detail ?? null, state: 'accepted', createdAt: now, deliveredAt: null } },
  }
  return pass({ aggregate: next, notice: next.notices[noticeId] })
}

// 投递判定:任务暂停/核对中积压不投;run 未终态不投
export function deliverable(aggregate, notice) {
  if (!notice || notice.state !== 'accepted') return false
  if (['paused', 'stopping', 'reconciling'].includes(aggregate.control.state)) return false
  const activeRuns = Object.values(aggregate.runs).some((r) => ['prepared', 'submitted', 'running'].includes(r.state))
  return !activeRuns
}

// 投递批次:一次性尝试全部 accepted notice,单条失败不阻塞他条(返回逐条结果,由调用方持久化)
export function planDelivery(aggregate, { deliver, send, now = Date.now() } = {}) {
  const results = []
  let agg = aggregate
  for (const notice of Object.values(aggregate.notices)) {
    if (!deliverable(agg, notice)) {
      results.push({ noticeId: notice.noticeId, delivered: false, reason: 'backlog' })
      continue
    }
    const outcome = send({ notice, requestId: `notice-${notice.noticeId}` })
    if (!outcome?.accepted) {
      results.push({ noticeId: notice.noticeId, delivered: false, reason: outcome?.message ?? 'rejected' })
      continue
    }
    agg = {
      ...agg,
      notices: { ...agg.notices, [notice.noticeId]: { ...notice, state: 'delivered', deliveredAt: now } },
    }
    results.push({ noticeId: notice.noticeId, delivered: true })
  }
  void deliver
  return pass({ aggregate: agg, results })
}
