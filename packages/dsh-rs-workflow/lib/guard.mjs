// 会话守门:轮次将停时判定本会话编排是否欠动作(persona 判据 3 的机器化执行)
// 判据来源:running 且无活跃段 job → 欠 resume;paused 且 awaitingResume → 欠 resume;
// waiting_approval → 欠裁决。终态与无现役 run 不拦。
// 拦截手段由调用方承担(agent.steer 投喂提醒消息,机器重读 inbox 后继续跑)。

// 单个欠动作周期的提醒上限:弱模型可能忽略首次提醒,但无限提醒会烧 token 死循环。
// 计数在轮次不欠动作时清零,故多步编排的每个欠动作周期各自享有上限,而非全 run 共享。
export const MAX_NUDGE = 2

const ACTION_OF_STATUS = {
  waiting_approval: { need: '裁决', text: '等待裁决' },
  paused: { need: 'resume', text: '已暂停' },
}

/** 判据:record 状态 + driver 活跃度 → 是否欠动作;无现役 run / 终态 / 段在飞均返回 undefined */
export function pendingOf(record, driver) {
  if (record === undefined) return undefined
  if (record.status === 'running') {
    // 段在飞即正常等待:段 job settle 会经完成通知唤醒主循环,此时轮次停是合理行为
    return driver?.active === true ? undefined : { need: 'resume', text: '运行中待拉起' }
  }
  const known = ACTION_OF_STATUS[record.status]
  if (known === undefined) return undefined
  if (record.status === 'paused' && driver?.awaitingResume !== true) {
    // paused 且页签未发恢复:裁决已入队的 resume 拉段仍欠——段首生效前欠动作不变
    if ((record.state?.pendingApprovals?.length ?? 0) > 0) return { need: 'resume', text: '已暂停(待生效裁决)' }
    return undefined
  }
  return known
}

/** 提醒计数闸:按欠动作周期独立计数,超上限返回 false(调用方改记告警,不再 steer) */
export function createNudgeGate(maxNudge = MAX_NUDGE) {
  const counts = new Map()
  const warned = new Set()
  return {
    take(runId) {
      const used = counts.get(runId) ?? 0
      if (used >= maxNudge) return false
      counts.set(runId, used + 1)
      return true
    },
    clear(runId) {
      counts.delete(runId)
      warned.delete(runId)
    },
    used(runId) {
      return counts.get(runId) ?? 0
    },
    /** 首次触顶返回 true,此后false(告警只一次;clear 重置) */
    exhausted(runId) {
      if ((counts.get(runId) ?? 0) < maxNudge) return false
      if (warned.has(runId)) return false
      warned.add(runId)
      return true
    },
  }
}

/** 提醒文案:给出 runId / 状态 / 欠动作,并指向应调用的工具 */
export function nudgeText(runId, pending) {
  // waiting_approval 有合法终止路径(转呈真人后等输入),文案带豁免以免误伤已处置的轮次
  const dispense = pending.need === '裁决'
    ? '裁决按模板 autoApprove 决定代审或转呈真人;若已转呈真人并等待其输入,则本轮无需再动作,可直接结束轮次。'
    : '欠 resume 调 rs_workflow_resume 补拉。'
  return `[若水守门] 本会话编排 ${runId} 未终态(状态=${pending.text},欠动作=${pending.need})。请立即调用 rs_workflow_status 查看并按流程纪律处置:${dispense}处置完成后才可结束轮次。`
}