/**
 * 设置面:面板字段直接来自 cordis Config 的 volatile 字段,
 * 经宿主 settings 服务读写,插件不另立 schema。
 */

import { DEFAULTS } from './config.mjs'

export const NAMESPACE = 'keep-working'

/** 面板暴露的字段,其余字段留给 cordis 配置。 */
export const PANEL_FIELDS = [
  'paused',
  'graceMs',
  'cooldownMs',
  'maxConsecutive',
  'scanOnBoot',
  'resumeSilentTurns',
  'pauseWhenOffline',
  'classify',
  'continueText',
  'continueTextInterrupted',
  'continueTextSilent',
  'continueTextMaxTokens',
  'closureText',
]

/** 读面板值;服务缺失或读取失败时返回 undefined,由调用方回落 cordis 配置。 */
export function readSettings(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.describe !== 'function') return undefined
  try {
    const descriptor = settings.describe().find((item) => item.ns === NAMESPACE)
    return descriptor?.value
  } catch {
    return undefined
  }
}

/** 读当前修订号,写回时用作乐观锁。 */
function currentRevision(settings) {
  try {
    return settings.describe().find((item) => item.ns === NAMESPACE)?.revision
  } catch {
    return undefined
  }
}

/** 写面板值;返回是否成功,失败由路由层转成 503。 */
export async function writeSettings(ctx, patch) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.update !== 'function') return false
  await settings.update(NAMESPACE, patch, currentRevision(settings))
  return true
}

/** 面板默认值:统一从 DEFAULTS 取,避免前后端各写一份。 */
export function panelDefaults() {
  return Object.fromEntries(PANEL_FIELDS.map((key) => [key, DEFAULTS[key]]))
}
