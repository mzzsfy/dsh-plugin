// 官方 pwsh 链(tool-pwsh + pwsh-sandbox)entry 生命周期探测与运行时接管。
// 运行时接管(替代 bundle patch 静态禁行):官方两行的禁用由本包主行 apply
// 落定后经 entry.update(dsh-market 同款调用)执行——禁用官方的前提严格强于
// 本包可服务性,本包任意死法(模块加载崩/apply 中途崩/被禁/卸载)下官方行
// 保持启用,官方 pwsh 链自服务,系统不出现 shell 全灭窗口。
//
// 接管空间的判定与 gateway(llm-pi-ai 行无 disabled 声明,undefined=默认态)
// 不同:官方两行在 dsh-base 带平台表达式 `disabled: !!js process.platform !==
// 'win32'`,win32 上求值 false——宿主默认启用态与「用户显式启用」在行树上
// 不可区分。因此行级 false 不作为让位信号:凡非 true(启用中)即接管空间,
// 用户意图通道改为「禁用本包」(market 禁主行或 user patch 禁行,重启后官方
// 自然回归)。getter 求值抛错(宿主状态异常)仍让位安全向;非布残值同样保守
// 让位。链式语义:禁用只更新启用中的行(0.1.7 web 面常态:tool-pwsh 被宿主
// patch 禁用、pwsh-sandbox 平台默认启用,混合态下仅禁后者)。

// 官方受控行 id 与行 id 解析前缀(guard-state 同源共享)
import { OFFICIAL_ROW_IDS, ROW_ID_PREFIXES } from './guard-state.mjs'

// 退场轮询步长与轮数上限,乘积为等待上界(guard 同源常量)
export const EXIT_POLL_INTERVAL_MS = 20
export const EXIT_POLL_ROUNDS = 50

const ABSENT = Object.freeze({ present: false, disabled: false, running: false, entry: undefined, disabledUnreliable: false, rawDisabled: true })

// 宿主 Entry.disabled getter 语义:!!js 表达式求值 + 父链回溯 + 布尔宽化,
// 裸读 options.disabled 会漏掉表达式与非布尔真值两类禁用形态;求值抛错按
// 未禁用处理并置 disabledUnreliable(宿主状态异常,自动动作一律让位安全向)
function effectiveDisabled(entry) {
  try {
    return entry.disabled === true
  } catch {
    return undefined
  }
}

/**
 * 探测单个官方行生命周期状态。loader 缺失或行不存在按缺席处理(官方包未装
 * 时照常接管,与「官方包缺失时本包独占」的既有降级语义一致)。disabled
 * getter 求值抛错时 disabled=false 且 disabledUnreliable=true。rawDisabled
 * 为 options.disabled 原始值(仅观测留档:真机形态是 !!js 表达式包装对象,
 * 决策不消费它,启用中判定走 disabled 求值结果)。
 * @param {object|undefined} loader 宿主 loader 服务(cordis Loader/EntryTree)
 * @param {string} id 行 id
 */
export function officialRowState(loader, id) {
  if (loader?.resolve === undefined) return ABSENT
  let entry
  for (const prefix of ROW_ID_PREFIXES) {
    try {
      const candidate = loader.resolve(prefix + id)
      if (candidate) {
        entry = candidate
        break
      }
    } catch {
      // 该命名空间无此行,试下一前缀
    }
  }
  if (!entry) return ABSENT
  const disabled = effectiveDisabled(entry)
  let rawDisabled
  try {
    rawDisabled = entry.options?.disabled
  } catch {
    rawDisabled = undefined
  }
  return {
    present: true,
    disabled: disabled === true,
    running: entry.fiber?.uid != null,
    entry,
    disabledUnreliable: disabled === undefined,
    rawDisabled,
  }
}

/**
 * 官方双行状态快照(id → 行状态,键序与 OFFICIAL_ROW_IDS 一致)。
 * @param {object|undefined} loader
 */
export function officialChainState(loader) {
  return Object.fromEntries(OFFICIAL_ROW_IDS.map((id) => [id, officialRowState(loader, id)]))
}

