// guard 死态判定(纯函数):主行功能性停摆(禁用停稳 / 旗标 inactive;崩溃
// pending 保守不判)且官方两行被禁停稳。行 id 解析与 Entry.disabled getter
// 语义同构 dsh-llm-pi-gateway takeover.mjs(!!js 求值 + 布尔宽化,抛错按未禁)。

// 本包主行 id(cordis.patch.yml insert 声明)
export const MAIN_ROW_ID = 'shell-select'
// 官方受控行 id(dsh-base cordis.patch.yml 声明)
export const OFFICIAL_ROW_IDS = ['tool-pwsh', 'pwsh-sandbox']

// 行 id 解析候选前缀:宿主把 profile 行树经 cordis:include 挂载,受控行实际
// 解析 id 带前缀;空串覆盖裸树形态(官方同构)
export const ROW_ID_PREFIXES = ['include:', '']

const ABSENT = Object.freeze({ present: false, disabled: false, running: false })

/** Entry.disabled getter 语义:求值抛错按未禁处理(让位安全向,不占官方资源)。 */
export function effectiveDisabled(entry) {
  try {
    return entry.disabled === true
  } catch {
    return false
  }
}

/**
 * 行状态探测;loader 缺失或行不存在按缺席。
 * @returns {{present: boolean, disabled: boolean, running: boolean}}
 */
export function rowState(loader, id) {
  if (loader?.resolve === undefined) return ABSENT
  for (const prefix of ROW_ID_PREFIXES) {
    try {
      const entry = loader.resolve(prefix + id)
      if (entry) {
        return {
          present: true,
          disabled: effectiveDisabled(entry),
          running: entry.fiber?.uid != null,
        }
      }
    } catch {
      // 该命名空间无此行,试下一候选
    }
  }
  return ABSENT
}

/**
 * 死态判定:主行功能性停摆且官方两行全部禁用停稳。
 * @param {object} loader 宿主 loader 服务
 * @param {{applyState: () => string}} faces apply 旗标读数
 * @returns {boolean} PENDING 形态(行不可解析)按 false 处理,下轮再扫
 */
export function detectDeadState(loader, { applyState }) {
  const main = rowState(loader, MAIN_ROW_ID)
  const mainStalled = (main.present && main.disabled && !main.running) || applyState() === 'inactive'
  if (!mainStalled) return false
  return OFFICIAL_ROW_IDS.every((id) => {
    const state = rowState(loader, id)
    return !state.present || (state.disabled && !state.running)
  })
}
