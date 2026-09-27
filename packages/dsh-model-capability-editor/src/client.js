// 模型能力编辑 Client 半区:官方模型页行内注入,锚点破坏时浮动入口回退。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 与 require('react-dom/client') 由 DSH client
// runtime 的模块表解析(宿主种子一级键,缺失即整个宿主 UI 不存在,不降级)。
// 纯客户端零 host 端:读写经 remote.settings 服务的 describe/mutate RPC,
// 信封由 makeSettingsFace 适配为插件内部 RPC 面。
// 判定逻辑与 src/logic.mjs 为同一份(单文件自包含格式无法跨文件 require),
// 修改须两处同步。

// 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;键 = 市场短名(发现页
// 收录显示形态);该插件未就绪时入队,由其启动时排空
if (typeof window !== 'undefined') {
  const NAV_ICON = { 'dsh-model-capability-editor': 'cube' }
  if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
  else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
  else window.__navicIconQueue = [NAV_ICON]
}

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-model-capability-editor',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const { createRoot } = require('react-dom/client')

    // 面板反馈出口:公共依赖 @mzzsfy/dsh-toast,可选消费——占位条目由
    // session-manager 唯一代挂,权威方未安装时降级 console,不挂死不报错
    let toast = null
    try {
      toast = require('@mzzsfy/dsh-toast/client').show
    } catch {
      // 模块表无 toast → 反馈降级 console.warn
    }

    const notify = (text, kind) => {
      if (toast) toast(text, { kind: kind === 'ok' ? 'ok' : 'error' })
      else console.warn('[dsh-model-capability-editor] ' + text)
    }

    const RECONCILE_DEBOUNCE_MS = 150
    // 插件实例代际:宿主热重载/禁用重建时区分新旧实例,样式清理只认自有属主
    let instanceSeq = 0

    // 宿主代际判据:0.1.2+ 的 client-modules boot wire 带 batches 批次调度
    // (宿主 parseBootManifest 将其校验为必填数组,缺失即整页拒绝启动,判据
    // 被上游 schema 钉死);0.1.1 的 wire 无此字段。宿主未来若移除 batches,
    // 退化为 api 面或恒定禁用,不阻塞 boot
    const hasBatchesWire = typeof window !== 'undefined' && window.__DSH_BOOT__?.batches !== undefined

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
  // 开关:隐藏原生 checkbox,选中态 track 与 thumb 位移用过渡呈现
  '.mce-switch input[type="checkbox"] { position:absolute; opacity:0; width:0; height:0; }',
  '.mce-switch { display:inline-flex; align-items:center; cursor:pointer; }',
  '.mce-switch__track { position:relative; width:34px; height:19px; border-radius:999px; box-sizing:border-box; flex:none;',
  '  background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.35));',
  '  border:1px solid var(--dsw-alias-border-l2, var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)));',
  '  transition:background 0.15s, border-color 0.15s; }',
  '.mce-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%;',
  '  background:var(--dsw-alias-label-tertiary, rgba(128,128,128,0.6));',
  '  transform:translateY(-50%); transition:left 0.15s, background 0.15s; }',
  '.mce-switch:not(:has(input[type="checkbox"]:disabled)):hover .mce-switch__track { border-color:var(--dsw-alias-brand-primary, #4d6bfe); }',
  '.mce-switch input[type="checkbox"]:checked + .mce-switch__track { background:var(--dsw-alias-brand-primary, #4d6bfe); border-color:var(--dsw-alias-brand-primary, #4d6bfe); }',
  '.mce-switch input[type="checkbox"]:checked + .mce-switch__track .mce-switch__thumb { left:17px; background:var(--dsw-alias-bg-base, #fff); }',
  '.mce-switch input[type="checkbox"]:focus-visible + .mce-switch__track { outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset:1px; }',
  '.mce-switch input[type="checkbox"]:disabled + .mce-switch__track { opacity:0.45; cursor:default; }',
  '.mce-label { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.mce-notice { font-size:12px; padding:4px 8px; border-radius:6px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
  '.mce-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
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
  // 官方展开区是 auto-fit 网格:注入容器必须占满整行,不挤成单列
  '.mce-inline-root { grid-column: 1 / -1; }',
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

