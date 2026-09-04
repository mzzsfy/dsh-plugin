// 模型能力编辑 Client 半区:settings.section 独立设置页卡片。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 的模块表解析。
// 纯客户端零 host 端:读写经 connection.api.settings 的 describe/mutate wire RPC,
// 信封由 makeSettingsFace 适配为插件内部 RPC 面。
// 判定逻辑与 src/logic.mjs 为同一份(单文件自包含格式无法跨文件 require),
// 修改须两处同步。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-model-capability-editor',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React

    const RECONCILE_DEBOUNCE_MS = 150
    // 插件实例代际:宿主热重载/禁用重建时区分新旧实例,样式清理只认自有属主
    let instanceSeq = 0

const CSS = [
  '.mce-card { display:flex; flex-direction:column; gap:10px; color:inherit; font-size:13px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:10px; padding:12px;',
  '  margin-top:12px; }',
  '.mce-head { display:flex; align-items:center; gap:8px; }',
  '.mce-head__title { font-weight:600; font-size:14px; }',
  '.mce-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.mce-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  background:transparent; color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
  '.mce-btn:hover { opacity:0.8; }',
  '.mce-btn:disabled { opacity:0.45; cursor:default; }',
  '.mce-btn--primary { background:var(--dsw-alias-bg-brand-primary, #4d6bfe); border-color:transparent; color:#fff; }',
  '.mce-select { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:inherit; }',
  '.mce-text { background:transparent; color:inherit; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35));',
  '  border-radius:6px; padding:2px 6px; font-size:12px; font-family:inherit; width:90px; }',
  '.mce-model { display:flex; flex-direction:column; gap:4px; }',
  '.mce-model__head { font-weight:600; }',
  '.mce-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }',
  '.mce-check { display:inline-flex; align-items:center; gap:3px; font-size:12px; }',
  '.mce-label { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.mce-notice { font-size:12px; padding:4px 8px; border-radius:6px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
  '.mce-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.mce-notice--ok { color:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.mce-notice--warn { color:#d97706; }',
  '.mce-spacer { flex:1; }',
  '.mce-inline { margin-top:6px; padding:8px 10px; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.25));',
  '  border-radius:8px; display:flex; flex-direction:column; gap:8px; color:inherit; font-size:12px;',
  '  background:var(--dsw-alias-bg-secondary, rgba(128,128,128,0.06)); }',
  '.mce-inline__title { font-weight:600; font-size:12px; color:var(--dsw-alias-label-secondary); }',
  '.mce-inline__grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:6px 16px; }',
  '.mce-inline__field { display:flex; align-items:center; gap:6px; min-width:0; }',
  '.mce-inline__field > label { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }',
  '.mce-inline__field input[type=text] { flex:1; min-width:0; width:auto; }',
  '.mce-inline select { flex:1; min-width:0; }',
  '.mce-inline__foot { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.mce-fallback-btn { position:fixed; right:16px; top:50%; transform:translateY(-50%); z-index:60;',
  '  box-shadow:0 2px 8px rgba(0,0,0,0.18); }',
  '.mce-fallback-card { position:fixed; right:16px; top:12px; bottom:12px; width:420px; max-width:calc(100vw - 32px);',
  '  overflow:auto; z-index:55; background:var(--dsw-alias-bg-primary, #fff);',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); border-radius:12px;',
  '  box-shadow:0 4px 24px rgba(0,0,0,0.18); }',
].join('\n')

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return React.createElement.apply(React, [type, props || null].concat(children))
}

/* LOGIC-BEGIN */
// 纯逻辑段:与 src/logic.mjs 保持同一份判定逻辑,由 parity 测试保证。
// 边界规则:凡不引用 React/h/document 的函数与常量一律置于本段内。

const NS = 'llm-pi-ai'
const CONFLICT_CODE = 'settings-conflict'
const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const OFF_LEVEL = 'off'
const INPUT_UNSET = 'unset'
const INPUT_TEXT = 'text'
const INPUT_TEXT_IMAGE = 'text-image'
const INPUT_MODES = [INPUT_UNSET, INPUT_TEXT, INPUT_TEXT_IMAGE]
const INPUT_MODE_LABELS = { [INPUT_UNSET]: '未声明', [INPUT_TEXT]: '仅文本', [INPUT_TEXT_IMAGE]: '文本+图像' }
// 竞品 dsh-better-reasoning-effort 的 host autofill 写入痕迹标记字段
const COMPETITOR_MARKERS = ['reasoningEffortsUnset', 'inputUnset']

