/**
 * durable inbox 重放:恢复判定共用的事件折叠层。
 *
 * 宿主把尚未消费的输入持久化为 `agent/inbox/spliced`,只有下一回合真正开始时
 * 才会被 claim。重启扫描与实时判定都必须自己发现这些堆积的输入。
 */

/** 排队消息只缺一次唤醒,不需要解释上一轮状态。 */
export const QUEUED_RESUME_TEXT = '继续'

/**
 * 重放会话日志里的 durable inbox 投影,得到仍在排队的输入。
 *
 * next-turn 全部算待处理输入;next-step 只算真人插话——其余是运行时上下文注入,
 * 不该凭它拉起整轮。返回条数与最后一次入队时间。
 */
export function pendingInbox(events) {
  const queues = { 'next-turn': [], 'next-step': [] }
  let lastAt = 0
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue
    const data = event.data ?? {}
    const queue = queues[data.target]
    if (queue === undefined) continue
    const declared = Number.isSafeInteger(data.start) ? data.start : 0
    const start = declared < 0 ? Math.max(queue.length + declared, 0) : Math.min(declared, queue.length)
    const removed = Math.min(
      Math.max(Number.isSafeInteger(data.removedCount) ? data.removedCount : 0, 0),
      queue.length - start,
    )
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    queues[data.target] = [...queue.slice(0, start), ...inserted, ...queue.slice(start + removed)]
    if (inserted.length > 0 && typeof event.time === 'number') lastAt = Math.max(lastAt, event.time)
  }
  const steering = queues['next-step'].filter((message) => message?.source?.kind === 'user').length
  return { count: queues['next-turn'].length + steering, lastAt }
}
