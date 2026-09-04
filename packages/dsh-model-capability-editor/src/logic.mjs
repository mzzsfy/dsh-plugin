// 模型能力编辑纯逻辑层:档位四态映射、input 三态、整组写回合并、冲突字段级重放、
// 竞品痕迹检测、保存流(冲突重读重放一次)。src/client.js 为单文件自包含格式
// (factory 仅解析 react),与本文件保持同一份判定逻辑,修改须两处同步。

export const NS = 'llm-pi-ai'
export const CONFLICT_CODE = 'settings-conflict'
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const OFF_LEVEL = 'off'
export const MODALITIES = ['text', 'image']
export const INPUT_UNSET = 'unset'
export const INPUT_TEXT = 'text'
export const INPUT_TEXT_IMAGE = 'text-image'
// 竞品 dsh-better-reasoning-effort 的 host autofill 写入痕迹:模型条目上的
// 词汇表外标记字段,出现即说明竞品仍在运行,双写者并存。
export const COMPETITOR_MARKERS = ['reasoningEffortsUnset', 'inputUnset']

// reasoningEfforts 写回值 → 编辑器勾选/拼写草稿。false 仅勾 off;对象按键勾选,
// null 拼写为空;未声明无任何勾选。
export function effortsToDrafts(value) {
  const checked = {}
  const spellings = {}
  if (value === false) {
    checked[OFF_LEVEL] = true
  } else if (value !== null && typeof value === 'object') {
    for (const level of Object.keys(value)) {
      checked[level] = true
      spellings[level] = value[level] === null ? '' : String(value[level])
    }
  }
  return { checked, spellings }
}

// 勾选/拼写草稿 → reasoningEfforts 写回值(undefined 表示删除字段)。
// 词汇表外的基线档位在对象形态下原样保留。
export function draftsToEfforts(drafts, baselineValue) {
  const checkedLevels = EFFORT_LEVELS.filter((level) => drafts.checked[level] === true)
  if (checkedLevels.length === 0) return undefined
  if (checkedLevels.length === 1 && checkedLevels[0] === OFF_LEVEL &&
      String(drafts.spellings[OFF_LEVEL] || '').trim().length === 0) return false
  const result = {}
  for (const level of Object.keys(baselineValue && typeof baselineValue === 'object' ? baselineValue : {})) {
    if (EFFORT_LEVELS.indexOf(level) < 0) result[level] = baselineValue[level]
  }
  for (const level of checkedLevels) {
    const spelling = String(drafts.spellings[level] || '').trim()
    if (level === OFF_LEVEL) {
      result[OFF_LEVEL] = spelling.length > 0 ? spelling : null
    } else {
      result[level] = spelling.length > 0 ? spelling : level
    }
  }
  return result
}

// input 数组 → 三态。未声明与空数组(schema 视为未回答)同为未声明。
export function inputToMode(value) {
  if (!Array.isArray(value) || value.length === 0) return INPUT_UNSET
  return value.indexOf('image') >= 0 ? INPUT_TEXT_IMAGE : INPUT_TEXT
}

// 三态 → input 写回值(undefined 表示删除字段)。
export function modeToInput(mode) {
  if (mode === INPUT_TEXT) return ['text']
  if (mode === INPUT_TEXT_IMAGE) return ['text', 'image']
  return undefined
}

// reasoningEfforts 基线的可表达形态:未声明(undefined)/ false / null / 纯对象。
// 未声明必须可表达:给无档位模型添加档位声明是本插件核心场景。其余(字符串、
// 数组等非本插件写入的异型形态)不参与档位重写,编辑时跳过该字段防误删。
export function isExpressibleEfforts(value) {
  return value === undefined || value === false || value === null
    || (typeof value === 'object' && !Array.isArray(value))
}

// 单模型应用草稿:仅写 reasoningEfforts 与 input 两字段,其余字段保留最新条目值。
// 词汇表外档位透传基线取"写回时点的最新条目值"而非草稿快照,冲突重放路径下
// 他方并发新增的外档位不丢;基线为不可表达形态(字符串/数组)时跳过该字段防误删。
export function applyDraft(model, draft) {
  const result = { ...model }
  if (isExpressibleEfforts(model.reasoningEfforts)) {
    const efforts = draftsToEfforts(draft, model.reasoningEfforts)
    if (efforts === undefined) delete result.reasoningEfforts
    else result.reasoningEfforts = efforts
  }
  const input = modeToInput(draft.inputMode)
  if (input === undefined) delete result.input
  else result.input = input
  return result
}

// 整组写回:以 describe 读到的模型数组为基线,仅重写有草稿的条目,未编辑条目原样保留。
// 返回合并结果与未命中基线的草稿 id(他方删除该模型后草稿无处可写),调用方负责告警。
export function mergeBaselineModels(baselineModels, draftsById) {
  const droppedDraftIds = []
  const models = baselineModels.map((model) => {
    const draft = draftsById.get(model.id)
    return draft === undefined ? model : applyDraft(model, draft)
  })
  for (const id of draftsById.keys()) {
    if (!baselineModels.some((model) => model.id === id)) droppedDraftIds.push(id)
  }
  return { models, droppedDraftIds }
}