// 开关的 checkbox + 轨道对,checkbox 语义保留仅视觉隐藏
function switchToggle(props) {
  return [
    h('input', { type: 'checkbox', ...props }),
    h('span', { className: 'mce-switch__track' }, h('span', { className: 'mce-switch__thumb' })),
  ]
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
const INPUT_IMAGE = 'image-only'
const INPUT_MODES = [INPUT_UNSET, INPUT_TEXT, INPUT_TEXT_IMAGE, INPUT_IMAGE]
const INPUT_MODE_LABELS = {
  [INPUT_UNSET]: '未声明',
  [INPUT_TEXT]: '仅文本',
  [INPUT_TEXT_IMAGE]: '文本+图像',
  [INPUT_IMAGE]: '仅图片',
}
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

// input 数组 → 四态;未声明与空数组(schema 视为未回答)同为未声明;仅 image 为纯图像
function inputToMode(value) {
  if (!Array.isArray(value) || value.length === 0) return INPUT_UNSET
  const hasText = value.indexOf('text') >= 0
  const hasImage = value.indexOf('image') >= 0
  if (hasText) return hasImage ? INPUT_TEXT_IMAGE : INPUT_TEXT
  return hasImage ? INPUT_IMAGE : INPUT_UNSET
}

// 四态 → input 写回值(undefined = 删除字段)
function modeToInput(mode) {
  if (mode === INPUT_TEXT) return ['text']
  if (mode === INPUT_TEXT_IMAGE) return ['text', 'image']
  if (mode === INPUT_IMAGE) return ['image']
  return undefined
}

// 一键草稿填充:只动内存草稿,写回仍走显式保存。仅补"未勾选任何档位"的模型
// (即 reasoningEfforts 未声明的手声明模型,本插件核心场景):七档全勾、拼写
// 留空(线上值 = 档位名)。已编辑(有勾选)与 inputMode 一律不碰,防覆盖既有声明。
function fillDrafts(drafts, models) {
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
// 未触及判定以草稿冻结的加载时点种子(draft.seed)为参照(与 logic.mjs applyDraft 同步):
// 加载后他方修改基线时,零编辑与仅改单一字段的草稿不会把另一字段静默回滚;
// 无 seed 的裸草稿回退写回时点投影,与旧语义一致。
function applyDraft(model, draft) {
  const result = { ...model }
  // 无 seed 兜底 = 写回时点全投影(efforts + inputMode),与旧判定语义一致;
  // null 视同无 seed(与 draftEdited 的无种子判定同形,防 seed 守卫不对称)
  const seed = draft.seed !== undefined && draft.seed !== null
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

// 模型条目形态守卫(官方 schema 已拒绝非对象条目,防手写 yaml 旁路),判式同 detectCompetitorTraces
function isModelEntry(model) {
  return model !== null && typeof model === 'object'
}

// 整组写回:以 describe 读到的数组为基线,仅重写有草稿的条目,未声明模型不删除;
// 非对象条目原样透传。返回合并结果与未命中基线的草稿 id(模型已被他方删除,编辑未落盘)。
function mergeBaselineModels(baselineModels, draftsById) {
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

// 官方模型页标题标记(zh/en);精确匹配,防止误中本插件回退菜单的「模型能力」。
function isModelsTitle(title) {
  return title === '模型' || title === 'Models'
}

// 锚点破坏判定:模型页已打开且官方编辑器已展开,却找不到任何「模型 ID」输入,
// 说明官方 DOM 结构已变,行内注入失效,应回退独立菜单。
function anchorsBroken({ titleMatched, hasEditor, modelIdInputCount }) {
  return titleMatched === true && hasEditor === true && modelIdInputCount === 0
}

// 官方模型行展开区定位:官方把每行高级设置(上下文窗口/最大输出)渲染为行条目
// 内的条件块——行尾箭头(模型高级)点开才存在,收起即被官方整体移除。展开块 =
// 行条目内除行头以外的子元素;收起时官方不渲染该子元素,返回 null。
function advancedAreaChild(entryChildren, modelRow) {
  return entryChildren.find((child) => child !== modelRow) ?? null
}

// 保存随动:官方编辑卡「保存」按钮判定。EditorFooter 主按钮文案 zh=保存 / en=Apply,
// 精确匹配(busy 态与取消等其他文案不命中;disabled 不派发点击)。
const SAVE_BUTTON_LABELS = ['保存', 'Apply']
// busy 态文案:仅出现在保存按钮上。点击「保存」时官方处理器同步置 busy,事件冒泡
// 到文档级监听时 DOM 已被改写为 busy 文案,点击分类必须接受它才能识别保存点击。
const SAVE_BUTTON_BUSY_LABELS = ['保存中…', 'Applying…']

function isSaveButton(el) {
  return el !== null && typeof el === 'object' && el.tagName === 'BUTTON' &&
    SAVE_BUTTON_LABELS.indexOf(typeof el.textContent === 'string' ? el.textContent.trim() : '') >= 0
}

// 点击分类用的提交判定:空闲或 busy 态文案均视为保存按钮。
function isSaveCommitButton(el) {
  if (el === null || typeof el !== 'object' || el.tagName !== 'BUTTON') return false
  const label = typeof el.textContent === 'string' ? el.textContent.trim() : ''
  return SAVE_BUTTON_LABELS.indexOf(label) >= 0 || SAVE_BUTTON_BUSY_LABELS.indexOf(label) >= 0
}

// 草稿编辑判定:任一字段偏离冻结种子即已编辑;无种子的裸草稿保守按已编辑。
// 未编辑草稿不进随动快照:零差异整组写回既抬修订又产生误导性成功反馈。
function draftEdited(draft) {
  if (draft === null || typeof draft !== 'object') return false
  const seed = draft.seed
  if (seed === null || typeof seed !== 'object') return true
  return !draftMapsEqual(seed.checked, draft.checked) ||
    !draftMapsEqual(seed.spellings, draft.spellings) ||
    draft.inputMode !== seed.inputMode
}

// 保存随动快照:持久表条目({route, modelId, draft})→ 按路由分组的已编辑草稿表。
// 未编辑草稿与非对象条目剔除;草稿生命周期在注入器持久表,与行内块死活无关。
function collectSaveFollowDrafts(items) {
  const grouped = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object' || !draftEdited(item.draft)) continue
    const draftsById = grouped.get(item.route)
    if (draftsById === undefined) grouped.set(item.route, new Map([[String(item.modelId), item.draft]]))
    else draftsById.set(String(item.modelId), item.draft)
  }
  return grouped
}

// 补写就绪判定:已武装且全部武装卡已脱离文档。官方编辑卡保存成功必然卸载
// (applyOnce 成功即 onClose),卡卸载即"官方写入已落盘"信号;行收起不卸载卡,
// 官方校验失败/修订冲突时卡保持打开,均不补写。
function saveFollowReady(armed, isCardConnected) {
  if (armed === null || typeof armed !== 'object' || !Array.isArray(armed.cards)) return false
  return armed.cards.length > 0 && armed.cards.every((card) => isCardConnected(card) === false)
}

// 点击分类:仅"在册卡内的保存按钮"是武装性点击;其余一切点击(取消/编辑切换/
// 行收起/普通输入)都是解除性点击。这是"取消不写"契约的执行核心:官方保存失败
// (卡未关)后武装残留,必须靠失败后的下一次非保存点击解除,防取消/换卡被误判
// 为保存成功而补写。提交判定用 isSaveCommitButton:点击瞬间官方已同步置 busy,
// 冒泡到文档级时按钮文案已是「保存中…」。
function saveFollowArms(entries, button) {
  if (!isSaveCommitButton(button)) return false
  return (Array.isArray(entries) ? entries : []).some((entry) =>
    entry !== null && typeof entry === 'object' && entry.cardEl !== null &&
    typeof entry.cardEl === 'object' && typeof entry.cardEl.contains === 'function' &&
    entry.cardEl.contains(button))
}

// 解除允许判定:已武装且全部武装卡仍在文档。卡已全部卸载(保存流程已终局)后
// 的点击不得撤销待补写——保存成功关闭后用户的快速后续点击不丢写。
function saveFollowDismissible(armed, isCardConnected) {
  if (armed === null || typeof armed !== 'object' || !Array.isArray(armed.cards)) return false
  return armed.cards.length > 0 && armed.cards.every((card) => isCardConnected(card) === true)
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

function makeSettingsFace(transport) {
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
async function saveModels(settings, route, draftsById) {
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
function draftsFromModels(models) {
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
    EFFORT_LEVELS.map((level) => h('label', { className: 'mce-check mce-switch', key: level },
      ...switchToggle({ disabled, checked: draft.checked[level] === true, onChange: () => toggle(level) }),
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
  // 适配器:对外签名统一为 (id, draft),内部把行 id 绑定进回调,
  // 使 onChange 引用稳定(CapabilityCard 传 useCallback 的 editDraft),memo 才能命中
  const changeDraft = (next) => props.onChange(model.id, next)
  return h('div', { className: 'mce-model' },
    h('div', { className: 'mce-model__head' }, model.id, model.name && model.name !== model.id ? ' (' + model.name + ')' : ''),
    h('div', { className: 'mce-row' },
      h('span', { className: 'mce-label' }, '推理档位(勾选 = 提供,输入 = 线上拼写,留空 = 档位名):'),
      h(LevelEditor, { model, draft, disabled, onChange: changeDraft }),
    ),
    h('div', { className: 'mce-row' },
      h('span', { className: 'mce-label' }, '输入模态:'),
      h('select', {
        className: 'mce-select',
        disabled,
        value: draft.inputMode,
        onChange: (event) => changeDraft({ ...draft, inputMode: event.target.value }),
      }, INPUT_MODES.map((mode) => h('option', { key: mode, value: mode }, INPUT_MODE_LABELS[mode]))),
    ),
  )
}
// memo:单行编辑只重渲染该行(draft 引用仅变更行更新,onChange/useCallback 稳定)
const MemoModelRow = React.memo(ModelRow)

function CapabilityCard(props) {
  const [state, setState] = useState({ phase: 'loading', reason: null, providers: null, route: null, models: null, drafts: null, traces: null })
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

  function patch(part) { setState((prev) => ({ ...prev, ...(typeof part === 'function' ? part(prev) : part) })) }

  // 草稿编辑:函数式更新消渲染闭包旧值,稳定引用使 ModelRow memo 生效
  const editDraft = useCallback((id, draft) => {
    setState((prev) => {
      const drafts = new Map(prev.drafts)
      drafts.set(String(id), draft)
      return { ...prev, drafts }
    })
  }, [])

  async function load() {
    try {
      const settings = props.settings
      if (!settings || typeof settings.describe !== 'function') {
        patch({ phase: 'readonly', reason: 'remote.settings 服务面缺失,无法读写模型声明' })
        return
      }
      const value = await settings.describe()
      if (value.writable !== true) {
        patch({ phase: 'readonly', reason: 'settings 当前只读,模型能力编辑不可用' })
        return
      }
      const ns = findNsEntry(value)
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
        const value = await props.settings.describe()
        if (seq !== routeSeqRef.current) return
        const ns = findNsEntry(value)
        if (ns === undefined) {
          notify('settings 中不存在 ' + NS + ' 命名空间,请刷新页面', 'error')
          return
        }
        const models = modelsOf(ns.value, nextRoute)
        // 切回路由恢复未保存草稿;恢复桶以最新声明为底补齐缺失键(他方新增模型),
        // 保证 drafts 键集覆盖 models,渲染路径无需现场构造兜底对象(memo 引用稳定性)
        const restored = restoreDrafts(bucketsRef.current, nextRoute)
        const drafts = restored === null
          ? draftsFromModels(models)
          : (() => {
              const merged = draftsFromModels(models)
              for (const [id, draft] of restored) {
                if (merged.has(id)) merged.set(id, draft)
              }
              return merged
            })()
        draftsRouteRef.current = nextRoute
        patch({ models, drafts, traces: detectCompetitorTraces(models) })
      } catch (error) {
        // describe 失败:回滚路由,models/drafts 仍是旧路由数据,避免旧草稿对新基线静默写回
        if (seq === routeSeqRef.current) patch({ route: prevRoute })
        notify('读取 ' + nextRoute + ' 失败:' + (error && error.message ? error.message : String(error)), 'error')
      } finally {
        if (seq === routeSeqRef.current) setSwitching(false)
      }
    })()
  }

  async function save() {
    setSaving(true)
    try {
      const { models: written, droppedDraftIds } = await saveModels(props.settings, state.route, state.drafts)
      // 孤儿草稿:草稿对应模型已被他方删除,编辑未落盘,必须告警而非报成功
      notify(droppedDraftIds.length > 0
        ? '已保存,但模型 ' + droppedDraftIds.join(', ') + ' 已被其他写者删除,对应修改未写入'
        : '已保存并写回 settings.yaml', droppedDraftIds.length > 0 ? 'error' : 'ok')
      try {
        const value = await props.settings.describe()
        const ns = findNsEntry(value)
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
        notify('已保存,但刷新视图失败:' + (refreshError && refreshError.message ? refreshError.message : String(refreshError)), 'error')
      }
    } catch (error) {
      notify(error && error.message ? error.message : String(error), 'error')
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
    state.models.filter((model) => model !== null && typeof model === 'object').map((model) => h(MemoModelRow, {
      key: model.id,
      model,
      draft: state.drafts.get(String(model.id)),
      disabled: saving || switching,
      onChange: editDraft,
    })),
    state.models.filter((model) => model !== null && typeof model === 'object').length === 0
      ? h('div', { className: 'mce-label' }, '该 provider 暂无模型条目。')
      : null,
    h('div', { className: 'mce-row' },
      h('button', {
        className: 'mce-btn',
        disabled: saving || switching || state.route === null,
        onClick: () => {
          const filled = fillDrafts(state.drafts, state.models)
          let count = 0
          for (const [id, draft] of filled) {
            if (state.drafts.get(id) !== draft) count += 1
          }
          if (count > 0) {
            draftsRouteRef.current = state.route
            patch({ drafts: filled })
          }
          notify(count > 0
            ? '已为 ' + count + ' 个未声明档位的模型填充草稿(七档全勾、线上值=档位名),检查后手动保存'
            : '没有需要填充的模型:所有模型均已声明档位', count > 0 ? 'ok' : 'error')
        },
      }, '填充草稿'),
      h('span', { className: 'mce-label' }, '仅填内存草稿,写回仍需手动保存;已声明档位的模型不受影响。'),
    ),
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

// 行内编辑块:单个模型的档位与模态编辑,挂在官方模型行箭头点开的展开区内
// (官方条件渲染块,收起即随官方卸载)。无独立写入按钮,编辑随官方「保存」
// 一并写入(保存随动);官方保存按钮锚点失效时整块告警停用,防编辑后无法落盘。
function RowEditor(props) {
  const settings = props.settings
  const route = props.route
  const modelId = props.modelId
  const [state, setState] = useState({ phase: 'loading', draft: null, notice: null })

  // 保存随动:卡锚注册(armed 快照的卡元素来源);草稿生命周期在注入器持久表,
  // 每次编辑同步上报,行内块被官方重建后编辑不丢,重展开经 lookup 回显未落盘编辑
  const saveFollow = props.saveFollow
  useEffect(() => (saveFollow !== null ? saveFollow.watch() : undefined), [])

  function patch(part) { setState((prev) => ({ ...prev, ...part })) }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // 防御不对称补齐:CapabilityCard.load 有 face 守卫,此处缺失时裸 TypeError 呈英文原始消息
        if (!settings || typeof settings.describe !== 'function') {
          patch({ phase: 'error', notice: 'remote.settings 服务面缺失,无法读写模型声明' })
          return
        }
        const value = await settings.describe()
        const ns = findNsEntry(value)
        if (!alive) return
        if (ns === undefined) { patch({ phase: 'hidden' }); return }
        const model = modelsOf(ns.value, route).find((entry) => String(entry.id) === String(modelId))
        if (model === undefined) { patch({ phase: 'hidden' }); return }
        // 持久表里有本模型未落盘的编辑(块曾被官方重建)→ 回显之,防编辑静默丢失
        const persisted = saveFollow !== null ? saveFollow.lookup() : undefined
        const draft = persisted !== undefined
          ? persisted
          : draftsFromModels([model]).get(String(modelId))
        patch({ phase: 'ready', draft })
      } catch (error) {
        if (alive) patch({ phase: 'error', notice: error && error.message ? error.message : String(error) })
      }
    })()
    return () => { alive = false }
  }, [])

  if (state.phase === 'hidden') return null
  if (saveFollow === null) {
    return h('div', { className: 'mce-inline' },
      h('div', { className: 'mce-notice mce-notice--warn' },
        '未识别官方「保存」按钮(宿主界面可能已变更),行内编辑停用以免无法写入;可点右侧浮动「模型能力」卡编辑。'))
  }
  if (state.phase === 'loading') {
    return h('div', { className: 'mce-inline' }, h('span', { className: 'mce-label' }, '正在读取模型声明…'))
  }
  if (state.phase === 'error') {
    return h('div', { className: 'mce-inline' }, h('span', { className: 'mce-notice mce-notice--error' }, state.notice))
  }
  const draft = state.draft
  const editDraft = (part) => {
    const next = { ...draft, ...part }
    if (saveFollow !== null) saveFollow.report(next)
    patch({ draft: next })
  }
  return h('div', { className: 'mce-inline' },
    h('div', { className: 'mce-inline__title' }, '模型能力(思考档位 / 输入模态)'),
    h('div', { className: 'mce-inline__grid' },
      EFFORT_LEVELS.map((level) => h('div', { className: 'mce-inline__field', key: level },
        h('label', { className: 'mce-switch' },
          ...switchToggle({
            checked: draft.checked[level] === true,
            onChange: () => editDraft({ checked: { ...draft.checked, [level]: draft.checked[level] !== true } }),
          }),
          level,
        ),
        h('input', {
          type: 'text',
          className: 'mce-text',
          disabled: draft.checked[level] !== true,
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
        value: draft.inputMode,
        onChange: (event) => editDraft({ inputMode: event.target.value }),
      }, INPUT_MODES.map((mode) => h('option', { key: mode, value: mode }, INPUT_MODE_LABELS[mode]))),
    ),
  )
}

    return {
      // inject 按宿主代际二选一(判据 hasBatchesWire 见上):0.1.2+ 以点分
      // 声明交由 cordis 门控(fiber 等 namespace $mount 完成才激活,激活即
      // 就绪;不声明则点分读取永远抛错,实测);0.1.1 的 boot wire 无该
      // namespace,点分声明会永远 pending 拖垮整页 web boot
      // (assertEntriesActive 对 pending throw,实测),故声明两代都具备的
      // 基座服务,settings 传输在 apply 内异步定面轮询。
      inject: hasBatchesWire ? ['remote', 'remote.settings'] : ['remote', 'connection'],
      apply(ctx) {
        let settings = null

        // 行内注入器:MutationObserver 监听官方设置页,reconcile 把编辑块挂进
        // 已展开模型行的官方高级设置区(箭头点开的条件渲染块,收起即随官方卸载);
        // 官方结构变化导致锚点全失时,在模型页右侧注入浮动入口承载完整编辑卡,
        // 不再注册独立设置分区。
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

        // settings 面按代际取形:0.1.2+ 点分声明下 fiber 等挂载完成才激活,
        // apply 时已就绪,直接取形;0.1.1 无 typed 面,轮询从 api 相位起——
        // connection.api 面是 0.1.1 唯一 settings RPC 通道。两代路径对读取
        // 抛错/面缺失均收敛为恒定只读降级:定面完成前 settings 为 null,
        // reconcile 早退
        const FACE_POLL_INTERVAL_MS = 50
        // 等待窗:各代宿主上面在首拍即定型,窗口只是防御性上界,非真实时延
        const API_FACE_WAIT_MS = 1000
        const FACE_UNAVAILABLE_WARN = '[dsh-model-capability-editor] settings RPC 面不可用,编辑功能禁用'
        // 0.1.1 轮询:读取抛错(cordis get trap)与面缺失同义;窗口判定前置,
        // 任何路径都不绕过终止性——满窗即恒定禁用,不再重排
        const faceStartedAt = Date.now()
        const facePoll = () => {
          if (disposed) return
          const expired = Date.now() - faceStartedAt >= API_FACE_WAIT_MS
          try {
            settings = makeSettingsFace(ctx.connection)
            if (settings !== null) { scheduleScan(); return }
          } catch {
            // namespace/服务读取未就绪:按轮询节拍重试
          }
          if (expired) {
            console.warn(FACE_UNAVAILABLE_WARN)
            return
          }
          setTimeout(facePoll, FACE_POLL_INTERVAL_MS)
        }
        if (hasBatchesWire) {
          try {
            settings = makeSettingsFace(ctx.remote !== undefined ? ctx.remote.settings : undefined)
          } catch (error) {
            // 一次性终态判定,失败原因随告警留痕
            console.warn(FACE_UNAVAILABLE_WARN, error)
            settings = null
          }
          if (settings === null) console.warn(FACE_UNAVAILABLE_WARN)
          else scheduleScan()
        } else {
          facePoll()
        }

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

        function modelRowOf(idInput) {
          return idInput.closest('div')
        }

        function entryOf(idInput) {
          const modelRow = modelRowOf(idInput)
          return modelRow !== null ? modelRow.parentElement : null
        }

        // 官方行展开区(高级设置)解析:行头(模型 ID 所在行)的父容器即行条目,
        // 展开块是行条目内除行头外的子元素,仅在箭头点开后存在于 DOM。
        function advancedAreaOf(idInput) {
          const modelRow = modelRowOf(idInput)
          if (modelRow === null) return null
          return advancedAreaChild([...modelRow.parentElement.children], modelRow)
        }

        // 保存随动:官方「保存」点击武装(冻结已编辑草稿快照),编辑卡卸载后补写。
        // 官方 applyOnce 成功必然 onClose 卸载编辑卡,卡卸载即官方写入已落盘信号,
        // 插件在其新基线上字段级合并补写——官方先写、插件后写,混合编辑不撞修订锁。
        // 草稿生命周期在注入器持久表而非行内组件:官方会随时重建高级区,行内块随
        // 之生死,组件内存草稿活不到保存点击;每次编辑同步上报持久表,块死不丢。
        // 保存失败(校验/冲突)卡不关,武装残留由文档级点击分类解除:失败后的
        // 取消/换卡点击先解除武装并清持久表,卡再卸载就不满足补写就绪,"取消不写"
        // 由此保证。
        let saveFollowArmed = null
        const saveFollowEntries = new Set()
        const saveFollowDrafts = new Map()

        function reportSaveFollowDraft(route, modelId, draft) {
          saveFollowDrafts.set(route + '\n' + String(modelId), { route, modelId: String(modelId), draft })
        }

        function armSaveFollow() {
          const routes = collectSaveFollowDrafts([...saveFollowDrafts.values()])
          // 空快照 = 表内已无任何未落盘编辑(用户编辑后手动改回原状等),清表防陈旧条目滞留
          saveFollowArmed = null
          if (routes.size === 0) {
            saveFollowDrafts.clear()
            return
          }
          saveFollowArmed = { cards: [...saveFollowEntries].map((entry) => entry.cardEl), routes }
        }

        function fireSaveFollow() {
          const armed = saveFollowArmed
          if (armed === null) return
          saveFollowArmed = null
          void (async () => {
            for (const [route, draftsById] of armed.routes) {
              // 实例终止(禁用/热重载)后不得继续补写 RPC
              if (disposed) return
              try {
                const { droppedDraftIds } = await saveModels(settings, route, draftsById)
                for (const modelId of draftsById.keys()) saveFollowDrafts.delete(route + '\n' + modelId)
                notify(droppedDraftIds.length > 0
                  ? '已随「保存」写入,但模型 ' + droppedDraftIds.join(', ') + ' 已被其他写者删除,对应修改未写入'
                  : '已随「保存」一并写入模型能力声明', droppedDraftIds.length > 0 ? 'error' : 'ok')
              } catch (error) {
                notify('随「保存」写入模型能力失败:' + (error && error.message ? error.message : String(error)), 'error')
              }
            }
          })()
        }

        // 行条目随动注册:向上定位承载官方「保存」按钮的编辑卡元素作为该行的
        // 武装锚,点击分类由文档级监听统一裁决。定位接受 busy 态文案(官方保存
        // 进行中时高级区仍可能被重建重挂),并排除插件自有按钮防锚点漂移到回退
        // 面板;锚点失效(定位不到官方提交键)时返回 null,行内块告警停用,防编
        // 辑后无法落盘
        function rowSaveFollow(container, route, modelId) {
          const isOfficialCommit = (button) => isSaveCommitButton(button) &&
            button.closest('.mce-fallback-root, .mce-card') === null
          let cardEl = container.parentElement
          while (cardEl !== null && cardEl !== document.body &&
            !Array.prototype.some.call(cardEl.querySelectorAll('button'), isOfficialCommit)) {
            cardEl = cardEl.parentElement
          }
          if (cardEl === null || cardEl === document.body) return null
          const entry = { cardEl }
          return {
            // 卡锚注册:armed 快照的卡元素来源,编辑卡卸载即注销
            watch() {
              saveFollowEntries.add(entry)
              return () => { saveFollowEntries.delete(entry) }
            },
            // 编辑上报:草稿写入注入器持久表,行内块被官方重建后编辑不丢
            report(draft) { reportSaveFollowDraft(route, modelId, draft) },
            // 回显:重展开行时若持久表还有未落盘的本模型编辑,以其为初值而非基线
            lookup() { return saveFollowDrafts.get(route + '\n' + String(modelId))?.draft },
          }
        }

        function mountRow(face, idInput) {
          const details = idInput.closest('details')
          const editor = details !== null ? details.parentElement : null
          if (editor === null) return false
          const route = editor.firstElementChild !== null ? editor.firstElementChild.textContent : null
          const modelId = idInput.value
          if (route === null || modelId.length === 0) return false
          // rc.3 卡头把显示名与 provider id 放进同一块,route 文本为「名称id」拼接;
          // 匹配放宽为全等或以 provider 键结尾(alpha.2 纯键形态全等仍命中)
          const matchedRoute = piAiRoutes.has(route) ? route : [...piAiRoutes].find((key) => route.endsWith(key))
          if (matchedRoute === undefined || !piAiModelIds.has(modelId)) return false
          // 面板只挂官方展开区:箭头未点开时官方 DOM 无展开块,不注入;展开块随
          // 箭头收起被官方整体移除,面板由 reconcile 的孤儿清理随之释放,无从常驻
          const advanced = advancedAreaOf(idInput)
          if (advanced === null || advanced.querySelector(':scope > .mce-inline-root') !== null) return false
          const container = document.createElement('div')
          container.className = 'mce-inline-root'
          advanced.appendChild(container)
          const root = createRoot(container)
          root.render(React.createElement(RowEditor, {
            settings: face,
            route: matchedRoute,
            modelId,
            saveFollow: rowSaveFollow(container, matchedRoute, modelId),
          }))
          roots.set(container, root)
          return true
        }

        // 样式表只注入一份,挂 document.head;dataset 记录属主代际,清理只移除自有样式,
        // 防旧实例晚于新实例卸载时把新实例在用的样式带走
        function ensureStyle() {
          if (document.getElementById('mce-style') !== null) return
          const style = document.createElement('style')
          style.id = 'mce-style'
          // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-model-capability-editor')
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
          const root = createRoot(container)
          root.render(React.createElement(FallbackPanel, { settings }))
          panel = { container, root }
        }
        function hidePanel() {
          if (panel !== null) panel.container.style.display = 'none'
        }

        function reconcile() {
          if (disposed) return
          // 定面未完成:不做任何 RPC 与注入,面就绪后 scheduleScan 会再触发
          if (settings === null) return
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
          // 代际先行:任何一轮判定(含同步早退/闩锁)都作废在途 describe 续体,
          // 防 stale 续体以旧 DOM 快照 mountRow 或清掉新近判定的闩锁
          const seq = ++reconcileSeq
          // S5:每行都处于与箭头一致的正确挂载态时零 RPC 早退,消灭注入容器自身
          // 触发的自激励扫描;正确态 = 行展开(官方展开块在场)须已挂面板、行收起
          // (展开块已被官方移除)须零残留,结构异常不视为健康(fail-closed)。
          // 正确即注入健康,必须复位闩锁并移除回退面板,否则恢复永远无法解除闩锁
          if (info.idInputs.length > 0 && info.idInputs.every((input) => {
            const advanced = advancedAreaOf(input)
            if (advanced !== null) return advanced.querySelector(':scope > .mce-inline-root') !== null
            const entry = entryOf(input)
            return entry !== null && entry.querySelector('.mce-inline-root') === null
          })) {
            anchorsLatched = false
            hidePanel()
            return
          }
          ensureStyle()
          // 锚点破坏同步判定提前到 describe 之前:判定输入(titleMatched/hasEditor/idInputs)
          // 全部来自 describe 前的同一 DOM 快照,编辑器未展开(idInputs 为空)时无需发起
          // 全量 RPC 即可闩锁/复位,消灭闩锁期间每次 mutation 触发的 describe 放大
          if (anchorsBroken({
            titleMatched: info.titleMatched,
            hasEditor: info.hasEditor,
            modelIdInputCount: info.idInputs.length,
          })) {
            anchorsLatched = true
            ensurePanel()
            return
          }
          void (async () => {
            try {
              const value = await settings.describe()
              if (disposed || seq !== reconcileSeq) return
              const ns = findNsEntry(value)
              if (ns === undefined) return
              const providers = ns.value && typeof ns.value === 'object' ? ns.value.providers : {}
              piAiRoutes = new Set(Object.keys(providers && typeof providers === 'object' ? providers : {}))
              piAiModelIds = new Set()
              for (const route of piAiRoutes) {
                for (const model of modelsOf(ns.value, route)) piAiModelIds.add(String(model.id))
              }
              for (const idInput of info.idInputs) {
                mountRow(settings, idInput)
              }
              // 锚点破坏已在 describe 前同步闩锁;此处 describe 后仅做解闩与面板收放
              anchorsLatched = false
              hidePanel()
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
            // 保存随动补写先于分区门:官方保存成功关闭编辑卡(乃至整个设置分区)
            // 本身就是 mutation,武装卡此刻已全部脱离文档,补写不得被门挡住
            if (saveFollowReady(saveFollowArmed, (card) => card.isConnected)) fireSaveFollow()
            // 以 outlet 存在为门,不假设设置页形态(对话框/抽屉/路由页都覆盖)
            if (document.querySelector('[data-slot="settings.section"]') !== null) reconcile()
            else if (saveFollowArmed === null && saveFollowDrafts.size > 0) saveFollowDrafts.clear()
          }, RECONCILE_DEBOUNCE_MS)
        }

        ctx.effect(() => {
          const observer = new MutationObserver(scheduleScan)
          observer.observe(document.body, { childList: true, subtree: true })
          // 保存随动点击分类:武装性点击(在册卡内的保存按钮)武装;其余点击在
          // 武装卡仍在文档时解除武装(取消/换卡不写)。卡已全部卸载后的点击不
          // 解除——保存成功关闭后的快速后续点击不丢写
          const onDocClick = (event) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null
            if (saveFollowArms([...saveFollowEntries], button)) armSaveFollow()
            else if (saveFollowDismissible(saveFollowArmed, (card) => card.isConnected)) {
              // 解除即放弃:取消/换卡点击同时丢弃持久表草稿(取消不写)
              saveFollowArmed = null
              saveFollowDrafts.clear()
            }
          }
          // Escape 关设置面板不派发 click(宿主 SettingsPanel 的 document 级 keydown
          // 直连 onClose),必须同路解除,否则"保存失败后按 ESC"会被误判为保存成功
          const onDocKeyDown = (event) => {
            if (event.key !== 'Escape') return
            if (saveFollowDismissible(saveFollowArmed, (card) => card.isConnected)) {
              saveFollowArmed = null
              saveFollowDrafts.clear()
            }
          }
          document.addEventListener('click', onDocClick)
          document.addEventListener('keydown', onDocKeyDown)
          return () => {
            disposed = true
            // 随动武装与持久草稿随实例终止:禁用/热重载后不得再发起补写 RPC
            saveFollowArmed = null
            saveFollowDrafts.clear()
            document.removeEventListener('click', onDocClick)
            document.removeEventListener('keydown', onDocKeyDown)
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
