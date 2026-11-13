// 宿主与客户端共享的配置事实源(客户端不能 import,内联副本由测试对表)
export const DIAG_MAX_SAMPLES = 720
const DIAG_DEFAULT_REPORT_EVERY = 12

// 配置版本:默认值语义变更时递增,读取旧版落盘配置时按它复写仍等于旧默认值的字段
export const CONFIG_VERSION = 2

// 历史版本默认值:仅用于版本迁移,字段命中才复写,用户显式改过的值保持不变
const LEGACY_DEFAULTS = Object.freeze({
  1: Object.freeze({
    stuckSession: Object.freeze({ enabled: true, checkMs: 2000, stallMs: 8000, reconnect: true, maxReconnectAttempts: 5, reconnectIntervalMs: 15000 }),
  }),
})

export const DEFAULT_CONFIG = Object.freeze({
  configVersion: CONFIG_VERSION,
  restartCoalesce: Object.freeze({ enabled: true, windowMs: 100 }),
  terminalWatchdog: Object.freeze({ enabled: true, checkMs: 2000, stallMs: 8000, cooldownMs: 60000 }),
  terminalCoalesce: Object.freeze({ enabled: true, windowMs: 8 }),
  socketKeepAlive: Object.freeze({ enabled: true, intervalMs: 1500 }),
  stuckSession: Object.freeze({ enabled: true, checkMs: 3000, stallMs: 60000, reconnect: true, maxReconnectAttempts: 2, reconnectIntervalMs: 120000 }),
  jobStreamLimit: Object.freeze({ enabled: true, base: 32, max: 48 }),
  sessionWindow: Object.freeze({ enabled: true, maxMessages: 200, minMessages: 30, minTurns: 2 }),
  listSlim: Object.freeze({ enabled: true }),
  diag: Object.freeze({ enabled: false, reportEvery: DIAG_DEFAULT_REPORT_EVERY }),
})