/**
 * 接管决策(链为单位):任一行 getter 求值不可信 → 让位安全向;全部已禁停稳
 * → 接管;禁用但在退场 → 等待;存在启用中的行(getter 求值 false:平台默认
 * 与无声明同形,同为接管空间)→ runtime-disable,仅禁启用中的行。注意
 * options.disabled 原始值可能是 !!js 表达式包装对象(真机实证,非求值布尔),
 * 启用中判定必须走 entry.disabled getter 求值结果,不读原始值。行缺席视为
 * 已禁(不参与 update),全缺席 = 官方包未装 = 直接接管。
 * @param {Record<string, object>} states officialChainState 快照
 * @returns {{ decision: 'takeover'|'await-exit'|'yield'|'runtime-disable', targets: object[] }}
 *   targets = runtime-disable 时需 update 的 entry 清单,其余态为空
 */
export function takeoverDecision(states) {
  const rows = OFFICIAL_ROW_IDS.map((id) => states[id] ?? ABSENT)
  if (rows.some((row) => row.present && row.disabledUnreliable)) return { decision: 'yield', targets: [] }
  const targets = rows.filter((row) => row.present && row.disabled !== true).map((row) => row.entry)
  if (targets.length > 0) return { decision: 'runtime-disable', targets }
  const exiting = rows.some((row) => row.present && row.running)
  return { decision: exiting ? 'await-exit' : 'takeover', targets: [] }
}

/**
 * 运行时禁用一批官方行:dsh-market toggle 同款调用(force update,穿透
 * 「init 在途时 options 翻转但收尾 init 仍拉起 fiber」的空 diff 形态)。
 * 逐行独立执行,单行失败不中止其余行;调用方据失败清单决定回滚。
 * 纯内存态不持久:重启后官方行回归行树声明态,由下一轮 apply 收敛。
 * @param {object[]} entries 官方 loader entry 清单
 * @param {{quiet?: boolean, force?: boolean}} [options]
 * @returns {Promise<{disabled: object[], failed: object[]}>}
 */
export async function runtimeDisableRows(entries, { quiet = false, force = true } = {}) {
  const disabled = []
  const failed = []
  for (const entry of entries) {
    try {
      await entry.update({ disabled: true }, quiet, force)
      disabled.push(entry)
    } catch {
      failed.push(entry)
    }
  }
  return { disabled, failed }
}

/**
 * 回滚:重新启用已禁的官方行(update {disabled:false}),官方链复活。
 * 仅在接管序列失败路径调用;quiet 减噪(失败路径已另行告警),逐行独立,
 * 失败不抛(重启后行树声明态自然归位)。
 * @param {object[]} entries
 */
export async function rollbackDisabledRows(entries) {
  for (const entry of entries) {
    try {
      await entry.update({ disabled: false }, true, true)
    } catch {
      // 回滚失败不抛:重启收敛
    }
  }
}

const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 有界等待官方行退场(fiber 清)。dispose 为纯内存操作毫秒级完成,轮询上界
 * 仅防御异常宿主状态。fiber 清空后官方注册的撤销还在卸载收尾(微任务批)中
 * 完成,返回前补一轮间隔让收尾落定,避免挂载执行器时与官方未撤完的 ctx.shell
 * 注册交错(cordis 重复 provide 抛错)。
 * @param {object[]} entries 官方 loader entry 清单
 * @param {{intervalMs?: number, rounds?: number, delay?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<boolean>} true = 已全部退场;false = 轮询耗尽仍有在场
 */
export async function awaitOfficialExit(entries, {
  intervalMs = EXIT_POLL_INTERVAL_MS,
  rounds = EXIT_POLL_ROUNDS,
  delay = defaultDelay,
} = {}) {
  const stillRunning = () => entries.some((entry) => entry.fiber?.uid != null)
  for (let round = 0; round < rounds && stillRunning(); round += 1) {
    await delay(intervalMs)
  }
  if (stillRunning()) return false
  await delay(intervalMs)
  return true
}
