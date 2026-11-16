// 受管升级状态与安全模式记录:只读写布局管理根内的状态文件,不碰运行目录。
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

export const SAFE_MODE_FILE = 'safe-mode.json'
const SAFE_MODE_MAX_ENTRIES = 100
const PLUGIN_UPGRADE_MAX_ROWS = 100
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

// state 写入串行化:健康复核与回执确认可能并发,固定 .next 临时名会互相覆盖/rename ENOENT。
let stateWriteChain = Promise.resolve()

async function writeJsonAtomicUnlocked(path, value) {
  const temp = path + '.' + process.pid + '.' + randomUUID() + '.next'
  await writeFile(temp, JSON.stringify(value, null, 2))
  await rename(temp, path)
}

function enqueueStateWrite(task) {
  const queued = stateWriteChain.then(task, task)
  stateWriteChain = queued.catch(() => {})
  return queued
}

async function writeJsonAtomic(path, value) {
  return enqueueStateWrite(() => writeJsonAtomicUnlocked(path, value))
}

export async function readManagedState(layout) {
  if (!layout?.root) return null
  return readJson(join(layout.root, 'state.json'))
}

export function normalizePluginUpgrade(value) {
  if (!value || typeof value !== 'object' || value.requested !== true) return null
  const rows = (list) => (Array.isArray(list) ? list : [])
    .filter((row) => row && typeof row.name === 'string')
    .slice(0, PLUGIN_UPGRADE_MAX_ROWS)
  return {
    requested: true,
    pending: value.pending === true,
    updated: rows(value.updated).map((row) => ({
      name: row.name,
      from: row.from ?? null,
      to: row.to ?? null,
      application: row.application ?? null,
    })),
    failed: rows(value.failed).map((row) => ({
      name: row.name,
      from: row.from ?? null,
      to: row.to ?? null,
      error: typeof row.error === 'string' ? row.error : '未知错误',
      restoreFailed: row.restoreFailed === true,
    })),
    skipped: rows(value.skipped).map((row) => ({
      name: row.name,
      reason: typeof row.reason === 'string' ? row.reason : '未说明',
    })),
    error: typeof value.error === 'string' ? value.error : null,
  }
}

// state 与当前运行版本/路径核对:落地以目标包真实运行且版本一致为准,
// 不信任 phase 自报(旧 state 可能永远停在 awaiting-restart)。
export function reconcileManagedState({ state, runningVersion, runningPackage, platform = process.platform }) {
  if (!state || typeof state !== 'object') return null
  const landed = Boolean(
    state.targetVersion
    && state.targetVersion === runningVersion
    && samePath(state.targetPackage, runningPackage, platform),
  )
  const phase = typeof state.phase === 'string' ? state.phase : 'unknown'
  const failed = phase === 'failed' || phase === 'indeterminate'
  const pending = phase === 'awaiting-restart' && !landed
  const health = normalizePluginHealth(state.health)
  const healthOk = health?.ok
  const ok = failed
    ? false
    : landed
      ? healthOk !== false
      : phase === 'degraded'
        ? healthOk === true
        : null
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
    receiptSeen: state.receiptSeen === true,
    landed,
    pending,
    failed,
    ok,
    health,
    plugins: normalizePluginUpgrade(state.plugins),
  }
}

export function summarizePluginHealth({ inventory, inventoryAvailable = true, bundleRows, bundleAvailable = true, checkedAt, unavailableReason = null }) {
  const available = inventoryAvailable === true && bundleAvailable === true
  const allEntries = Array.isArray(inventory)
    ? inventory
    : Array.isArray(inventory?.entries) ? inventory.entries : []
  const entries = allEntries.filter((row) => row && row.enabled !== false)
  const failed = entries.filter((row) => row && (row.fiberPhase === 'failed' || row.diagnostic))
  const pending = entries.filter((row) => row && (row.fiberPhase === 'pending' || row.fiberPhase === 'loading'))
  const allBundleErrors = (Array.isArray(bundleRows) ? bundleRows : [])
    .filter((row) => row && row.error && row.installed !== false && row.availability !== 'installation')
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
    ok: available ? failed.length === 0 && bundleErrors.length === 0 : null,
    available,
    unavailableReason: available ? null : unavailableReason,
    checkedAt,
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
  const ok = available
    ? health.ok === false
      ? failed.length === 0 && bundleErrors.length === 0 && hadBundleErrors
      : health.ok
    : null
  return { ...health, ok, bundleErrors }
}

export async function finalizeManagedState(layout, { phase, health, finishedAt = Date.now() }) {
  return enqueueStateWrite(async () => {
    const state = await readManagedState(layout)
    if (state === null) return null
    const elapsedMs = Number.isFinite(state.startedAt) ? Math.max(0, finishedAt - state.startedAt) : null
    const next = { ...state, phase, health, finishedAt, elapsedMs }
    await writeJsonAtomicUnlocked(join(layout.root, 'state.json'), next)
    return next
  })
}

export async function mergeManagedState(layout, patch) {
  if (!layout?.root || !patch || typeof patch !== 'object') return null
  return enqueueStateWrite(async () => {
    const state = await readManagedState(layout)
    if (state === null) return null
    const next = { ...state, ...patch }
    await writeJsonAtomicUnlocked(join(layout.root, 'state.json'), next)
    return next
  })
}

export async function markUpgradeReceiptSeen(layout, operationId) {
  if (!layout?.root || typeof operationId !== 'string' || operationId.length === 0) return null
  return enqueueStateWrite(async () => {
    const state = await readManagedState(layout)
    if (!state || state.operationId !== operationId) return null
    const next = { ...state, receiptSeen: true }
    await writeJsonAtomicUnlocked(join(layout.root, 'state.json'), next)
    return next
  })
}

export async function readSafeModeRecord(layout) {
  if (!layout?.root) return null
  const record = await readJson(join(layout.root, SAFE_MODE_FILE))
  if (!record || !Array.isArray(record.disabled)) return null
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
