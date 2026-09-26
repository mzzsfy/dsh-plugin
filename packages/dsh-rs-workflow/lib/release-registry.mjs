// release-registry — 释放的注册形态(rc.1+:agentPresets.register 运行时注册,见 .compat/计划-rs-workflow-preset-rc1.md)
// 与 release.mjs 的目录形态(0.1.2-0.1.5)并立;分派判据 = register 方法在场
// (0.1.5 及以下的 agentPresets 是目录读取服务,同名但无 register)。
// 运行态:flowId → 注销 disposer 的模块级单例;board 行是唯一注册方,行卸载时
// disposeAllRegistered 统一注销(热重载 = 清空后重放,规避宿主 Duplicate 抛错)。
import { FLOW_ID_RE, presetMeta, releaseFlowTemplate, unreleaseFlowTemplate } from './release.mjs'
import { validateTemplate } from './template.mjs'
import { skeletonRows } from './skeleton.mjs'
import { loadJson, saveJson } from './storage.mjs'

const PRESET_ID_PREFIX = 'rs-'
// 注册预设排在官方 standard(order 1)之后
const PRESET_ORDER = 100

// 目录形态兜底用的家目录透传(测试注入临时目录;生产省略走 env 解析)
export function registryFormAvailable(agentPresets) {
  return typeof agentPresets?.register === 'function'
}

// 注册形态服务运行态:board 行注入时设置,行卸载清理时清除;template-tool 等
// 非 board 上下文的释放动作经 currentAgentPresets 取当值分派
let currentService
export function setAgentPresets(service) {
  currentService = service
}
export function currentAgentPresets() {
  return currentService
}

// released 标志落盘(注册形态的释放事实源 = templates.json;目录形态事实源 =
// 目录本身,标志仅冗余)。持久化形状与 normalizeTemplates 同约:仅 true 存字段,
// 撤销即删字段。模板不存在时静默跳过
export function markReleased(id, released) {
  const raw = loadJson('templates.json', [])
  const entry = raw.find((t) => t.id === id)
  if (entry === undefined) return
  if (released === true) entry.released = true
  else delete entry.released
  saveJson('templates.json', raw)
}

// 流程 id 校验收口(目录/注册两形态共用同一规则)
function normalizeFlowId(entry) {
  const flowId = typeof entry?.id === 'string' ? entry.id.trim() : ''
  if (!FLOW_ID_RE.test(flowId)) throw new Error(`流程 id 非法: ${JSON.stringify(entry?.id)}(须匹配 ${FLOW_ID_RE.source})`)
  return flowId
}

// 注册定义:骨架行(rows,已按 flowId 改写 templateId)+ 展示元数据
// 注册前完成全部校验,失败不触达宿主注册表
function buildDefinition(flowId, entry, rows) {
  let parsed
  try {
    parsed = JSON.parse(entry.json)
  } catch (error) {
    throw new Error(`模板 JSON 解析失败: ${error.message}`)
  }
  const errors = validateTemplate(parsed)
  if (errors.length > 0) throw new Error('模板校验失败:\n' + errors.map((e) => `${e.target}: ${e.message}`).join('\n'))
  const { name, description } = presetMeta(entry, flowId)
  return { id: PRESET_ID_PREFIX + flowId, name, description, order: PRESET_ORDER, plugins: rows }
}

const disposers = new Map()

async function registerDefinition(agentPresets, definition) {
  const previous = disposers.get(definition.id)
  const replaced = previous !== undefined
  if (replaced) {
    disposers.delete(definition.id)
    await previous()
  }
  const dispose = await agentPresets.register(definition)
  disposers.set(definition.id, dispose)
  // register 对挂载失败不抛(record.broken);回读名单把 broken 透出,防假成功。
  // broken 是诊断不是失败:定义已注册在案,可正常注销
  const roster = await agentPresets.list()
  const row = roster.find((item) => item.id === definition.id)
  return { replaced, broken: row?.broken === undefined ? undefined : String(row.broken) }
}

// 释放:注册形态优先,无 register 的宿主回落目录形态。
// 返回 {form, outcome, presetId, broken?};outcome ∈ created|updated|removed|missing|foreign|failed
export async function releaseTemplateVia(agentPresets, entry, rowsOf = (flowId) => skeletonRows(flowId), options = {}) {
  if (!registryFormAvailable(agentPresets)) {
    return { form: 'dir', outcome: releaseFlowTemplate(entry, options.dshHome) }
  }
  const flowId = normalizeFlowId(entry)
  const definition = buildDefinition(flowId, entry, rowsOf(flowId))
  try {
    const { replaced, broken } = await registerDefinition(agentPresets, definition)
    return { form: 'registry', outcome: replaced ? 'updated' : 'created', presetId: definition.id, ...(broken === undefined ? {} : { broken }) }
  } catch (error) {
    return { form: 'registry', outcome: 'failed', presetId: definition.id, broken: error.message }
  }
}

export async function unreleaseTemplateVia(agentPresets, flowId, options = {}) {
  if (!registryFormAvailable(agentPresets)) {
    return { form: 'dir', outcome: unreleaseFlowTemplate(flowId, options.dshHome) }
  }
  const id = PRESET_ID_PREFIX + normalizeFlowId({ id: flowId })
  const dispose = disposers.get(id)
  if (dispose === undefined) return { form: 'registry', outcome: 'missing', presetId: id }
  disposers.delete(id)
  await dispose()
  return { form: 'registry', outcome: 'removed', presetId: id }
}

// 启动重放:board 行激活时对已释放模板逐一注册。校验类失败(抛错)收敛为
// failed 条目,不阻断其余;单条注册服务错误同理
export async function replayReleased(agentPresets, entries, rowsOf = (flowId) => skeletonRows(flowId)) {
  const results = []
  for (const entry of entries) {
    try {
      results.push(await releaseTemplateVia(agentPresets, entry, rowsOf))
    } catch (error) {
      results.push({ form: 'registry', outcome: 'failed', broken: error.message })
    }
  }
  return results
}

// 行卸载清理:注销全部注册定义(热重载后由重放重建)
export async function disposeAllRegistered() {
  const pending = [...disposers.values()]
  disposers.clear()
  for (const dispose of pending) {
    try {
      await dispose()
    } catch { /* 单条注销失败不阻断其余 */ }
  }
  return pending.length
}
