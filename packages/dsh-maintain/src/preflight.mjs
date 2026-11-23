// 升级前检查:单项判定与报告聚合;磁盘/Node/状态判定保持纯函数,便于单测与复用。
import { constants as fsConstants } from 'node:fs'
import { access, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'

import { compareSemver, fetchVersionManifest, parseSemver } from './core.mjs'
import { selectInactiveSlot } from './managed-layout.mjs'
import { readManagedState, STATE_LOCK_FILE } from './managed-state.mjs'
import { findNpmCli } from './managed-upgrade.mjs'
import { scanProfilePlugins } from './plugin-compat.mjs'

export const CHECK_PASS = 'pass'
export const CHECK_WARN = 'warn'
export const CHECK_BLOCK = 'block'
export const ONLINE_UPGRADE_DISABLED = '在线插件同步升级和安全模式升级已关闭；当前只支持单独升级宿主'

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024
// 安装余量:目标包 unpackedSize 只覆盖包体,不覆盖依赖树与 npm 缓存,按整槽体积另留固定余量
const INSTALL_RESERVE_BYTES = 2 * GB
const DISK_MARGIN_RATIO = 0.2
const PREFLIGHT_MANIFEST_TIMEOUT_MS = 5 * 1000

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知'
  if (value >= GB) return (value / GB).toFixed(1) + ' GB'
  if (value >= MB) return (value / MB).toFixed(1) + ' MB'
  if (value >= KB) return (value / KB).toFixed(1) + ' KB'
  return value + ' B'
}

export function checkDiskSpace({ freeBytes, requiredBytes, marginBytes }) {
  if (![freeBytes, requiredBytes, marginBytes].every((value) => Number.isFinite(value) && value >= 0)) {
    return { status: CHECK_WARN, detail: '无法读取磁盘空间' }
  }
  const required = requiredBytes + marginBytes
  if (freeBytes < required) {
    return { status: CHECK_BLOCK, detail: '空间不足:剩余 ' + formatBytes(freeBytes) + ',需要约 ' + formatBytes(required) }
  }
  return { status: CHECK_PASS, detail: '剩余 ' + formatBytes(freeBytes) + ',需要约 ' + formatBytes(required) }
}

const GREATER_EQUAL_PATTERN = /^>=\s*(\S+)$/

export function checkNodeEngine({ currentVersion, range }) {
  if (typeof range !== 'string' || range.trim().length === 0) {
    return { status: CHECK_WARN, detail: '目标版本未声明 Node 要求' }
  }
  const match = GREATER_EQUAL_PATTERN.exec(range.trim())
  if (!match) return { status: CHECK_WARN, detail: 'Node 要求 ' + range + ' 暂不支持自动判定' }
  const current = parseSemver(currentVersion)
  const floor = parseSemver(match[1])
  if (!current || !floor) return { status: CHECK_WARN, detail: 'Node 版本无法比较: ' + currentVersion + ' / ' + range }
  if (compareSemver(currentVersion, match[1]) < 0) {
    return { status: CHECK_BLOCK, detail: '当前 Node ' + currentVersion + ',目标要求 ' + range }
  }
  return { status: CHECK_PASS, detail: '当前 Node ' + currentVersion + ' 满足 ' + range }
}

export function checkStateStatus(state) {
  if (!state || typeof state !== 'object') return { status: CHECK_PASS, detail: '无残留升级状态' }
  if (state.phase === 'indeterminate') {
    return { status: CHECK_BLOCK, detail: '上次升级状态不确定,需先核验 upgrade.lock 与安装槽' }
  }
  if (state.phase === 'awaiting-restart') {
    return { status: CHECK_WARN, detail: '存在待重启的升级记录,将在本次升级前核对' }
  }
  return { status: CHECK_PASS, detail: '上次升级状态: ' + String(state.phase ?? '未知') }
}

function normalizeCheck(check) {
  return {
    id: String(check?.id ?? 'unknown'),
    label: String(check?.label ?? check?.id ?? '未知检查'),
    status: check?.status === CHECK_BLOCK || check?.status === CHECK_WARN ? check.status : CHECK_PASS,
    detail: String(check?.detail ?? ''),
  }
}

