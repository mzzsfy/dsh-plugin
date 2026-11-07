// 宿主与客户端共享的配置事实源(客户端不能 import,内联副本由测试对表)
export const DEFAULT_CONFIG = Object.freeze({
  restartCoalesce: Object.freeze({ enabled: true, windowMs: 100 }),
  terminalWatchdog: Object.freeze({ enabled: true, checkMs: 2000, stallMs: 8000, cooldownMs: 60000 }),
})

// 阈值边界:低于下限视为非法配置回退默认,高于上限收敛(防止错误配置放大补丁行为)
export const LIMITS = Object.freeze({
  restartCoalesce: Object.freeze({ windowMs: Object.freeze({ min: 0, max: 2000 }) }),
  terminalWatchdog: Object.freeze({
    checkMs: Object.freeze({ min: 250, max: 60000 }),
    stallMs: Object.freeze({ min: 1000, max: 600000 }),
    cooldownMs: Object.freeze({ min: 1000, max: 3600000 }),
  }),
})

const isSection = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sectionOf = (value) => (isSection(value) ? value : {})

const booleanOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

// 非有限数或低于下限 = 非法, 回退默认;超过上限 = 收敛
const numberWithin = (value, bounds, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < bounds.min) return fallback
  return value > bounds.max ? bounds.max : value
}

export function normalizeConfig(raw) {
  const input = sectionOf(raw)
  const restart = sectionOf(input.restartCoalesce)
  const watchdog = sectionOf(input.terminalWatchdog)
  return {
    restartCoalesce: {
      enabled: booleanOr(restart.enabled, DEFAULT_CONFIG.restartCoalesce.enabled),
      windowMs: numberWithin(restart.windowMs, LIMITS.restartCoalesce.windowMs, DEFAULT_CONFIG.restartCoalesce.windowMs),
    },
    terminalWatchdog: {
      enabled: booleanOr(watchdog.enabled, DEFAULT_CONFIG.terminalWatchdog.enabled),
      checkMs: numberWithin(watchdog.checkMs, LIMITS.terminalWatchdog.checkMs, DEFAULT_CONFIG.terminalWatchdog.checkMs),
      stallMs: numberWithin(watchdog.stallMs, LIMITS.terminalWatchdog.stallMs, DEFAULT_CONFIG.terminalWatchdog.stallMs),
      cooldownMs: numberWithin(watchdog.cooldownMs, LIMITS.terminalWatchdog.cooldownMs, DEFAULT_CONFIG.terminalWatchdog.cooldownMs),
    },
  }
}
