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

/** 面板语义说明:字段 -> 一句解释。 */
export const PANEL_HINTS = {
  paused: '全局暂停:开启后不再自动补发任何消息',
  graceMs: '回合结束到补发之间的等待时间',
  cooldownMs: '连续补发后的基础冷却时间',
  maxConsecutive: '同一会话最多连续补发几次,到顶后停手',
  scanOnBoot: '宿主启动时扫描上次没结案的会话并接着跑',
  resumeSilentTurns: '恢复只输出思考、没有可见回复的回合',
  pauseWhenOffline: '断网时不重试,联网后自动继续',
  classify: '区分永久错误(鉴权、余额等)与临时错误,永久错误不重试',
  continueText: '出错后自动补发的内容',
  continueTextInterrupted: '宿主重启后自动补发的内容',
  continueTextSilent: '无可见输出时自动补发的内容',
  continueTextMaxTokens: '被输出上限截断时自动补发的内容',
  closureText: '没检测到结案信号时发给模型的要求',
}

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