// 阈值边界:非有限数或低于下限回退默认,高于上限收敛;diag.reportEvery 两侧都收敛
export const LIMITS = Object.freeze({
  restartCoalesce: Object.freeze({ windowMs: Object.freeze({ min: 0, max: 2000 }) }),
  terminalWatchdog: Object.freeze({
    checkMs: Object.freeze({ min: 250, max: 60000 }),
    stallMs: Object.freeze({ min: 1000, max: 600000 }),
    cooldownMs: Object.freeze({ min: 1000, max: 3600000 }),
  }),
  terminalCoalesce: Object.freeze({ windowMs: Object.freeze({ min: 4, max: 500 }) }),
  socketKeepAlive: Object.freeze({ intervalMs: Object.freeze({ min: 500, max: 60000 }) }),
  stuckSession: Object.freeze({
    checkMs: Object.freeze({ min: 250, max: 60000 }),
    stallMs: Object.freeze({ min: 1000, max: 600000 }),
    maxReconnectAttempts: Object.freeze({ min: 1, max: 20 }),
    reconnectIntervalMs: Object.freeze({ min: 500, max: 600000 }),
  }),
  jobStreamLimit: Object.freeze({ base: Object.freeze({ min: 4, max: 256 }), max: Object.freeze({ min: 4, max: 512 }) }),
  sessionWindow: Object.freeze({
    maxMessages: Object.freeze({ min: 20, max: 500 }),
    minMessages: Object.freeze({ min: 5, max: 200 }),
    minTurns: Object.freeze({ min: 1, max: 50 }),
  }),
  diag: Object.freeze({ reportEvery: Object.freeze({ min: 1, max: DIAG_MAX_SAMPLES }) }),
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

// 非有限数回退默认;有限数两侧都收敛到边界
const numberClamped = (value, bounds, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

// 交给宿主的计数参数必须是正安全整数:小数截断后按 numberWithin 规则收敛
const integerWithin = (value, bounds, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return numberWithin(Math.trunc(value), bounds, fallback)
}

export function normalizeConfig(raw) {
  const input = sectionOf(raw)
  const restart = sectionOf(input.restartCoalesce)
  const watchdog = sectionOf(input.terminalWatchdog)
  const coalesce = sectionOf(input.terminalCoalesce)
  const keepAlive = sectionOf(input.socketKeepAlive)
  const stuck = sectionOf(input.stuckSession)
  const jobLimit = sectionOf(input.jobStreamLimit)
  const sessionWindow = sectionOf(input.sessionWindow)
  const listSlim = sectionOf(input.listSlim)
  const diag = sectionOf(input.diag)
  return {
    configVersion: CONFIG_VERSION,
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
    terminalCoalesce: {
      enabled: booleanOr(coalesce.enabled, DEFAULT_CONFIG.terminalCoalesce.enabled),
      windowMs: numberWithin(coalesce.windowMs, LIMITS.terminalCoalesce.windowMs, DEFAULT_CONFIG.terminalCoalesce.windowMs),
    },
    socketKeepAlive: {
      enabled: booleanOr(keepAlive.enabled, DEFAULT_CONFIG.socketKeepAlive.enabled),
      intervalMs: numberWithin(keepAlive.intervalMs, LIMITS.socketKeepAlive.intervalMs, DEFAULT_CONFIG.socketKeepAlive.intervalMs),
    },
    stuckSession: {
      enabled: booleanOr(stuck.enabled, DEFAULT_CONFIG.stuckSession.enabled),
      checkMs: numberWithin(stuck.checkMs, LIMITS.stuckSession.checkMs, DEFAULT_CONFIG.stuckSession.checkMs),
      stallMs: numberWithin(stuck.stallMs, LIMITS.stuckSession.stallMs, DEFAULT_CONFIG.stuckSession.stallMs),
      reconnect: booleanOr(stuck.reconnect, DEFAULT_CONFIG.stuckSession.reconnect),
      maxReconnectAttempts: numberWithin(stuck.maxReconnectAttempts, LIMITS.stuckSession.maxReconnectAttempts, DEFAULT_CONFIG.stuckSession.maxReconnectAttempts),
      reconnectIntervalMs: numberWithin(stuck.reconnectIntervalMs, LIMITS.stuckSession.reconnectIntervalMs, DEFAULT_CONFIG.stuckSession.reconnectIntervalMs),
    },
    jobStreamLimit: {
      enabled: booleanOr(jobLimit.enabled, DEFAULT_CONFIG.jobStreamLimit.enabled),
      base: Math.min(
        numberWithin(jobLimit.base, LIMITS.jobStreamLimit.base, DEFAULT_CONFIG.jobStreamLimit.base),
        numberWithin(jobLimit.max, LIMITS.jobStreamLimit.max, DEFAULT_CONFIG.jobStreamLimit.max),
      ),
      max: numberWithin(jobLimit.max, LIMITS.jobStreamLimit.max, DEFAULT_CONFIG.jobStreamLimit.max),
    },
    sessionWindow: {
      enabled: booleanOr(sessionWindow.enabled, DEFAULT_CONFIG.sessionWindow.enabled),
      maxMessages: integerWithin(sessionWindow.maxMessages, LIMITS.sessionWindow.maxMessages, DEFAULT_CONFIG.sessionWindow.maxMessages),
      minMessages: integerWithin(sessionWindow.minMessages, LIMITS.sessionWindow.minMessages, DEFAULT_CONFIG.sessionWindow.minMessages),
      minTurns: integerWithin(sessionWindow.minTurns, LIMITS.sessionWindow.minTurns, DEFAULT_CONFIG.sessionWindow.minTurns),
    },
    listSlim: {
      enabled: booleanOr(listSlim.enabled, DEFAULT_CONFIG.listSlim.enabled),
    },
    diag: {
      enabled: booleanOr(diag.enabled, DEFAULT_CONFIG.diag.enabled),
      reportEvery: numberClamped(diag.reportEvery, LIMITS.diag.reportEvery, DEFAULT_CONFIG.diag.reportEvery),
    },
  }
}

const upgradeSection = (section, legacy, current) => {
  if (!isSection(section)) return section
  const next = { ...section }
  for (const [key, legacyValue] of Object.entries(legacy)) {
    if (next[key] === legacyValue) next[key] = current[key]
  }
  return next
}

// 读取时按版本逐级迁移:旧版落盘配置里仍等于旧默认值的字段复写为当前默认值
export function migrateConfig(raw) {
  const input = sectionOf(raw)
  const version = Number.isInteger(input.configVersion) ? input.configVersion : 0
  if (version >= CONFIG_VERSION) return normalizeConfig(input)
  const migrated = { ...input, configVersion: CONFIG_VERSION }
  for (let from = Math.max(version, 1); from < CONFIG_VERSION; from += 1) {
    const legacy = LEGACY_DEFAULTS[from]
    if (legacy === undefined) continue
    for (const [section, values] of Object.entries(legacy)) {
      migrated[section] = upgradeSection(migrated[section], values, DEFAULT_CONFIG[section])
    }
  }
  return normalizeConfig(migrated)
}
