// 模型能力编辑纯逻辑层:档位四态映射、input 三态、整组写回合并、冲突字段级重放、
// 竞品痕迹检测、保存流(冲突重读重放一次)。src/client.js 为单文件自包含格式
// (factory 仅解析 react),与本文件保持同一份判定逻辑,修改须两处同步。

export const NS = 'llm-pi-ai'
export const CONFLICT_CODE = 'settings-conflict'
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const OFF_LEVEL = 'off'
export const INPUT_UNSET = 'unset'
export const INPUT_TEXT = 'text'
export const INPUT_TEXT_IMAGE = 'text-image'
export const INPUT_IMAGE = 'image-only'
export const INPUT_MODES = [INPUT_UNSET, INPUT_TEXT, INPUT_TEXT_IMAGE, INPUT_IMAGE]
// 竞品 dsh-better-reasoning-effort 的 host autofill 写入痕迹:模型条目上的
// 词汇表外标记字段,出现即说明竞品仍在运行,双写者并存。
export const COMPETITOR_MARKERS = ['reasoningEffortsUnset', 'inputUnset']

// reasoningEfforts 写回值 → 编辑器勾选/拼写草稿。false 仅勾 off;对象按键勾选,
// null 拼写为空;未声明无任何勾选。只收词汇表内档位:词汇表外键不在 UI 呈现
// 也不可编辑,进种子会让"未触及"判定误判为已编辑。
export function effortsToDrafts(value) {
  const checked = {}
  const spellings = {}
  if (value === false) {
    checked[OFF_LEVEL] = true
  } else if (value !== null && typeof value === 'object') {
    for (const level of Object.keys(value)) {
      if (EFFORT_LEVELS.indexOf(level) < 0) continue
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

// input 数组 → 四态。未声明与空数组(schema 视为未回答)同为未声明;仅 image
// (无 text)为纯图像输入(部分视觉网关不收文本)。非法成员仅不影响判定。
export function inputToMode(value) {
  if (!Array.isArray(value) || value.length === 0) return INPUT_UNSET
  const hasText = value.indexOf('text') >= 0
  const hasImage = value.indexOf('image') >= 0
  if (hasText) return hasImage ? INPUT_TEXT_IMAGE : INPUT_TEXT
  return hasImage ? INPUT_IMAGE : INPUT_UNSET
}

// 四态 → input 写回值(undefined 表示删除字段)。
export function modeToInput(mode) {
  if (mode === INPUT_TEXT) return ['text']
  if (mode === INPUT_TEXT_IMAGE) return ['text', 'image']
  if (mode === INPUT_IMAGE) return ['image']
  return undefined
}

// 一键草稿填充:只动内存草稿,写回仍走显式保存。仅补"未勾选任何档位"的模型
// (即 reasoningEfforts 未声明的手声明模型,本插件核心场景):七档全勾、拼写
// 留空(线上值 = 档位名)。已编辑(有勾选)与 inputMode 一律不碰,防覆盖既有声明。
export function fillDrafts(drafts, models) {
  const filled = new Map(drafts)
  for (const model of Array.isArray(models) ? models : []) {
    const key = String(model.id)
    const draft = filled.get(key)
    if (draft === undefined) continue
    const hasChecked = EFFORT_LEVELS.some((level) => draft.checked[level] === true)
    if (hasChecked) continue
    const checked = {}
    for (const level of EFFORT_LEVELS) checked[level] = true
    filled.set(key, { ...draft, checked, spellings: { ...draft.spellings } })
  }
  return filled
}

// reasoningEfforts 基线的可表达形态:未声明(undefined)/ false / null / 纯对象。
// 未声明必须可表达:给无档位模型添加档位声明是本插件核心场景。其余(字符串、
// 数组等非本插件写入的异型形态)不参与档位重写,编辑时跳过该字段防误删。
export function isExpressibleEfforts(value) {
  return value === undefined || value === false || value === null
    || (typeof value === 'object' && !Array.isArray(value))
}

// 勾选/拼写两表逐键相等(键集合一致且值全等)
function draftMapsEqual(a, b) {
  const ak = Object.keys(a || {})
  const bk = Object.keys(b || {})
  if (ak.length !== bk.length) return false
  return ak.every((key) => (a || {})[key] === (b || {})[key])
}

// 单模型应用草稿:仅写 reasoningEfforts 与 input 两字段,其余字段保留最新条目值。
// 未触及判定以草稿冻结的加载时点种子(draft.seed)为参照,而非写回时点重算的投影:
// 加载后他方修改基线时,零编辑与仅改单一字段的草稿不会把另一字段静默回滚到他方
// 修改之前。无 seed 的裸草稿(测试夹具/现场兜底)回退写回时点投影,与旧语义一致。
// 词汇表外档位透传基线取"写回时点的最新条目值"而非草稿快照,冲突重放路径下
// 他方并发新增的外档位不丢;基线为不可表达形态(字符串/数组)时跳过该字段防误删。
export function applyDraft(model, draft) {
  const result = { ...model }
  // 无 seed 兜底 = 写回时点全投影(efforts + inputMode),与旧判定语义一致
  const seed = draft.seed !== undefined
    ? draft.seed
    : { ...effortsToDrafts(model.reasoningEfforts), inputMode: inputToMode(model.input) }
  const effortsUntouched = draftMapsEqual(seed.checked, draft.checked) &&
    draftMapsEqual(seed.spellings, draft.spellings)
  if (!effortsUntouched && isExpressibleEfforts(model.reasoningEfforts)) {
    const efforts = draftsToEfforts(draft, model.reasoningEfforts)
    if (efforts === undefined) delete result.reasoningEfforts
    else result.reasoningEfforts = efforts
  }
  if (draft.inputMode !== seed.inputMode) {
    const input = modeToInput(draft.inputMode)
    if (input === undefined) delete result.input
    else result.input = input
  }
  return result
}

// 模型条目形态:官方 schema 已拒绝非对象条目,此处守卫仅防手写 yaml 等旁路输入。
// 判式与 detectCompetitorTraces 一致。
function isModelEntry(model) {
  return model !== null && typeof model === 'object'
}

// 整组写回:以 describe 读到的模型数组为基线,仅重写有草稿的条目,未编辑条目原样保留。
// 非对象条目原样透传(保真不静默删数据);返回合并结果与未命中基线的草稿 id
// (他方删除该模型后草稿无处可写),调用方负责告警。
// 键一律 String 归一:DOM 输入与 UI 状态恒为字符串,基线 id 形态不定。
export function mergeBaselineModels(baselineModels, draftsById) {
  const droppedDraftIds = []
  const models = baselineModels.map((model) => {
    const draft = isModelEntry(model) ? draftsById.get(String(model.id)) : undefined
    return draft === undefined ? model : applyDraft(model, draft)
  })
  for (const id of draftsById.keys()) {
    if (!baselineModels.some((model) => isModelEntry(model) && String(model.id) === String(id))) droppedDraftIds.push(id)
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

// settings 传输 → 插件内部 settings 面(describe() / mutate(ns, ops, revision))。
// 两种宿主传输形态,能力面在 0.1.1 即存在:
// - typed remote 面(dsh 0.1.2+):方法直返 RemoteResult 信封 {ok,value|error};
// - connection.api 面(dsh 0.1.1+):settings.describe() 无参,settings.mutate({ns,ops,...})
//   单对象参数,返回 {rpcId,result:{ok,value|error}} 信封。
// 面缺失或形状不完整返回 null,由调用方降级呈现只读原因。
function unwrapEnvelope(envelope) {
  if (envelope !== null && typeof envelope === 'object' && envelope.ok === true) return envelope.value
  if (envelope !== null && typeof envelope === 'object' &&
      envelope.result !== null && typeof envelope.result === 'object') {
    if (envelope.result.ok === true) return envelope.result.value
    return rejectRpc(envelope.result.error)
  }
  return rejectRpc(envelope && envelope.error)
}

function rejectRpc(error) {
  const rpcError = new Error(error && error.message ? error.message : 'settings RPC 调用失败')
  rpcError.code = error ? error.code : undefined
  throw rpcError
}

export function makeSettingsFace(transport) {
  if (transport === null || typeof transport !== 'object') return null
  const typed = typeof transport.describe === 'function' && typeof transport.mutate === 'function'
  if (typed) {
    return {
      describe: async () => unwrapEnvelope(await transport.describe()),
      mutate: async (ns, ops, expectedRevision) =>
        unwrapEnvelope(await transport.mutate(ns, ops, expectedRevision)),
    }
  }
  const api = transport.api
  if (api === null || typeof api !== 'object' ||
      api.settings === null || typeof api.settings !== 'object' ||
      typeof api.settings.describe !== 'function' || typeof api.settings.mutate !== 'function') return null
  return {
    describe: async () => unwrapEnvelope(await api.settings.describe({})),
    mutate: async (ns, ops, expectedRevision) =>
      unwrapEnvelope(await api.settings.mutate({
        ns,
        ops,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      })),
  }
}

// describe 信封 → 本插件命名空间条目投影。namespaces 非数组按空表处理,缺失策略由调用方定。
function findNsEntry(value) {
  const namespaces = value !== null && typeof value === 'object' && Array.isArray(value.namespaces)
    ? value.namespaces
    : []
  return namespaces.find((entry) => entry !== null && typeof entry === 'object' && entry.ns === NS)
}

async function describeNs(settings) {
  const value = await settings.describe()
  const ns = findNsEntry(value)
  if (ns === undefined) throw new Error('settings 中不存在 ' + NS + ' 命名空间')
  // expectedRevision 为 undefined 时宿主跳过冲突检查即盲写,revision 缺失拒绝保存
  if (typeof ns.revision !== 'number') throw new Error('settings 未返回 revision,已拒绝盲写,请刷新页面重读')
  return { writable: value.writable === true, revision: ns.revision, value: ns.value }
}

function modelsOf(nsValue, route) {
  const providers = nsValue && typeof nsValue === 'object' ? nsValue.providers : {}
  const provider = providers && typeof providers === 'object' ? providers[route] : undefined
  const models = provider && typeof provider === 'object' && Array.isArray(provider.models) ? provider.models : []
  // 非对象条目读侧过滤:手写 yaml 旁路输入不得让 String(model.id) 读侧迭代崩溃
  return models.filter((model) => model !== null && typeof model === 'object')
}

// 保存前基线形态校验:providers 缺失或 models 非数组时 modelsOf 会静默归空数组,
// 一次保存即把他方(或损坏)的整组模型覆写为空;此处拒绝保存,呈现通道由调用方 catch 承担。
function assertWritableBaseline(nsValue, route) {
  const providers = nsValue !== null && typeof nsValue === 'object' ? nsValue.providers : undefined
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('llm-pi-ai 声明缺少 providers 对象,已拒绝保存,请刷新页面重读')
  }
  const provider = providers[route]
  if (provider === null || typeof provider !== 'object' || !Array.isArray(provider.models)) {
    throw new Error('provider ' + String(route) + ' 的 models 不是数组,已拒绝保存,请刷新页面重读')
  }
}

async function writeModels(settings, route, models, revision) {
  return settings.mutate(NS, [
    { op: 'set', path: ['providers', route, 'models'], value: models },
  ], revision)
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
  assertWritableBaseline(first.value, route)
  const attempt = (baseline, revision) =>
    writeModels(settings, route, mergeBaselineModels(baseline, draftsById).models, revision)
  let baseline = modelsOf(first.value, route)
  let revision = first.revision
  try {
    await attempt(baseline, revision)
  } catch (error) {
    if (error.code !== CONFLICT_CODE) throw error
    const second = await describeNs(settings)
    // 重读发现已转只读:终态是只读而非冲突,抛只读语义而非原冲突错误
    if (!second.writable) {
      const readonlyError = new Error('settings 已转只读,保存终止,未覆盖他人改动')
      readonlyError.code = 'settings-readonly'
      throw readonlyError
    }
    assertWritableBaseline(second.value, route)
    baseline = modelsOf(second.value, route)
    revision = second.revision
    try {
      await attempt(baseline, revision)
    } catch (retryError) {
      if (retryError.code === CONFLICT_CODE) {
        const finalConflict = new Error('保存冲突:重试一次后仍与其他写者冲突,已保留本次修改,未覆盖他人改动')
        finalConflict.code = CONFLICT_CODE
        throw finalConflict
      }
      throw retryError
    }
  }
  return mergeBaselineModels(baseline, draftsById)
}

// 基线模型 → 可编辑草稿 Map(初值 = 当前声明)。seed 冻结加载时点投影,
// applyDraft 的未触及判定以其为参照(见 applyDraft 注释)。键一律 String:
// 基线 id 形态不定,而 UI 与 DOM 侧的模型标识恒为字符串。
export function draftsFromModels(models) {
  const drafts = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    if (!isModelEntry(model)) continue
    const efforts = effortsToDrafts(model.reasoningEfforts)
    drafts.set(String(model.id), {
      checked: efforts.checked,
      spellings: efforts.spellings,
      inputMode: inputToMode(model.input),
      seed: { checked: { ...efforts.checked }, spellings: { ...efforts.spellings }, inputMode: inputToMode(model.input) },
    })
  }
  return drafts
}
