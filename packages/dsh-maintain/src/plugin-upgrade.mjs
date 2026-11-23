// 宿主升级时的插件同步升级:只处理 profile 内可更新的 registry 组合包。
// 单个插件失败不阻断后续插件;失败由编排层决定是否阻止切换槽位。
// 不兼容/无新版本/Git 插件明确跳过。

import { randomUUID } from 'node:crypto'

import { gtSemver, parseSemver } from './core.mjs'
import { MAINTAIN_BUNDLE } from './plugin-compat.mjs'

// 状态接口协议标记:只有会把插件升级前置到切槽前的宿主才暴露该值,
// 防止旧宿主(切槽后才升级插件)被 UI 误认为具备前置门控能力。
export const PLUGIN_UPGRADE_MODE = 'pre-switch'

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
// incompatible 由宿主按 running 版本判定,当前宿主拒绝的目标版本在这里就被跳过。
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

// 可升级对象:已装、registry 来源、非 maintain 自身;Git 与官方内置不进清单。
function selectUpgradableBundles(bundles, excluded) {
  const rows = []
  for (const bundle of bundles) {
    if (!bundle || typeof bundle.name !== 'string' || bundle.installed !== true) continue
    if (excluded.has(bundle.name)) continue
    if (bundle.update !== 'registry') continue
    rows.push({ name: bundle.name, from: bundle.version ?? null, state: 'pending' })
  }
  return rows
}

function patchItem(items, index, patch) {
  const next = items.slice()
  next[index] = { ...next[index], ...patch }
  return next
}

// onItem 事件:
//   { kind: 'snapshot', items }                      总清单(开始时与每次变化后)
//   { kind: 'step', name, index, total, requestId }  交给宿主 updateBundle,进度事件按 requestId 归属
export async function upgradeProfilePlugins({
  pluginManager,
  registryBase,
  excludeNames = [MAINTAIN_BUNDLE],
  newRequestId = randomUUID,
  onOutput = () => {},
  onItem = () => {},
} = {}) {
  if (!supportsPluginUpgrade(pluginManager)) {
    throw new Error('pluginManager 不支持 listBundles/listVersions/updateBundle')
  }
  const excluded = new Set(excludeNames.filter((name) => typeof name === 'string'))
  const bundles = await pluginManager.listBundles()
  if (!Array.isArray(bundles)) throw new Error('pluginManager.listBundles 返回形状无法识别')

  let items = selectUpgradableBundles(bundles, excluded)
  const total = items.length
  const emitSnapshot = () => onItem({ kind: 'snapshot', items: items.map((item) => ({ ...item })) })
  emitSnapshot()

  for (let index = 0; index < items.length; index += 1) {
    const name = items[index].name
    const from = items[index].from
    items = patchItem(items, index, { state: 'checking' })
    emitSnapshot()
    onOutput('检查插件 ' + name + (from ? ' ' + from : '') + '\n')
    try {
      const versions = await pluginManager.listVersions(name, updateOptions(registryBase))
      if (!versions || versions.status !== 'listed') {
        items = patchItem(items, index, {
          state: 'failed',
          error: (versions && (versions.reason || versions.problem)) || '版本列表不可用',
        })
        emitSnapshot()
        continue
      }
      const listedInstalled = versions.installed ?? null
      const installed = parseSemver(listedInstalled)
        && (!parseSemver(from) || gtSemver(listedInstalled, from))
        ? listedInstalled
        : from
      const target = choosePluginVersion(versions.versions, installed)
      if (target === null) {
        items = patchItem(items, index, { state: 'skipped', from: installed, reason: '没有严格高于已装版本的兼容版本' })
        emitSnapshot()
        continue
      }
      const requestId = newRequestId()
      items = patchItem(items, index, { state: 'upgrading', to: target.version })
      emitSnapshot()
      onItem({ kind: 'step', name, index: index + 1, total, requestId })
      onOutput('升级插件 ' + name + ': ' + (installed || '未知') + ' -> ' + target.version + '\n')
      const update = await pluginManager.updateBundle(name, target.version, {
        ...updateOptions(versions.registry || registryBase),
        requestId,
      })
      const change = update && update.result
      if (!change || NON_APPLIED_APPLICATIONS.has(change.application)) {
        const restoreFailed = update && update.restore && FAILED_APPLICATIONS.has(update.restore.application)
        const error = managementErrorText(change && change.error) + (restoreFailed ? ';恢复旧版本失败' : '')
        items = patchItem(items, index, { state: 'failed', from: installed, to: target.version, error, restoreFailed })
        emitSnapshot()
        onOutput('插件升级失败 ' + name + ': ' + error + '\n')
        continue
      }
      items = patchItem(items, index, {
        state: 'updated',
        from: installed,
        to: target.version,
        application: change.application,
      })
      emitSnapshot()
      onOutput('插件升级完成 ' + name + ' -> ' + target.version + '\n')
    } catch (error) {
      items = patchItem(items, index, { state: 'failed', from, to: null, error: errorText(error) })
      emitSnapshot()
      onOutput('插件升级异常 ' + name + ': ' + errorText(error) + '\n')
    }
  }
  return { requested: true, items, total }
}