function pluginSummary(pluginScan) {
  const plugins = Array.isArray(pluginScan?.plugins) ? pluginScan.plugins : []
  const count = (status) => plugins.filter((row) => row?.status === status).length
  return { total: plugins.length, ok: count('ok'), warn: count('warn'), block: count('block') }
}

export function buildPreflightReport({ targetVersion, checks = [], pluginScan = null, now }) {
  const scan = pluginScan && typeof pluginScan === 'object'
    ? pluginScan
    : { available: false, reason: '未执行插件扫描', plugins: [] }
  const normalized = checks.map(normalizeCheck)
  const summary = pluginSummary(scan)
  if (!normalized.some((check) => check.id === 'plugins')) {
    normalized.push({
      id: 'plugins',
      label: '插件兼容',
      status: summary.block > 0 ? CHECK_BLOCK : summary.warn > 0 ? CHECK_WARN : scan.available === false ? CHECK_WARN : CHECK_PASS,
      detail: scan.available === false
        ? '插件扫描不可用: ' + (scan.reason || '未知原因')
        : '共 ' + summary.total + ' 个插件,' + summary.warn + ' 个未验证,' + summary.block + ' 个不兼容',
    })
  }
  const counts = {
    pass: normalized.filter((check) => check.status === CHECK_PASS).length,
    warn: normalized.filter((check) => check.status === CHECK_WARN).length,
    block: normalized.filter((check) => check.status === CHECK_BLOCK).length,
  }
  const nonPluginBlock = normalized.some((check) => check.status === CHECK_BLOCK && check.id !== 'plugins')
  return {
    targetVersion,
    at: now,
    ok: counts.block === 0,
    environmentOk: !nonPluginBlock,
    okWithSafeMode: false,
    summary: counts,
    checks: normalized,
    plugins: Array.isArray(scan.plugins) ? scan.plugins : [],
    pluginSummary: summary,
    safeMode: {
      available: false,
      reason: ONLINE_UPGRADE_DISABLED,
      candidates: [],
      protected: [],
    },
  }
}

async function checkPermission(layout, accessImpl, rootExists = true) {
  try {
    if (rootExists) await accessImpl(layout.root, fsConstants.W_OK)
    await accessImpl(layout.prefix, fsConstants.W_OK)
    return { id: 'permission', label: '目录写权限', status: CHECK_PASS, detail: '安装目录可写' }
  } catch (error) {
    return { id: 'permission', label: '目录写权限', status: CHECK_BLOCK, detail: '安装目录不可写: ' + (error?.message ?? error) }
  }
}

