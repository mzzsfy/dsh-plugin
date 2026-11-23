// 插件兼容判定与安全模式候选:纯判定与 profile 读取分层,宿主能力经注入,便于单测。
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

const HOST_COMPAT_PACKAGE = '@deepseek-ai/dsh-app-boot'
const CANDIDATE_SCAN_TIMEOUT_MS = 60 * 1000

export const MAINTAIN_BUNDLE = '@mzzsfy/dsh-maintain'

// 默认只保护三个关键插件:maintain 自身、宿主信任闸门与启动认证。
// 其余插件(含 tunnel)允许安全模式临时禁用;白名单仍可按精确包名追加保护。
const SAFE_MODE_PROTECTED_NAMES = new Set([
  MAINTAIN_BUNDLE,
  '@mzzsfy/dsh-auto-trust-all',
  'dsh-web-startup-auth',
])
export const SAFE_MODE_WHITELIST_MAX = 100

export function normalizeSafeModeWhitelist(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : []
  const seen = new Set()
  const names = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= SAFE_MODE_WHITELIST_MAX) break
  }
  return names
}

export function isSafeModeProtectedPlugin(name, whitelist = []) {
  return typeof name === 'string'
    && (SAFE_MODE_PROTECTED_NAMES.has(name) || normalizeSafeModeWhitelist(whitelist).includes(name))
}

export const PLUGIN_OK = 'ok'
export const PLUGIN_WARN = 'warn'
export const PLUGIN_BLOCK = 'block'

const DECLARED_COMPATIBLE = 'compatible'
const DECLARED_UNKNOWN = 'unknown'

function compatibilityMatrix(manifest) {
  const releases = manifest?.dsh?.compatibility?.dshReleases
  return releases && typeof releases === 'object' ? releases : null
}

function requirementSummary(requirements) {
  return Object.entries(requirements).map(([name, range]) => name + ' ' + range).join(', ')
}

// 单插件判定:宿主 evaluatePluginCompatibility 优先(engines.dsh / dsh peer),
// 仓库自定义 dshReleases 矩阵只作补充标注,两者冲突时以宿主判定为准。
export function classifyPluginCompatibility({ manifest, targetVersion, evaluator, exemptions = {} }) {
  const issue = typeof evaluator === 'function' ? evaluator(manifest, exemptions, targetVersion) : undefined
  if (issue && issue.exempted !== true) {
    return { status: PLUGIN_BLOCK, reasons: ['宿主版本要求不满足: ' + requirementSummary(issue.requirements)] }
  }
  if (issue && issue.exempted === true) {
    return { status: PLUGIN_WARN, reasons: ['宿主版本要求不满足但已豁免: ' + requirementSummary(issue.requirements)] }
  }
  const matrix = compatibilityMatrix(manifest)
  if (matrix === null) return { status: PLUGIN_WARN, reasons: ['未声明 dsh 兼容版本'] }
  if (!Object.prototype.hasOwnProperty.call(matrix, targetVersion)) {
    return { status: PLUGIN_WARN, reasons: ['未声明目标版本 ' + targetVersion + ' 的兼容性'] }
  }
  if (matrix[targetVersion] === DECLARED_COMPATIBLE) return { status: PLUGIN_OK, reasons: [] }
  if (matrix[targetVersion] === DECLARED_UNKNOWN) return { status: PLUGIN_WARN, reasons: ['仓库兼容矩阵标记为未验证'] }
  return { status: PLUGIN_WARN, reasons: ['仓库兼容矩阵取值未知: ' + String(matrix[targetVersion])] }
}

// 宿主安装树内的兼容判定 API:profile 的 node_modules 不含 app-boot,必须从 installAnchor 解析。
export function loadHostCompatibilityApi(installAnchor, candidateSlot) {
  try {
    if (!installAnchor) return null
    const requireFromHost = createRequire(installAnchor)
    const entry = requireFromHost.resolve(HOST_COMPAT_PACKAGE)
    if (candidateSlot) {
      const pathInSlot = relative(realpathSync(candidateSlot), realpathSync(entry))
      if (isAbsolute(pathInSlot) || pathInSlot === '..' || pathInSlot.startsWith('..' + sep)) return null
    }
    const api = requireFromHost(entry)
    if (typeof api.evaluatePluginCompatibility !== 'function' || typeof api.readProfileVersionExemptions !== 'function') return null
    return {
      evaluate: api.evaluatePluginCompatibility,
      readExemptions: api.readProfileVersionExemptions,
    }
  } catch {
    return null
  }
}

function unavailable(reason) {
  return { available: false, safeModeAvailable: false, reason, plugins: [], safeModeCandidates: [], protectedPlugins: [] }
}

async function readManifest(profileDir, name, readFileImpl) {
  const path = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  return JSON.parse(await readFileImpl(path, 'utf8'))
}