// reasoningEfforts 写回值 → 编辑器勾选/拼写草稿。只收词汇表内档位:词汇表外键
// 不在 UI 呈现也不可编辑,进种子会让"未触及"判定误判为已编辑。
function effortsToDrafts(value) {
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

// 勾选/拼写草稿 → reasoningEfforts 写回值(undefined = 删除字段);基线词汇表外档位保留
function draftsToEfforts(drafts, baselineValue) {
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

// input 数组 → 三态;未声明与空数组(schema 视为未回答)同为未声明
function inputToMode(value) {
  if (!Array.isArray(value) || value.length === 0) return INPUT_UNSET
  return value.indexOf('image') >= 0 ? INPUT_TEXT_IMAGE : INPUT_TEXT
}

// 三态 → input 写回值(undefined = 删除字段)
function modeToInput(mode) {
  if (mode === INPUT_TEXT) return ['text']
  if (mode === INPUT_TEXT_IMAGE) return ['text', 'image']
  return undefined
}

// reasoningEfforts 基线可表达形态:未声明/false/null/纯对象;异型形态跳过重写防误删
function isExpressibleEfforts(value) {
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

// 单模型应用草稿:仅写两字段,其余字段保留最新条目值。
// 未触及判定:草稿与当前基线的投影逐键一致即视为未编辑,跳过重写,
// 私有模态与词汇表外档位在整组保存时真正原样保留;异型基线跳过重写防误删。
function applyDraft(model, draft) {
  const result = { ...model }
  const seeded = effortsToDrafts(model.reasoningEfforts)
  const effortsUntouched = draftMapsEqual(seeded.checked, draft.checked) &&
    draftMapsEqual(seeded.spellings, draft.spellings)
  if (!effortsUntouched && isExpressibleEfforts(model.reasoningEfforts)) {
    const efforts = draftsToEfforts(draft, model.reasoningEfforts)
    if (efforts === undefined) delete result.reasoningEfforts
    else result.reasoningEfforts = efforts
  }
  if (draft.inputMode !== inputToMode(model.input)) {
    const input = modeToInput(draft.inputMode)
    if (input === undefined) delete result.input
    else result.input = input
  }
  return result
}

// 整组写回:以 describe 读到的数组为基线,仅重写有草稿的条目,未声明模型不删除。
// 返回合并结果与未命中基线的草稿 id(模型已被他方删除,编辑未落盘)。键 String 归一。
function mergeBaselineModels(baselineModels, draftsById) {
  const droppedDraftIds = []
  const models = baselineModels.map((model) => {
    const draft = draftsById.get(String(model.id))
    return draft === undefined ? model : applyDraft(model, draft)
  })
  for (const id of draftsById.keys()) {
    if (!baselineModels.some((model) => String(model.id) === String(id))) droppedDraftIds.push(id)
  }
  return { models, droppedDraftIds }
}

// 竞品写入痕迹:词汇表外标记字段
function detectCompetitorTraces(models) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => model !== null && typeof model === 'object' &&
      COMPETITOR_MARKERS.some((marker) => marker in model))
    .map((model) => String(model.id))
}

// 未保存草稿按 provider 路由分桶:切换路由不丢弃,切回恢复;路由 null(无可用路由)不存。
function stashDrafts(buckets, route, drafts) {
  if (route !== null) buckets.set(route, drafts)
  return buckets
}

function restoreDrafts(buckets, route) {
  const drafts = buckets.get(route)
  return drafts === undefined ? null : drafts
}

// 行内应用的目标模型解析:官方行内 ID 输入若已改为基线中存在的新 id(改名已落盘,
// 原 id 已从基线消失),以新 id 为准;原 id 仍在基线视为撞名,回落原 id。
function resolveTargetId(liveId, originalId, baselineIds) {
  const ids = baselineIds instanceof Set ? baselineIds : new Set(baselineIds)
  const renamed = typeof liveId === 'string' && liveId.length > 0 && ids.has(liveId) && !ids.has(originalId)
  return renamed ? liveId : originalId
}

// 官方模型页标题标记(zh/en);精确匹配,防止误中本插件回退菜单的「模型能力」。
function isModelsTitle(title) {
  return title === '模型' || title === 'Models'
}

// 锚点破坏判定:模型页已打开且官方编辑器已展开,却找不到任何「模型 ID」输入,
// 说明官方 DOM 结构已变,行内注入失效,应回退独立菜单。
function anchorsBroken({ titleMatched, hasEditor, modelIdInputCount }) {
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
function unwrapWire(response) {
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
function makeSettingsFace(wire) {
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
async function saveModels(settings, route, draftsById) {
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

// 基线模型 → 可编辑草稿 Map(初值 = 当前声明)。键一律 String:基线 id 形态不定,
// 而 UI 与 DOM 侧的模型标识恒为字符串。
function draftsFromModels(models) {
  const drafts = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    const efforts = effortsToDrafts(model.reasoningEfforts)
    drafts.set(String(model.id), {
      checked: efforts.checked,
      spellings: efforts.spellings,
      inputMode: inputToMode(model.input),
    })
  }
  return drafts
}
/* LOGIC-END */

function LevelEditor(props) {
  const model = props.model
  const draft = props.draft
  const disabled = props.disabled === true
  const toggle = (level) => {
    props.onChange({
      ...draft,
      checked: { ...draft.checked, [level]: draft.checked[level] !== true },
    })
  }
  const spell = (level, value) => {
    props.onChange({ ...draft, spellings: { ...draft.spellings, [level]: value } })
  }
  return h('div', { className: 'mce-row' },
    EFFORT_LEVELS.map((level) => h('label', { className: 'mce-check', key: level },
      h('input', { type: 'checkbox', disabled, checked: draft.checked[level] === true, onChange: () => toggle(level) }),
      level,
      h('input', {
        className: 'mce-text',
        disabled: disabled || draft.checked[level] !== true,
        value: draft.spellings[level] || '',
        placeholder: level,
        onChange: (event) => spell(level, event.target.value),
      }),
    )),
  )
}

function ModelRow(props) {
  const model = props.model
  const draft = props.draft
  const disabled = props.disabled === true
  return h('div', { className: 'mce-model' },
    h('div', { className: 'mce-model__head' }, model.id, model.name && model.name !== model.id ? ' (' + model.name + ')' : ''),
    h('div', { className: 'mce-row' },
      h('span', { className: 'mce-label' }, '推理档位(勾选 = 提供,输入 = 线上拼写):'),
      h(LevelEditor, { model, draft, disabled, onChange: props.onChange }),
    ),
    h('div', { className: 'mce-row' },
      h('span', { className: 'mce-label' }, '输入模态:'),
      h('select', {
        className: 'mce-select',
        disabled,
        value: draft.inputMode,
        onChange: (event) => props.onChange({ ...draft, inputMode: event.target.value }),
      }, INPUT_MODES.map((mode) => h('option', { key: mode, value: mode }, INPUT_MODE_LABELS[mode]))),
    ),
  )
}

function CapabilityCard(props) {
  const [state, setState] = useState({ phase: 'loading', reason: null, providers: null, route: null, models: null, drafts: null, traces: null })
  const [notice, setNotice] = useState(null)
  const [saving, setSaving] = useState(false)
  // 未保存草稿按路由分桶,切换路由不丢弃,切回恢复
  const bucketsRef = React.useRef(null)
  if (bucketsRef.current === null) bucketsRef.current = new Map()
  // 路由切换代际:selectRoute 在途时 describe 返回的过期轮次不得改状态,
  // 保存按钮在切换窗口禁用,防旧路由草稿经 saveModels 写入新路由
  const [switching, setSwitching] = useState(false)
  const routeSeqRef = React.useRef(0)
  // 内存中 drafts 的归属路由:入桶前校验归属,防快速连切把旧路由草稿存错桶
  const draftsRouteRef = React.useRef(null)

  function patch(part) { setState((prev) => ({ ...prev, ...part })) }

  async function load() {
    try {
      const settings = props.settings
      if (!settings || typeof settings.describe !== 'function') {
        patch({ phase: 'readonly', reason: 'connection.api.settings wire 面缺失,无法读写模型声明' })
        return
      }
      const value = unwrapResult(await settings.describe())
      if (value.writable !== true) {
        patch({ phase: 'readonly', reason: 'settings 当前只读,模型能力编辑不可用' })
        return
      }
      const ns = (value.namespaces || []).find((entry) => entry.ns === NS)
      if (ns === undefined) {
        patch({ phase: 'readonly', reason: 'settings 中不存在 ' + NS + ' 命名空间' })
        return
      }
      const providers = ns.value && typeof ns.value === 'object' ? ns.value.providers : {}
      const routes = Object.keys(providers && typeof providers === 'object' ? providers : {})
      const route = routes[0] !== undefined ? routes[0] : null
      patch({
        phase: 'ready',
        providers: routes,
        route,
        models: route === null ? [] : modelsOf(ns.value, route),
        drafts: route === null ? new Map() : draftsFromModels(modelsOf(ns.value, route)),
        traces: route === null ? [] : detectCompetitorTraces(modelsOf(ns.value, route)),
      })
      draftsRouteRef.current = route
    } catch (error) {
      patch({ phase: 'readonly', reason: '读取模型声明失败:' + (error && error.message ? error.message : String(error)) })
    }
  }

  useEffect(() => { void load() }, [])

  function selectRoute(nextRoute) {
    const prevRoute = state.route
    // 仅当内存中的 drafts 确属当前路由才入桶:快速连切在 disabled 渲染前的
    // 窗口内第二次 change 到达时,state.drafts 仍属上一路由,入桶会污染缓存
    if (draftsRouteRef.current === state.route) stashDrafts(bucketsRef.current, state.route, state.drafts)
    const seq = ++routeSeqRef.current
    setSwitching(true)
    patch({ route: nextRoute, phase: 'ready' })
    void (async () => {
      try {
        const value = unwrapResult(await props.settings.describe())
        if (seq !== routeSeqRef.current) return
        const ns = (value.namespaces || []).find((entry) => entry.ns === NS)
        if (ns === undefined) {
          setNotice({ kind: 'error', text: 'settings 中不存在 ' + NS + ' 命名空间,请刷新页面' })
          return
        }
        const models = modelsOf(ns.value, nextRoute)
        // 切回路由恢复未保存草稿;无缓存才以最新声明为初值
        const drafts = restoreDrafts(bucketsRef.current, nextRoute) || draftsFromModels(models)
        draftsRouteRef.current = nextRoute
        patch({ models, drafts, traces: detectCompetitorTraces(models) })
      } catch (error) {
        // describe 失败:回滚路由,models/drafts 仍是旧路由数据,避免旧草稿对新基线静默写回
        if (seq === routeSeqRef.current) patch({ route: prevRoute })
        setNotice({ kind: 'error', text: '读取 ' + nextRoute + ' 失败:' + (error && error.message ? error.message : String(error)) })
      } finally {
        if (seq === routeSeqRef.current) setSwitching(false)
      }
    })()
  }

  function editDraft(id, draft) {
    const drafts = new Map(state.drafts)
    drafts.set(String(id), draft)
    patch({ drafts })
  }

  async function save() {
    setSaving(true)
    setNotice(null)
    try {
      const { models: written, droppedDraftIds } = await saveModels(props.settings, state.route, state.drafts)
      // 孤儿草稿:草稿对应模型已被他方删除,编辑未落盘,必须告警而非报成功
      setNotice(droppedDraftIds.length > 0
        ? { kind: 'warn', text: '已保存,但模型 ' + droppedDraftIds.join(', ') + ' 已被其他写者删除,对应修改未写入' }
        : { kind: 'ok', text: '已保存并写回 settings.yaml' })
      try {
        const value = unwrapResult(await props.settings.describe())
        const ns = (value.namespaces || []).find((entry) => entry.ns === NS)
        if (ns === undefined) {
          // 保存后命名空间被他方移除:明确告知刷新,不再裸抛
          patch({ phase: 'readonly', reason: '保存后 ' + NS + ' 命名空间已消失,可能被其他写者移除,请刷新页面' })
          return
        }
        const latest = modelsOf(ns.value, state.route)
        const drafts = draftsFromModels(latest)
        stashDrafts(bucketsRef.current, state.route, drafts)
        draftsRouteRef.current = state.route
        patch({ models: latest, drafts, traces: detectCompetitorTraces(latest) })
      } catch (refreshError) {
        // 保存已成功,收尾刷新失败只降级提示,不覆盖保存通知
        setNotice({ kind: 'warn', text: '已保存,但刷新视图失败:' + (refreshError && refreshError.message ? refreshError.message : String(refreshError)) })
      }
    } catch (error) {
      setNotice({ kind: 'error', text: (error && error.message ? error.message : String(error)) })
    } finally {
      setSaving(false)
    }
  }

  if (state.phase === 'loading') {
    return h('div', { className: 'mce-card' },
      h('span', { className: 'mce-label' }, '正在读取模型声明…'))
  }
  if (state.phase === 'readonly') {
    return h('div', { className: 'mce-card' },
      h('div', { className: 'mce-head' }, h('span', { className: 'mce-head__title' }, '模型能力')),
      h('div', { className: 'mce-notice mce-notice--error' }, state.reason))
  }
  return h('div', { className: 'mce-card' },
    h('div', { className: 'mce-head' },
      h('span', { className: 'mce-head__title' }, '模型能力'),
      h('span', { className: 'mce-head__hint' }, '编辑 llm-pi-ai 管理的模型声明,覆盖范围仅限 llm-pi-ai'),
      h('span', { className: 'mce-spacer' }),
      h('select', {
        className: 'mce-select',
        value: state.route || '',
        // 切换/保存在途均禁路由切换:保存收尾以闭包路由重读,中途切路由会渲染串线
        disabled: switching || saving,
        onChange: (event) => selectRoute(event.target.value),
      }, state.providers.map((route) => h('option', { key: route, value: route }, route))),
    ),
    state.traces !== null && state.traces.length > 0
      ? h('div', { className: 'mce-notice mce-notice--warn' },
          '检测到竞品 dsh-better-reasoning-effort 的写入痕迹(模型 ' + state.traces.join(', ') +
          ' 含 autofill 标记字段)。两个写者并存会互相覆盖,请先在 profile 中移除该插件再使用本卡片。')
      : null,
    state.models.map((model) => h(ModelRow, {
      key: model.id,
      model,
      draft: state.drafts.get(String(model.id)) || draftsFromModels([model]).get(String(model.id)),
      disabled: saving,
      onChange: (draft) => editDraft(model.id, draft),
    })),
    state.models.length === 0
      ? h('div', { className: 'mce-label' }, '该 provider 暂无模型条目。')
      : null,
    notice !== null ? h('div', { className: 'mce-notice mce-notice--' + notice.kind }, notice.text) : null,
    h('div', { className: 'mce-row' },
      h('button', { className: 'mce-btn', disabled: saving || switching || state.route === null, onClick: save }, saving ? '保存中…' : '保存'),
      h('span', { className: 'mce-label' }, '保存 = 整组写回当前 provider 的 models 数组,未编辑的模型原样保留。'),
    ),
  )
}

// 回退浮动入口:行内注入锚点破坏时,模型页右侧提供完整编辑卡
function FallbackPanel(props) {
  const [open, setOpen] = useState(false)
  return h('div', null,
    h('button', { className: 'mce-btn mce-fallback-btn', onClick: () => setOpen(!open) },
      open ? '收起模型能力' : '模型能力'),
    open ? h('div', { className: 'mce-fallback-card' },
      React.createElement(CapabilityCard, { settings: props.settings }),
    ) : null,
  )
}

// 行内编辑块:单个模型的档位与模态编辑,挂在官方模型行的展开区内。
// 复用整组合并保存流,草稿只含本模型一条,其余模型原样保留。
function RowEditor(props) {
  const settings = props.settings
  const route = props.route
  const modelId = props.modelId
  const aliveRef = React.useRef(false)
  const [state, setState] = useState({ phase: 'loading', draft: null, notice: null })
  const [saving, setSaving] = useState(false)
  // 存活标记标准写法:setup 置 true、cleanup 置 false,StrictMode 双挂载后仍为 true
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  function patch(part) { setState((prev) => ({ ...prev, ...part })) }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = unwrapResult(await settings.describe())
        const ns = (value.namespaces || []).find((entry) => entry.ns === NS)
        if (!alive) return
        if (ns === undefined) { patch({ phase: 'hidden' }); return }
        const model = modelsOf(ns.value, route).find((entry) => String(entry.id) === String(modelId))
        if (model === undefined) { patch({ phase: 'hidden' }); return }
        patch({ phase: 'ready', draft: draftsFromModels([model]).get(String(modelId)) })
      } catch (error) {
        if (alive) patch({ phase: 'error', notice: error && error.message ? error.message : String(error) })
      }
    })()
    return () => { alive = false }
  }, [])

  async function apply() {
    setSaving(true)
    patch({ notice: null })
    try {
      // S3:官方行内 ID 输入是活动状态,改名已落盘则以新 ID 为目标,否则回落原 ID
      const el = props.idInputEl
      const liveId = el && el.isConnected ? el.value : modelId
      const first = unwrapResult(await settings.describe())
      const nsFirst = (first.namespaces || []).find((entry) => entry.ns === NS)
      const baselineIds = new Set(nsFirst !== undefined ? modelsOf(nsFirst.value, route).map((entry) => String(entry.id)) : [])
      const targetId = resolveTargetId(liveId, modelId, baselineIds)
      const { models: written, droppedDraftIds } = await saveModels(settings, route, new Map([[targetId, state.draft]]))
      // S4:保存后重读重建草稿,基线新鲜,保留他方词汇表外档位
      const second = unwrapResult(await settings.describe())
      const nsSecond = (second.namespaces || []).find((entry) => entry.ns === NS)
      const latest = nsSecond !== undefined
        ? modelsOf(nsSecond.value, route).find((entry) => String(entry.id) === String(targetId))
        : undefined
      if (aliveRef.current) {
        // 孤儿草稿(模型被他方删除)时 written 不含目标条目,兜底保留当前草稿防渲染崩溃
        const freshDraft = (latest !== undefined ? draftsFromModels([latest]).get(String(targetId)) : undefined)
          || draftsFromModels(written).get(String(targetId))
          || state.draft
        patch({
          notice: { kind: droppedDraftIds.length > 0 ? 'warn' : 'ok', text: droppedDraftIds.length > 0
            ? '已保存,但模型 ' + droppedDraftIds.join(', ') + ' 已被其他写者删除,对应修改未写入'
            : '已保存' },
          draft: freshDraft,
        })
      }
    } catch (error) {
      if (aliveRef.current) patch({ notice: { kind: 'error', text: error && error.message ? error.message : String(error) } })
    } finally {
      if (aliveRef.current) setSaving(false)
    }
  }

  if (state.phase === 'loading') {
    return h('div', { className: 'mce-inline' }, h('span', { className: 'mce-label' }, '正在读取模型声明…'))
  }
  if (state.phase === 'error') {
    return h('div', { className: 'mce-inline' }, h('span', { className: 'mce-notice mce-notice--error' }, state.notice))
  }
  if (state.phase === 'hidden') return null
  const draft = state.draft
  const editDraft = (part) => patch({ draft: { ...draft, ...part } })
  return h('div', { className: 'mce-inline' },
    h('div', { className: 'mce-inline__title' }, '模型能力(思考档位 / 输入模态)'),
    h('div', { className: 'mce-inline__grid' },
      EFFORT_LEVELS.map((level) => h('div', { className: 'mce-inline__field', key: level },
        h('label', null,
          h('input', {
            type: 'checkbox',
            disabled: saving,
            checked: draft.checked[level] === true,
            onChange: () => editDraft({ checked: { ...draft.checked, [level]: draft.checked[level] !== true } }),
          }),
          level,
        ),
        h('input', {
          type: 'text',
          className: 'mce-text',
          disabled: saving || draft.checked[level] !== true,
          value: draft.spellings[level] || '',
          placeholder: level === OFF_LEVEL ? '留空=不发送' : level,
          title: '发往网关的线上值',
          onChange: (event) => editDraft({ spellings: { ...draft.spellings, [level]: event.target.value } }),
        }),
      )),
    ),
    h('div', { className: 'mce-inline__field' },
      h('span', { className: 'mce-label' }, '输入模态:'),
      h('select', {
        className: 'mce-select',
        disabled: saving,
        value: draft.inputMode,
        onChange: (event) => editDraft({ inputMode: event.target.value }),
      }, INPUT_MODES.map((mode) => h('option', { key: mode, value: mode }, INPUT_MODE_LABELS[mode]))),
    ),
    h('div', { className: 'mce-inline__foot' },
      h('button', { className: 'mce-btn mce-btn--primary', disabled: saving, onClick: apply }, saving ? '保存中…' : '应用'),
      state.notice !== null
        ? h('span', { className: 'mce-notice mce-notice--' + state.notice.kind }, state.notice.text)
        : null,
    ),
  )
}

    return {
      inject: ['connection'],
      apply(ctx) {
        // connection 为 boot 期即时服务,apply 内即可取 wire 面;面缺失由
        // CapabilityCard load() 的降级分支呈现只读原因,不在渲染回调抛错。
        const settings = makeSettingsFace(ctx.connection.api.settings)

        // 行内注入器:MutationObserver 监听官方设置页,reconcile 把编辑块
        // 挂进已展开的模型行;官方结构变化导致锚点全失时,在模型页右侧注入
        // 浮动入口承载完整编辑卡,不再注册独立设置分区。
        const reactDom = require('react-dom')
        const roots = new Map()
        let piAiModelIds = new Set()
        let piAiRoutes = new Set()
        // 破坏闩锁:锚点破坏一经判定即置位,面板在模型页常驻,
        // 直到行内注入成功才解除——不随编辑器收起而丢失入口
        let anchorsLatched = false
        let scanPending = false
        // 轮次序号:describe 异步返回时已可能是过期快照,过期轮次不得改状态
        let reconcileSeq = 0
        // 插件存活代际:effect 清理后置位,排期中的扫描与在途 describe 续体
        // 不得再创建 React root(防清理后死注入与 root 泄漏)
        let disposed = false
        let scanTimer = null
        // 本实例代际号:样式属主判定用
        const instanceId = ++instanceSeq

        function docInfo() {
          const outlet = document.querySelector('[data-slot="settings.section"]')
          if (outlet === null) return null
          const heading = outlet.querySelector('h2')
          const title = heading !== null ? heading.textContent : null
          const titleMatched = isModelsTitle(title)
          const details = outlet.querySelector('details')
          const idInputs = titleMatched
            ? [...outlet.querySelectorAll('input[aria-label^="模型 ID"], input[aria-label^="Model ID"]')]
            : []
          return { outlet, titleMatched, hasEditor: details !== null, idInputs }
        }

        function entryOf(idInput) {
          const modelRow = idInput.closest('div')
          return modelRow !== null ? modelRow.parentElement : null
        }

        function mountRow(face, idInput) {
          const entry = entryOf(idInput)
          if (entry === null || entry.querySelector(':scope > .mce-inline-root') !== null) return false
          const details = idInput.closest('details')
          const editor = details !== null ? details.parentElement : null
          if (editor === null) return false
          const route = editor.firstElementChild !== null ? editor.firstElementChild.textContent : null
          const modelId = idInput.value
          if (route === null || modelId.length === 0) return false
          if (!piAiRoutes.has(route) || !piAiModelIds.has(modelId)) return false
          const container = document.createElement('div')
          container.className = 'mce-inline-root'
          entry.appendChild(container)
          const root = reactDom.createRoot(container)
          root.render(React.createElement(RowEditor, { settings: face, route, modelId, idInputEl: idInput }))
          roots.set(container, root)
          return true
        }

        // 样式表只注入一份,挂 document.head;dataset 记录属主代际,清理只移除自有样式,
        // 防旧实例晚于新实例卸载时把新实例在用的样式带走
        function ensureStyle() {
          if (document.getElementById('mce-style') !== null) return
          const style = document.createElement('style')
          style.id = 'mce-style'
          style.dataset.mceOwner = String(instanceId)
          style.textContent = CSS
          document.head.appendChild(style)
        }

        // 回退浮动入口:锚点破坏时挂在设置对话框内,含显隐开关与完整编辑卡
        let panel = null
        function disposePanel() {
          if (panel === null) return
          const { container, root } = panel
          panel = null
          root.unmount()
          container.remove()
        }
        function ensurePanel() {
          if (panel !== null) { panel.container.style.display = ''; return }
          // 只挂设置对话框: 同页可能并存多个对话框, 按设置区块特征挑容器, 无匹配则不挂
          const dialog = [...document.querySelectorAll('[role="dialog"]')]
            .find((node) => node.querySelector('[data-slot="settings.section"]') !== null)
          if (dialog === undefined) return
          ensureStyle()
          const container = document.createElement('div')
          container.className = 'mce-fallback-root'
          dialog.appendChild(container)
          const root = reactDom.createRoot(container)
          root.render(React.createElement(FallbackPanel, { settings }))
          panel = { container, root }
        }
        function hidePanel() {
          if (panel !== null) panel.container.style.display = 'none'
        }

        function reconcile() {
          if (disposed) return
          // 已脱离文档的挂载点:官方页卸载或重建了行,释放对应 root
          for (const [container, root] of roots) {
            if (!container.isConnected) {
              roots.delete(container)
              root.unmount()
            }
          }
          if (panel !== null && !panel.container.isConnected) disposePanel()
          const info = docInfo()
          if (info === null || !info.titleMatched) { hidePanel(); return }
          // S5:全部行均已挂载时零 RPC 早退,消灭注入容器自身触发的自激励扫描;
          // 全挂载即注入健康,必须复位闩锁并移除回退面板,否则恢复永远无法解除闩锁
          if (info.idInputs.length > 0 && info.idInputs.every((input) => {
            const entry = entryOf(input)
            return entry !== null && entry.querySelector(':scope > .mce-inline-root') !== null
          })) {
            anchorsLatched = false
            hidePanel()
            return
          }
          ensureStyle()
          const seq = ++reconcileSeq
          void (async () => {
            try {
              const value = unwrapResult(await settings.describe())
              if (disposed || seq !== reconcileSeq) return
              const ns = (value.namespaces || []).find((entry) => entry.ns === NS)
              if (ns === undefined) return
              const providers = ns.value && typeof ns.value === 'object' ? ns.value.providers : {}
              piAiRoutes = new Set(Object.keys(providers && typeof providers === 'object' ? providers : {}))
              piAiModelIds = new Set()
              for (const route of piAiRoutes) {
                for (const model of modelsOf(ns.value, route)) piAiModelIds.add(String(model.id))
              }
              let mounted = 0
              for (const idInput of info.idInputs) {
                if (mountRow(settings, idInput)) mounted += 1
              }
              if (mounted > 0) {
                anchorsLatched = false
                hidePanel()
              } else if (anchorsBroken({
                titleMatched: info.titleMatched,
                hasEditor: info.hasEditor,
                modelIdInputCount: info.idInputs.length,
              })) {
                anchorsLatched = true
              } else {
                anchorsLatched = false
              }
              if (anchorsLatched) ensurePanel(); else hidePanel()
            } catch {
              // describe 失败: 保持现状, 下次 mutation 重试; 闩锁已置位说明锚点破坏已判定,
              // 回退入口必须先出现, 数据加载失败由面板内部呈现
              if (!disposed && anchorsLatched) ensurePanel()
            }
          })()
        }

        function scheduleScan() {
          if (scanPending || disposed) return
          scanPending = true
          scanTimer = setTimeout(() => {
            scanPending = false
            // 以 outlet 存在为门,不假设设置页形态(对话框/抽屉/路由页都覆盖)
            if (document.querySelector('[data-slot="settings.section"]') !== null) reconcile()
          }, RECONCILE_DEBOUNCE_MS)
        }

        ctx.effect(() => {
          const observer = new MutationObserver(scheduleScan)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => {
            disposed = true
            if (scanTimer !== null) clearTimeout(scanTimer)
            observer.disconnect()
            for (const [container, root] of roots) {
              root.unmount()
              // 容器必须随 root 一起移除:残留空容器会让再注入被 mountRow 的
              // 已挂载守卫永久拒绝,且全挂载早退分支会误判注入健康
              container.remove()
              roots.delete(container)
            }
            disposePanel()
            // 样式与实例属主绑定:仅清理自有样式,防止带走后建实例的在用样式
            const style = document.getElementById('mce-style')
            if (style !== null && style.dataset.mceOwner === String(instanceId)) style.remove()
          }
        }, 'model-capability-editor: models-page injector')
      },
    }
  },
})