async function checkResidualLock(layout, statImpl, id, label, file) {
  try {
    await statImpl(join(layout.root, file))
    return { id, label, status: CHECK_BLOCK, detail: file + ' 正被持有或残留，请稍后重试或核验' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { id, label, status: CHECK_PASS, detail: '无残留' + label }
    return { id, label, status: CHECK_WARN, detail: '无法检查' + label + ': ' + (error?.message ?? error) }
  }
}

// 预检汇总:环境类硬失败阻断升级;插件扫描不可用只降级为 warn,兼容旧宿主。
export async function runPreflight({
  targetVersion,
  layout,
  layoutError = null,
  runningPackage,
  profileDir,
  installAnchor,
  pluginManager,
  registryBase,
  requiredBytes = null,
  now = Date.now(),
  findNpmCliImpl = findNpmCli,
  fetchVersionManifestImpl = fetchVersionManifest,
  statfsImpl = statfs,
  accessImpl = access,
  statImpl = stat,
  readManagedStateImpl = readManagedState,
  scanPluginsImpl = scanProfilePlugins,
  selectInactiveSlotImpl = selectInactiveSlot,
} = {}) {
  const checks = []
  let layoutRootExists = false
  let layoutProbeError = null
  if (layout && !layoutError) {
    try {
      layoutRootExists = (await statImpl(layout.root)).isDirectory()
    } catch (error) {
      if (error?.code !== 'ENOENT') layoutProbeError = error?.message ?? String(error)
    }
  }
  if (layoutError) {
    checks.push({ id: 'layout', label: '安装布局', status: CHECK_BLOCK, detail: '受管安装不可用: ' + layoutError })
  } else if (!layout) {
    checks.push({ id: 'layout', label: '安装布局', status: CHECK_BLOCK, detail: '受管安装布局缺失' })
  } else if (layoutProbeError) {
    checks.push({ id: 'layout', label: '安装布局', status: CHECK_BLOCK, detail: '无法检查安装布局: ' + layoutProbeError })
  } else if (!layoutRootExists) {
    checks.push({ id: 'layout', label: '安装布局', status: CHECK_PASS, detail: '首次升级将创建受管布局' })
  } else {
    try {
      await selectInactiveSlotImpl(layout, runningPackage)
      checks.push({ id: 'layout', label: '安装布局', status: CHECK_PASS, detail: 'A/B 槽位可识别' })
    } catch (error) {
      checks.push({ id: 'layout', label: '安装布局', status: CHECK_BLOCK, detail: '安装布局异常: ' + (error?.message ?? error) })
    }
  }
  if (layout) {
    checks.push(await checkPermission(layout, accessImpl, layoutRootExists))
    checks.push(await checkResidualLock(layout, statImpl, 'lock', '升级锁', 'upgrade.lock'))
    checks.push(await checkResidualLock(layout, statImpl, 'state-lock', '状态写锁', STATE_LOCK_FILE))
    let state = null
    try {
      state = await readManagedStateImpl(layout)
    } catch (error) {
      checks.push({ id: 'state', label: '升级状态', status: CHECK_WARN, detail: '无法读取升级状态: ' + (error?.message ?? error) })
    }
    if (state !== null || !checks.some((check) => check.id === 'state')) {
      checks.push({ id: 'state', label: '升级状态', ...checkStateStatus(state) })
    }
  }
  try {
    await findNpmCliImpl()
    checks.push({ id: 'npm', label: 'npm CLI', status: CHECK_PASS, detail: 'npm CLI 可用' })
  } catch (error) {
    checks.push({ id: 'npm', label: 'npm CLI', status: CHECK_BLOCK, detail: 'npm CLI 不可用: ' + (error?.message ?? error) })
  }
  try {
    const manifest = await fetchVersionManifestImpl({ version: targetVersion, registryBase, timeoutMs: PREFLIGHT_MANIFEST_TIMEOUT_MS })
    if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) {
      requiredBytes = (Number.isFinite(manifest.unpackedSize) ? manifest.unpackedSize : 0) + INSTALL_RESERVE_BYTES
    }
    checks.push({ id: 'node', label: 'Node 版本', ...checkNodeEngine({ currentVersion: process.version.replace(/^v/, ''), range: manifest.engines?.node }) })
  } catch (error) {
    checks.push({ id: 'node', label: 'Node 版本', status: CHECK_WARN, detail: '无法读取目标版本清单: ' + (error?.message ?? error) })
  }
  if (layout) {
    if (Number.isFinite(requiredBytes) && requiredBytes > 0) {
      try {
        const fsInfo = await statfsImpl(layout.prefix)
        checks.push({ id: 'disk', label: '磁盘空间', ...checkDiskSpace({ freeBytes: fsInfo.bsize * fsInfo.bavail, requiredBytes, marginBytes: Math.ceil(requiredBytes * DISK_MARGIN_RATIO) }) })
      } catch (error) {
        checks.push({ id: 'disk', label: '磁盘空间', status: CHECK_WARN, detail: '无法读取磁盘空间: ' + (error?.message ?? error) })
      }
    } else {
      checks.push({ id: 'disk', label: '磁盘空间', status: CHECK_WARN, detail: '无法估算安装体积,跳过磁盘检查' })
    }
  }
  let pluginScan
  try {
    pluginScan = await scanPluginsImpl({ profileDir, installAnchor, targetVersion, pluginManager })
  } catch (error) {
    pluginScan = { available: false, reason: error?.message ?? String(error), plugins: [] }
  }
  return buildPreflightReport({ targetVersion, checks, pluginScan, now })
}
