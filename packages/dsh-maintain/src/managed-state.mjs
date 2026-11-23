// 受管升级状态与安全模式记录:只读写布局管理根内的状态文件,不碰运行目录。
import { open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

export const SAFE_MODE_FILE = 'safe-mode.json'
export const STATE_LOCK_FILE = 'state.json.lock'
const SAFE_MODE_MAX_ENTRIES = 100
const PLUGIN_UPGRADE_MAX_ROWS = 100
const FAILED_UPGRADE_PHASES = new Set(['failed', 'indeterminate', 'rolled-back'])
const SUCCESSFUL_UPGRADE_PHASES = new Set(['healthy', 'succeeded'])
const LANDING_RECHECK_PHASES = new Set(['awaiting-restart', 'landed', 'healthy', 'degraded'])
const FINISHED_PLUGIN_STATES = new Set(['updated', 'verified', 'skipped'])
// 这两类不是当前宿主上的装载失败:not-bundle 是未声明 bundle 的普通依赖,
// unsupported-platform 是插件明确不支持当前平台(插件管理器自身也不默认展示)。
const IGNORED_BUNDLE_ERROR_CODES = new Set(['not-bundle', 'unsupported-platform'])

function bundleErrorCode(error) {
  return typeof error === 'string' ? error : error?.code
}

export function isIgnoredBundleError(error) {
  return IGNORED_BUNDLE_ERROR_CODES.has(bundleErrorCode(error))
}

function samePath(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const STATE_LOCK_WAIT_MS = 2 * 1000
const STATE_LOCK_RETRY_MS = 25
const stateWrites = globalThis[Symbol.for('@mzzsfy/dsh-maintain.state-writes')] ??= { pending: Promise.resolve() }

export async function managedProfileId(profileDir) {
  if (typeof profileDir !== 'string' || !isAbsolute(profileDir)) return null
  try {
    return await realpath(profileDir)
  } catch {
    return null
  }
}

async function writeJsonAtomicUnlocked(path, value) {
  const temp = path + '.' + process.pid + '.' + randomUUID() + '.next'
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

async function withStateLock(layout, task) {
  const path = join(layout.root, STATE_LOCK_FILE)
  const deadline = performance.now() + STATE_LOCK_WAIT_MS
  let handle
  while (!handle) {
    try {
      handle = await open(path, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (performance.now() >= deadline) {
        throw Object.assign(new Error('受管状态写锁仍被占用，请核验后重试'), { code: 'STATE_LOCK_BUSY' })
      }
      await delay(STATE_LOCK_RETRY_MS)
    }
  }
  let taskError
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    return await task()
  } catch (error) {
    taskError = error
    throw error
  } finally {
    try {
      await handle.close()
      await rm(path)
    } catch (error) {
      const failure = taskError ? new AggregateError([taskError, error], taskError.message) : error
      throw Object.assign(failure, { stateLockReleaseFailed: true })
    }
  }
}

function enqueueStateWrite(task) {
  const queued = stateWrites.pending.then(task)
  stateWrites.pending = queued.catch(() => {})
  return queued
}

export function drainManagedStateWrites() {
  return stateWrites.pending
}

async function writeJsonAtomic(path, value) {
  return enqueueStateWrite(() => writeJsonAtomicUnlocked(path, value))
}

export async function readManagedState(layout) {
  if (!layout?.root) return null
  return readJson(join(layout.root, 'state.json'))
}

export async function saveManagedState(layout, state) {
  return enqueueStateWrite(() => withStateLock(layout, () => writeJsonAtomicUnlocked(join(layout.root, 'state.json'), state)))
}

function ownsOperation(state, profileId) {
  return typeof profileId === 'string' && profileId.length > 0 && state?.profileId === profileId
}

function isFailedPluginUpgrade(item) {
  return item?.restoreFailed === true || item?.state === 'failed' || item?.state === 'not-run' || item?.state === 'rolled-back'
}

export function hasPluginUpgradeFailure(plugins) {
  return plugins?.notRun === true
    || plugins?.failed === true
    || (typeof plugins?.error === 'string' && plugins.error.length > 0)
    || (Array.isArray(plugins?.items) && plugins.items.some(isFailedPluginUpgrade))
}

// 历史数组只在读取时转为逐项明细，保留执行结果和明确未执行的意图。
export function normalizePluginUpgrade(value, { stopped = false } = {}) {
  if (!value || typeof value !== 'object' || value.requested !== true) return null
  const legacyRows = (list, state) => (Array.isArray(list) ? list : [])
    .map((row) => (row && typeof row === 'object' ? { ...row, state } : row))
  const rawItems = Array.isArray(value.items)
    ? value.items
    : [
        ...legacyRows(value.updated, 'updated'),
        ...legacyRows(value.failed, 'failed'),
        ...legacyRows(value.skipped, 'skipped'),
      ]
  const legacyPending = value.pending === true && !Array.isArray(value.items)
  const notRun = legacyPending || value.notRun === true
  const rows = rawItems.filter((row) => row && typeof row.name === 'string')
  const normalizedRows = rows.map((row) => {
    const recordedState = typeof row.state === 'string' ? row.state : 'pending'
    const waiting = recordedState === 'pending' || recordedState === 'checking' || recordedState === 'planned'
    return {
      name: row.name,
      state: (stopped || notRun) && waiting ? 'not-run' : recordedState,
      from: row.from ?? null,
      to: row.to ?? null,
      application: row.application ?? null,
      error: typeof row.error === 'string' ? row.error : row.state === 'failed' ? '未知错误' : null,
      reason: typeof row.reason === 'string' ? row.reason : null,
      restoreFailed: row.restoreFailed === true,
    }
  })
  const failures = normalizedRows.filter(isFailedPluginUpgrade)
  let nonFailureSlots = Math.max(0, PLUGIN_UPGRADE_MAX_ROWS - failures.length)
  // 在展示上限内优先保留诊断，入选的行仍按原顺序展示。
  const items = normalizedRows.filter((row) => {
    if (isFailedPluginUpgrade(row)) return true
    if (nonFailureSlots === 0) return false
    nonFailureSlots -= 1
    return true
  }).slice(0, PLUGIN_UPGRADE_MAX_ROWS)
  const total = Number.isInteger(value.total) && value.total >= rows.length ? value.total : rows.length
  const retryMessage = '旧版本遗留的插件升级意图未执行。如仍需更新插件，请另行安排'
  const recordedError = typeof value.error === 'string' && value.error ? value.error : null
  const error = legacyPending ? [recordedError, retryMessage].filter(Boolean).join('；') : recordedError
  return {
    requested: true,
    total,
    items,
    notRun,
    failed: hasPluginUpgradeFailure({ notRun, error, failed: value.failed, items: failures }),
    incomplete: total > rows.length || normalizedRows.some((row) => !FINISHED_PLUGIN_STATES.has(row.state) && !isFailedPluginUpgrade(row)),
    omitted: total - items.length,
    error,
  }
}

function hasFailedHostUpgrade(phase, health) {
  return FAILED_UPGRADE_PHASES.has(phase)
    || ((LANDING_RECHECK_PHASES.has(phase) || SUCCESSFUL_UPGRADE_PHASES.has(phase)) && health?.ok === false)
}

function legacyReceiptResult(phase) {
  if (FAILED_UPGRADE_PHASES.has(phase)) return 'failed'
  if (SUCCESSFUL_UPGRADE_PHASES.has(phase)) return 'succeeded'
  return null
}

// 目标包已运行并不证明升级成功，仍需独立确认操作与健康结果。
export function reconcileManagedState({ state, runningVersion, runningPackage, bootId, profileId, platform = process.platform }) {
  if (!state || typeof state !== 'object') return null
  const owned = ownsOperation(state, profileId)
  if (profileId !== undefined && state.profileId != null && !owned) return null
  const unownedHistory = profileId !== undefined && !owned
  const landed = !unownedHistory && Boolean(
    state.targetVersion
    && state.targetVersion === runningVersion
    && samePath(state.targetPackage, runningPackage, platform),
  )
  const phase = typeof state.phase === 'string' ? state.phase : 'unknown'
  const pending = !unownedHistory && phase === 'awaiting-restart' && !landed
  const recordedHealth = normalizePluginHealth(state.health)
  const health = unownedHistory ? null : recordedHealth
  const hostFailed = hasFailedHostUpgrade(phase, recordedHealth)
  const plugins = normalizePluginUpgrade(state.plugins, { stopped: hostFailed })
  const failed = hostFailed || hasPluginUpgradeFailure(plugins)
  const currentHealth = bootId === undefined || health?.bootId === bootId
  const confirmed = SUCCESSFUL_UPGRADE_PHASES.has(phase) && landed && currentHealth && health?.ok === true && !plugins?.incomplete
  const ok = failed ? false : confirmed ? true : null
  const result = ok === true ? 'succeeded' : ok === false ? 'failed' : null
  const receiptResult = state.receiptSeen === true ? state.receiptResult ?? legacyReceiptResult(phase) : null
  const elapsedMs = Number.isFinite(state.elapsedMs)
    ? Math.max(0, state.elapsedMs)
    : Number.isFinite(state.startedAt) && Number.isFinite(state.finishedAt)
      ? Math.max(0, state.finishedAt - state.startedAt)
      : null
  return {
    operationId: state.operationId ?? null,
    phase,
    targetVersion: state.targetVersion ?? null,
    previousVersion: state.previousVersion ?? null,
    slot: state.slot ?? null,
    startedAt: state.startedAt ?? null,
    switchedAt: state.switchedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    elapsedMs,
    error: state.error ?? null,
    receiptSeen: !unownedHistory && result !== null && receiptResult === result,
    receiptResult: unownedHistory ? null : receiptResult,
    receiptLocalOnly: unownedHistory && failed,
    landed,
    pending,
    failed,
    ok,
    health,
    plugins,
  }
}

function isFiberTransition(row) {
  return row?.fiberPhase === 'loading' || row?.fiberPhase === 'unloading'
}

export function summarizePluginHealth({ inventory, inventoryAvailable = true, bundleRows, bundleAvailable = true, checkedAt, bootId, unavailableReason = null }) {
  const available = inventoryAvailable === true && bundleAvailable === true
  const allEntries = Array.isArray(inventory)
    ? inventory
    : Array.isArray(inventory?.entries) ? inventory.entries : []
  const entries = allEntries.filter((row) => row && row.enabled !== false)
  const failed = entries.filter((row) => row && (row.fiberPhase === 'failed' || row.diagnostic))
  // 无诊断的 pending 也用于依赖门控，有意等待只展示；加载和卸载期间尚不能确认健康。
  const pending = entries.filter((row) => row.fiberPhase === 'pending' || isFiberTransition(row))
  const allBundleErrors = (Array.isArray(bundleRows) ? bundleRows : [])
    .filter((row) => row && row.error && row.enabled !== false && row.installed !== false && row.availability !== 'installation')
  const ignoredBundleErrors = allBundleErrors
    .filter((row) => isIgnoredBundleError(row.error))
    .map((row) => ({ name: row.name, error: typeof row.error === 'string' ? row.error : row.error.diagnostic ?? row.error.code ?? '未知错误' }))
  const bundleErrors = allBundleErrors
    .filter((row) => !isIgnoredBundleError(row.error))
    .map((row) => ({
      name: row.name,
      error: typeof row.error === 'string'
        ? row.error
        : row.error.diagnostic ?? row.error.code ?? row.error.message ?? '未知错误',
    }))
  return {
    ok: failed.length > 0 || bundleErrors.length > 0 ? false : available && !pending.some(isFiberTransition) ? true : null,
    available,
    unavailableReason: available ? null : unavailableReason,
    checkedAt,
    bootId,
    pluginCount: entries.length,
    activeCount: entries.filter((row) => row && row.fiberPhase === 'active').length,
    failed: failed.map((row) => ({ entryId: row.entryId ?? null, moduleName: row.moduleName ?? null, fiberPhase: row.fiberPhase ?? null, diagnostic: row.diagnostic ?? null })),
    pending: pending.map((row) => ({ entryId: row.entryId ?? null, moduleName: row.moduleName ?? null, fiberPhase: row.fiberPhase ?? null })),
    bundleErrors,
    ignoredBundleErrors,
  }
}

// 旧 state 可能已把平台不支持插件写入安装错误:展示前按当前口径重算,不篡改磁盘历史。
export function normalizePluginHealth(health) {
  if (!health || typeof health !== 'object') return health
  const bundleErrors = Array.isArray(health.bundleErrors)
    ? health.bundleErrors.filter((row) => !isIgnoredBundleError(row.error))
    : []
  const hadBundleErrors = Array.isArray(health.bundleErrors) && health.bundleErrors.length > 0
  const failed = Array.isArray(health.failed) ? health.failed : []
  const available = health.available !== false
  const transitioning = Array.isArray(health.pending) && health.pending.some(isFiberTransition)
  const failure = failed.length > 0 || bundleErrors.length > 0 || (health.ok === false && !hadBundleErrors)
  const confirmed = health.ok === true || (health.ok === false && hadBundleErrors)
  const ok = failure ? false : available && confirmed && !transitioning ? true : null
  return { ...health, ok, bundleErrors }
}

export async function finalizeManagedState(layout, { operationId, profileId, runningVersion, runningPackage, phase, health, finishedAt = Date.now() }) {
  return enqueueStateWrite(() => withStateLock(layout, async () => {
    const state = await readManagedState(layout)
    if (!ownsOperation(state, profileId) || state.operationId !== operationId || !LANDING_RECHECK_PHASES.has(state.phase)) return null
    const current = reconcileManagedState({ state, profileId, runningVersion, runningPackage })
    if (!current.landed || current.failed) return null
    const elapsedMs = Number.isFinite(state.startedAt) ? Math.max(0, finishedAt - state.startedAt) : null
    const next = { ...state, phase, health, finishedAt, elapsedMs }
    if (state.receiptSeen === true) {
      const priorReceipt = state.receiptResult ?? legacyReceiptResult(state.phase)
      const failedNow = hasFailedHostUpgrade(phase, normalizePluginHealth(health))
      next.receiptSeen = priorReceipt !== null && !(priorReceipt === 'succeeded' && failedNow)
      next.receiptResult = next.receiptSeen ? priorReceipt : null
    }
    await writeJsonAtomicUnlocked(join(layout.root, 'state.json'), next)
    return next
  }))
}

export async function markUpgradeReceiptSeen(layout, operationId, { runningVersion, runningPackage, profileId, bootId, expectedOk } = {}) {
  if (!layout?.root || typeof operationId !== 'string' || operationId.length === 0 || typeof expectedOk !== 'boolean') return null
  return enqueueStateWrite(() => withStateLock(layout, async () => {
    const state = await readManagedState(layout)
    if (!ownsOperation(state, profileId) || state.operationId !== operationId) return null
    const result = reconcileManagedState({ state, runningVersion, runningPackage, profileId, bootId })
    if (result.ok !== expectedOk) return null
    const next = { ...state, receiptSeen: true, receiptResult: expectedOk ? 'succeeded' : 'failed' }
    await writeJsonAtomicUnlocked(join(layout.root, 'state.json'), next)
    return next
  }))
}

export async function readSafeModeRecord(layout, { profileId } = {}) {
  if (!layout?.root) return null
  const record = await readJson(join(layout.root, SAFE_MODE_FILE))
  if (!record || !Array.isArray(record.disabled)) return null
  if (profileId !== undefined && !ownsOperation(record, profileId)) return null
  const disabled = record.disabled
    .filter((row) => row && typeof row.name === 'string')
    .slice(0, SAFE_MODE_MAX_ENTRIES)
  if (disabled.length === 0) return null
  return { ...record, disabled }
}

export async function writeSafeModeRecord(layout, record) {
  await writeJsonAtomic(join(layout.root, SAFE_MODE_FILE), record)
}

export async function clearSafeModeRecord(layout) {
  if (!layout?.root) return
  await rm(join(layout.root, SAFE_MODE_FILE), { force: true })
}
