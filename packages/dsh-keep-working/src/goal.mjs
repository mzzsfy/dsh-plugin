/**
 * goal 再武装:宿主重启后目标一律 disarmed;宿主 pre-step 拒绝又会被 goal driver
 * 记成 blocked(prompt-rejected)。两者都不是模型的决定,交回 driver 才会继续排轮次。
 */

/** 宿主基础设施拒绝(维护闸门、归档竞争)写下的阻塞码;模型自述阻塞不走这里。 */
export const REJECTED_BLOCK_CODE = 'prompt-rejected'

/** 返回是否已交回 goal driver 驱动。 */
export function rearmGoal(ctx, agent, config) {
  if (!config.resumeGoals) return false
  const goals = ctx.get('goals')
  if (goals === undefined) return false
  try {
    const view = goals.get(agent)
    if (view === undefined || view.revision === undefined) return false
    const ref = { id: view.id, revision: view.revision }
    if (view.phase === 'active' && view.activation === 'disarmed') {
      goals.resume(agent, ref)
      return true
    }
    // 暂停是人的决定,只有显式开启才接管
    if (view.phase === 'paused' && config.resumePausedGoals) {
      goals.resume(agent, ref)
      return true
    }
    // 预检拒绝不是模型声明受阻:不重新武装就永远停在 blocked,人工不点就没有下一轮
    if (view.phase === 'blocked' && view.blockedReason?.code === REJECTED_BLOCK_CODE) {
      goals.resume(agent, ref)
      return true
    }
    return false
  } catch (error) {
    ctx.logger?.warn?.(`[keep-working] goal 恢复失败 ${agent?.id}: ${String(error)}`)
    return false
  }
}
