// 宿主升级时的插件同步升级:只处理 profile 内可更新的 registry 组合包。
// 单个插件失败不阻断宿主升级,结果逐项回传给面板;不兼容/无新版本/Git 插件明确跳过。

import { gtSemver, parseSemver } from './core.mjs'
import { MAINTAIN_BUNDLE } from './plugin-compat.mjs'

// 状态接口协议标记:只有新宿主(切换后执行插件升级)才暴露该值,
// 防止旧宿主仍按旧语义在切换前装插件时被 UI 误认为可用。
export const PLUGIN_UPGRADE_MODE = 'post-restart'

const FAILED_APPLICATIONS = new Set(['failed', 'cancelled'])
const NON_APPLIED_APPLICATIONS = new Set(['failed', 'cancelled', 'overridden'])

function errorText(error) {
  if (error && typeof error === 'object') return error.message || error.code || String(error)
  return String(error)
}

function managementErrorText(error) {
  if (!error) return '未知错误'
  return error.diagnostic || error.code || error.message || String(error)
}

function updateOptions(registry) {
  return typeof registry === 'string' && registry.length > 0 ? { registry } : undefined
}

// 版本列表按新到旧排列;优先稳定版,跳过已弃用/不兼容/非组合包版本。
// 只接受严格高于已装版本的候选:插件升级是单向的,任何情况下都不降级。
// 兼容性由调用时机决定:宿主升级完成后在新宿主上调用,才能按目标版本判断。
export function choosePluginVersion(versions, installedVersion) {
  if (!Array.isArray(versions) || !parseSemver(installedVersion)) return null
  const candidates = versions.filter((row) => row
    && typeof row.version === 'string'
    && gtSemver(row.version, installedVersion)
    && row.bundle !== false
    && row.deprecated === undefined
    && row.incompatible === undefined)
  return candidates.find((row) => row.prerelease !== true) || candidates[0] || null
}

export function supportsPluginUpgrade(pluginManager) {
  return Boolean(pluginManager
    && typeof pluginManager.listBundles === 'function'
    && typeof pluginManager.listVersions === 'function'
    && typeof pluginManager.updateBundle === 'function')
}

export async function upgradeProfilePlugins({
  pluginManager,
  registryBase,
  excludeNames = [MAINTAIN_BUNDLE],
  onOutput = () => {},
} = {}) {
  if (!supportsPluginUpgrade(pluginManager)) {
    throw new Error('pluginManager 不支持 listBundles/listVersions/updateBundle')
  }
  const excluded = new Set(excludeNames.filter((name) => typeof name === 'string'))
  const bundles = await pluginManager.listBundles()
  if (!Array.isArray(bundles)) throw new Error('pluginManager.listBundles 返回形状无法识别')

  const result = { requested: true, updated: [], failed: [], skipped: [], error: null }
  for (const bundle of bundles) {
    if (!bundle || typeof bundle.name !== 'string' || bundle.installed !== true) continue
    if (excluded.has(bundle.name)) {
      result.skipped.push({ name: bundle.name, reason: 'maintain 自身不参与同步升级' })
      continue
    }
    if (bundle.update === 'git') {
      result.skipped.push({ name: bundle.name, reason: 'Git 插件没有版本列表,跳过' })
      continue
    }
    if (bundle.update !== 'registry') continue
    const from = bundle.version ?? null
    try {
      onOutput('检查插件 ' + bundle.name + (from ? ' ' + from : '') + '\n')
      const versions = await pluginManager.listVersions(bundle.name, updateOptions(registryBase))
      if (!versions || versions.status !== 'listed') {
        result.skipped.push({
          name: bundle.name,
          reason: (versions && (versions.reason || versions.problem)) || '版本列表不可用',
        })
        continue
      }
      const listedInstalled = versions.installed ?? null
      const installed = parseSemver(listedInstalled)
        && (!parseSemver(from) || gtSemver(listedInstalled, from))
        ? listedInstalled
        : from
      const target = choosePluginVersion(versions.versions, installed)
      if (target === null) {
        result.skipped.push({ name: bundle.name, reason: '没有严格高于已装版本的兼容版本' })
        continue
      }
      onOutput('升级插件 ' + bundle.name + ': ' + (installed || '未知') + ' -> ' + target.version + '\n')
      const update = await pluginManager.updateBundle(bundle.name, target.version, updateOptions(versions.registry || registryBase))
      const change = update && update.result
      if (!change || NON_APPLIED_APPLICATIONS.has(change.application)) {
        const restoreFailed = update && update.restore && FAILED_APPLICATIONS.has(update.restore.application)
        result.failed.push({
          name: bundle.name,
          from: installed,
          to: target.version,
          error: managementErrorText(change && change.error) + (restoreFailed ? ';恢复旧版本失败' : ''),
          restoreFailed,
        })
        onOutput('插件升级失败 ' + bundle.name + ': ' + result.failed[result.failed.length - 1].error + '\n')
        continue
      }
      result.updated.push({
        name: bundle.name,
        from: installed,
        to: target.version,
        application: change.application,
      })
      onOutput('插件升级完成 ' + bundle.name + ' -> ' + target.version + '\n')
    } catch (error) {
      result.failed.push({ name: bundle.name, from, to: null, error: errorText(error), restoreFailed: false })
      onOutput('插件升级异常 ' + bundle.name + ': ' + errorText(error) + '\n')
    }
  }
  return result
}