// 新 Worker 不复用上一次候选的模块缓存;只传复检需要的清单字段。
export async function scanCandidatePlugins({ profileDir, installAnchor, targetVersion, pluginManager, safeModeWhitelist, candidateSlot }) {
  if (!candidateSlot) return unavailable('缺少候选安装槽')
  let rows
  try {
    rows = await pluginManager.listBundles()
  } catch (error) {
    return unavailable('读取插件清单失败: ' + (error?.message ?? error))
  }
  if (!Array.isArray(rows)) return unavailable('插件清单不是数组')
  const plugins = rows.filter((row) => row && typeof row.name === 'string').map((row) => ({
    name: row.name,
    version: row.version,
    enabled: row.enabled,
    installed: row.installed,
    official: row.official,
    availability: row.availability,
    error: row.error?.code ?? String(row.error ?? ''),
    readOnlyReason: row.readOnlyReason,
  }))
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./candidate-plugin-scan.mjs', import.meta.url), {
      workerData: { profileDir, installAnchor, targetVersion, safeModeWhitelist, candidateSlot, plugins },
      execArgv: [],
      env: {},
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
      void worker.terminate()
    }
    const timer = setTimeout(() => finish(unavailable('目标宿主插件复检超时')), CANDIDATE_SCAN_TIMEOUT_MS)
    worker.once('message', finish)
    worker.once('error', (error) => finish(unavailable('目标宿主插件复检失败: ' + error.message)))
    worker.once('exit', (code) => finish(unavailable('目标宿主插件复检未返回结果: ' + code)))
  })
}

// profile 插件扫描:pluginManager 提供启用/安装/只读状态与禁用能力;缺失即降级不可用。
export async function scanProfilePlugins({
  profileDir,
  installAnchor,
  targetVersion,
  pluginManager,
  safeModeWhitelist = [],
  strict = false,
  loadEvaluator = loadHostCompatibilityApi,
  readFileImpl = readFile,
} = {}) {
  if (!profileDir) return unavailable('缺少 profile 目录')
  if (!pluginManager || typeof pluginManager.listBundles !== 'function') return unavailable('pluginManager 不可用')
  let rows
  try {
    rows = await pluginManager.listBundles()
  } catch (error) {
    return unavailable('读取插件清单失败: ' + (error && error.message ? error.message : String(error)))
  }
  if (!Array.isArray(rows)) return unavailable('插件清单不是数组')
  let api
  try {
    api = loadEvaluator(installAnchor)
  } catch (error) {
    if (strict) return unavailable('加载宿主兼容判定 API 失败: ' + (error?.message ?? error))
    throw error
  }
  if (strict && (!api || typeof api.evaluate !== 'function' || typeof api.readExemptions !== 'function')) {
    return unavailable('宿主兼容判定 API 不可用: evaluate/readExemptions 缺失或不可调用')
  }
  let exemptions = {}
  try { if (api) exemptions = await api.readExemptions(profileDir) } catch (error) {
    if (strict) return unavailable('读取插件版本豁免失败: ' + (error?.message ?? error))
  }
  const plugins = []
  for (const row of rows) {
    if (!row || typeof row.name !== 'string') continue
    if (row.official === true || row.availability === 'installation') continue
    if (row.enabled !== true || row.installed !== true) continue
    if (row.error && (row.error.code === 'not-bundle' || String(row.error) === 'not-bundle')) continue
    const whitelistedPlugin = normalizeSafeModeWhitelist(safeModeWhitelist).includes(row.name)
    const protectedPlugin = isSafeModeProtectedPlugin(row.name, safeModeWhitelist)
    const protectedReason = protectedPlugin
      ? [whitelistedPlugin ? '安全模式白名单插件,不自动禁用' : '默认保护插件,安全模式不自动禁用']
      : []
    let manifest
    try {
      manifest = await readManifest(profileDir, row.name, readFileImpl)
    } catch (error) {
      if (strict) return unavailable('插件 ' + row.name + ' manifest 读取失败: ' + (error?.message ?? error))
      plugins.push({
        name: row.name,
        version: row.version ?? null,
        status: PLUGIN_WARN,
        reasons: ['读取插件清单失败: ' + (error && error.message ? error.message : String(error)), ...protectedReason],
        safeModeProtected: protectedPlugin,
        safeModeWhitelisted: whitelistedPlugin,
        safeModeCandidate: !protectedPlugin
          && row.readOnlyReason === undefined
          && row.name !== MAINTAIN_BUNDLE
          && (row.availability === undefined || row.availability === 'profile'),
      })
      continue
    }
    let classified
    try {
      classified = classifyPluginCompatibility({
        manifest,
        targetVersion,
        evaluator: api ? api.evaluate : undefined,
        exemptions,
      })
    } catch (error) {
      if (strict) return unavailable('插件 ' + row.name + ' 兼容判定失败: ' + (error?.message ?? error))
      classified = { status: PLUGIN_WARN, reasons: ['兼容判定失败: ' + (error?.message ?? error)] }
    }
    plugins.push({
      name: row.name,
      version: row.version ?? manifest.version ?? null,
      status: classified.status,
      reasons: [...classified.reasons, ...protectedReason],
      safeModeProtected: protectedPlugin,
      safeModeWhitelisted: whitelistedPlugin,
      safeModeCandidate: classified.status !== PLUGIN_OK
        && !protectedPlugin
        && row.readOnlyReason === undefined
        && row.name !== MAINTAIN_BUNDLE
        && (row.availability === undefined || row.availability === 'profile'),
    })
  }
  return {
    available: true,
    safeModeAvailable: typeof pluginManager.setBundleEnabled === 'function',
    reason: null,
    plugins,
    safeModeCandidates: plugins.filter((row) => row.safeModeCandidate),
    protectedPlugins: plugins.filter((row) => row.safeModeProtected && row.name !== MAINTAIN_BUNDLE),
  }
}