// 竞品写入痕迹检测:返回带词汇表外标记字段的模型 id 列表。
export function detectCompetitorTraces(models) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => model !== null && typeof model === 'object' &&
      COMPETITOR_MARKERS.some((marker) => marker in model))
    .map((model) => String(model.id))
}

// 未保存草稿按 provider 路由分桶:切换路由不丢弃,切回恢复;路由 null(无可用路由)不存。
export function stashDrafts(buckets, route, drafts) {
  if (route !== null) buckets.set(route, drafts)
  return buckets
}

export function restoreDrafts(buckets, route) {
  const drafts = buckets.get(route)
  return drafts === undefined ? null : drafts
}

// 行内应用的目标模型解析:官方行内 ID 输入若已改为基线中存在的新 id(改名已落盘,
// 原 id 已从基线消失),以新 id 为准;原 id 仍在基线视为撞名,回落原 id。
export function resolveTargetId(liveId, originalId, baselineIds) {
  const ids = baselineIds instanceof Set ? baselineIds : new Set(baselineIds)
  const renamed = typeof liveId === 'string' && liveId.length > 0 && ids.has(liveId) && !ids.has(originalId)
  return renamed ? liveId : originalId
}

// 官方模型页标题标记(zh/en);精确匹配,防止误中本插件回退菜单的「模型能力」。
export function isModelsTitle(title) {
  return title === '模型' || title === 'Models'
}

// 锚点破坏判定:模型页已打开且官方编辑器已展开,却找不到任何「模型 ID」输入,
// 说明官方 DOM 结构已变,行内注入失效,应回退独立菜单。
export function anchorsBroken({ titleMatched, hasEditor, modelIdInputCount }) {
  return titleMatched === true && hasEditor === true && modelIdInputCount === 0
}

function unwrapResult(result) {
  if (result !== null && typeof result === 'object' && result.ok === true) return result.value
  const error = new Error(result && result.error && result.error.message
    ? result.error.message
    : 'settings RPC 调用失败')
  error.code = result && result.error ? result.error.code : undefined
  throw error
}

// 宿主 wire 信封 → 插件内部 RPC 信封:{result:{ok,value|error}} 归一为 {ok,value|error}。
export function unwrapWire(response) {
  const result = response !== null && typeof response === 'object' ? response.result : undefined
  if (result !== null && typeof result === 'object' && result.ok === true) return { ok: true, value: result.value }
  return {
    ok: false,
    error: result !== null && typeof result === 'object' && result.error !== undefined
      ? result.error
      : { code: undefined, message: 'settings RPC 调用失败' },
  }
}

// 宿主 connection.api.settings wire 面 → 插件内部 settings 面(describe() / mutate(ns, ops, revision))。
// wire 面缺失或形状不完整返回 null,由调用方降级呈现只读原因。
export function makeSettingsFace(wire) {
  if (wire === null || typeof wire !== 'object' ||
      typeof wire.describe !== 'function' || typeof wire.mutate !== 'function') return null
  return {
    describe: async () => unwrapWire(await wire.describe({})),
    mutate: async (ns, ops, expectedRevision) => unwrapWire(await wire.mutate(
      { ns, ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
    )),
  }
}

async function describeNs(settings) {
  const value = unwrapResult(await settings.describe())
  const ns = (value.namespaces || []).find((entry) => entry.ns === NS)
  if (ns === undefined) throw new Error('settings 中不存在 ' + NS + ' 命名空间')
  return { writable: value.writable === true, revision: ns.revision, value: ns.value }
}

function modelsOf(nsValue, route) {
  const providers = nsValue && typeof nsValue === 'object' ? nsValue.providers : {}
  const provider = providers && typeof providers === 'object' ? providers[route] : undefined
  return provider && typeof provider === 'object' && Array.isArray(provider.models) ? provider.models : []
}

async function writeModels(settings, route, models, revision) {
  return unwrapResult(await settings.mutate(NS, [
    { op: 'set', path: ['providers', route, 'models'], value: models },
  ], revision))
}

// 保存流:冲突重读重放一次,再冲突报错终止,绝不静默覆盖。
// 返回已写回的模型数组与未命中基线的草稿 id(模型已被他方删除,编辑未落盘)。
export async function saveModels(settings, route, draftsById) {
  const first = await describeNs(settings)
  if (!first.writable) {
    const error = new Error('settings 只读,无法保存')
    error.code = 'settings-readonly'
    throw error
  }
  const attempt = (baseline, revision) =>
    writeModels(settings, route, mergeBaselineModels(baseline, draftsById).models, revision)
  let baseline = modelsOf(first.value, route)
  let revision = first.revision
  try {
    await attempt(baseline, revision)
  } catch (error) {
    if (error.code !== CONFLICT_CODE) throw error
    const second = await describeNs(settings)
    if (!second.writable) throw error
    baseline = modelsOf(second.value, route)
    revision = second.revision
    try {
      await attempt(baseline, revision)
    } catch (retryError) {
      if (retryError.code === CONFLICT_CODE) {
        throw new Error('保存冲突:重试一次后仍与其他写者冲突,已保留本次修改,未覆盖他人改动')
      }
      throw retryError
    }
  }
  return mergeBaselineModels(baseline, draftsById)
}
