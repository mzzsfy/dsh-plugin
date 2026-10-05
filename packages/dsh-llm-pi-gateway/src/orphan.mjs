// 孤儿接管判定与自愈:宿主 inject-epoch 级联(官方行运行时禁用触发
// 'llm' impl 换 fiber)会卸载 gateway 行 fiber——注册全灭且宿主不重建,
// 而 applyState 残留 active 使行呈「假活」。活体实证宿主还会把异常死亡
// 行宽化为 disabled(entry.disabled 有效态)并重建官方行、无视内存禁用
// (官方 fiber 在场),故判定一律用声明态(options.disabled),不读宽化
// 有效态。guard fiber 无入口注入,级联幸存(census 实证),据此自愈:
// 形态A 官方声明禁用(停稳=经典孤儿;在场=宿主重建无视禁用,确认轮滤
//       接管在途瞬态)
// 形态B 官方声明启用且在跑(宿主以声明态重建)
// 自愈次序:官方未停稳先禁之待停稳(幂等),再往返重启 gateway 行,使新
// apply 落 takeover 决策(官方禁用停稳)——takeover 分支不执行运行时禁
// 用动作,级联源头消失,一轮收敛,杜绝「revive→级联→revive」死循环。
// 官方声明启用且停稳 = 官方启动失败/未到,归死态代挂域,本通道不适用。

import { OFFICIAL_ENTRY_ID, EXIT_POLL_INTERVAL_MS, EXIT_POLL_ROUNDS } from './takeover.mjs'
import { gatewayApplyState } from './apply-state.mjs'
import { GATEWAY_ENTRY_ID, resolveEntry, settled } from './guard.js'

// PENDING 同构:行尚无法解析,调用方本轮跳过
export const PENDING = null

// 声明禁用 = 用户/接管残留意图,复活归死态代挂域,本通道不抢
const declaredDisabled = (entryRow) => {
  try {
    return entryRow?.options?.disabled === true
  } catch {
    return false
  }
}

/**
 * 孤儿接管判定。返回 true = 需自愈;false = 不适用;PENDING = 行不可解析
 * (树未就绪),调用方稍后重试。
 * @param {object|undefined} loader
 * @returns {boolean|PENDING}
 */
export function detectOrphanTakeover(loader) {
  const gateway = resolveEntry(loader, GATEWAY_ENTRY_ID)
  const official = resolveEntry(loader, OFFICIAL_ENTRY_ID)
  if (gateway === PENDING || official === PENDING) return PENDING
  if (declaredDisabled(gateway)) return false
  if (!settled(gateway)) return false
  if (gatewayApplyState() !== 'active') return false
  // 形态A:官方声明禁用(停稳在场皆可;在场形态靠确认轮滤接管在途瞬态)
  if (declaredDisabled(official)) return true
  // 形态B:官方声明启用且在跑(宿主重建)= gateway 死而官方活
  return !settled(official)
}

/**
 * 孤儿自愈:官方未停稳先禁之待停稳(幂等,形态A在场/形态B 共用前置),
 * 随后往返重启 gateway 行——新 apply 以 takeover 决策重建全部注册。两笔
 * 均 force(market toggle 同款调用,穿透 init 在途的空 diff 形态)。
 * @param {object} loader
 * @param {{delay?: (ms: number) => Promise<void>}} [hooks]
 */
export async function reviveGateway(loader, { delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const gateway = resolveEntry(loader, GATEWAY_ENTRY_ID)
  const official = resolveEntry(loader, OFFICIAL_ENTRY_ID)
  if (gateway === PENDING || gateway === undefined || official === PENDING || official === undefined) return false
  // 前置:官方未停稳先禁用待停稳,新 apply 才落 takeover
  if (!settled(official)) {
    await official.update({ disabled: true }, false, true)
    for (let round = 0; round < EXIT_POLL_ROUNDS; round += 1) {
      if (settled(official)) break
      await delay(EXIT_POLL_INTERVAL_MS)
    }
  }
  await gateway.update({ disabled: true }, false, true)
  for (let round = 0; round < EXIT_POLL_ROUNDS; round += 1) {
    if (settled(gateway)) break
    await delay(EXIT_POLL_INTERVAL_MS)
  }
  await gateway.update({ disabled: false }, false, true)
  return true
}
