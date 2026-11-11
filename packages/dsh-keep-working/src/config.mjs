/**
 * 配置解析:静态默认值 + 用户覆盖。
 *
 * 所有字段都有内置默认值,缺省即安全;数值一律 clamp 到可用区间,
 * 避免误配把恢复节奏压成高频循环。
 */

export const DEFAULTS = Object.freeze({
  graceMs: 3_000,
  cooldownMs: 20_000,
  maxConsecutive: 3,
  backoffFactor: 2,
  backoffMaxMs: 5 * 60_000,
  scanOnBoot: true,
  scanLimit: 8,
  freshMs: 30 * 60_000,
  resumeGoals: true,
  resumePausedGoals: false,
  resumeSilentTurns: true,
  pauseWhenOffline: true,
  offlineCheckMs: 15_000,
  classify: true,
  retryableErrorPatterns: '',
  paused: false,
  continueText: '继续。上一步结果未知,确认后继续。',
  continueTextMaxTokens: '继续。上一轮被输出上限截断,分段接着输出。',
  continueTextSilent: '继续。上一轮没有可见输出,直接说明结果或继续执行。',
  continueTextInterrupted: '继续。上一步结果未知,确认后继续。',
  closureText:
    '[keepWork] 结束必须显式提交:没改文件末行追加 (TASK_DONE);任务阻塞末行追加 (TASK_BLOCKED: 原因);改过文件必须最后只使用 present;禁止同时present和(TASK_DONE)',
})

const numberOr = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const booleanOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

const textOr = (value, fallback) =>
  typeof value === 'string' && value.trim() !== '' ? value : fallback

/** 行 config 的 volatile 字段是 boxed ref,逐字段解箱后再解析。 */
function unwrap(entry) {
  if (entry === null || typeof entry !== 'object') return {}
  const out = {}
  for (const [key, field] of Object.entries(entry)) {
    const raw = typeof field?.get === 'function' ? field.get() : field
    out[key] = raw !== null && typeof raw === 'object' ? structuredClone(raw) : raw
  }
  return out
}

/** 覆盖解析;未知字段忽略,非法值回落默认。 */
export function resolveConfig(input = {}, overrides = undefined) {
  const panel = unwrap(overrides ?? {})
  const value = { ...unwrap(input), ...Object.fromEntries(Object.entries(panel).filter(([, v]) => v !== undefined)) }
  return {
    graceMs: numberOr(value.graceMs, DEFAULTS.graceMs),
    cooldownMs: numberOr(value.cooldownMs, DEFAULTS.cooldownMs),
    maxConsecutive: Math.max(1, numberOr(value.maxConsecutive, DEFAULTS.maxConsecutive)),
    backoffFactor: Math.max(1, numberOr(value.backoffFactor, DEFAULTS.backoffFactor)),
    backoffMaxMs: numberOr(value.backoffMaxMs, DEFAULTS.backoffMaxMs),
    scanOnBoot: booleanOr(value.scanOnBoot, DEFAULTS.scanOnBoot),
    scanLimit: Math.max(1, numberOr(value.scanLimit, DEFAULTS.scanLimit)),
    freshMs: numberOr(value.freshMs, DEFAULTS.freshMs),
    resumeGoals: booleanOr(value.resumeGoals, DEFAULTS.resumeGoals),
    resumePausedGoals: booleanOr(value.resumePausedGoals, DEFAULTS.resumePausedGoals),
    resumeSilentTurns: booleanOr(value.resumeSilentTurns, DEFAULTS.resumeSilentTurns),
    pauseWhenOffline: booleanOr(value.pauseWhenOffline, DEFAULTS.pauseWhenOffline),
    offlineCheckMs: Math.max(1_000, numberOr(value.offlineCheckMs, DEFAULTS.offlineCheckMs)),
    classify: booleanOr(value.classify, DEFAULTS.classify),
    retryableErrorPatterns:
      typeof value.retryableErrorPatterns === 'string'
        ? value.retryableErrorPatterns.trim()
        : DEFAULTS.retryableErrorPatterns,
    paused: booleanOr(value.paused, DEFAULTS.paused),
    continueText: textOr(value.continueText, DEFAULTS.continueText),
    continueTextMaxTokens: textOr(value.continueTextMaxTokens, DEFAULTS.continueTextMaxTokens),
    continueTextSilent: textOr(value.continueTextSilent, DEFAULTS.continueTextSilent),
    continueTextInterrupted: textOr(value.continueTextInterrupted, DEFAULTS.continueTextInterrupted),
    closureText: textOr(value.closureText, DEFAULTS.closureText),
  }
}

/** 模板占位符替换;缺失值替换为空串。 */
export function fillTemplate(template, context = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    context[key] === undefined || context[key] === null ? '' : String(context[key]),
  )
}

/** 连续失败后的冷却:基础冷却 × 退避因子^n,封顶。 */
export function cooldownFor(config, consecutive) {
  const factor = config.backoffFactor ** Math.max(0, consecutive - 1)
  return Math.min(config.cooldownMs * factor, config.backoffMaxMs)
}
