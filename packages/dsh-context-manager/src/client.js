// dsh-context-manager Client 半区:「插件」设置页可配置卡片(四启停开关)
// + 历史输入浮层(Alt+↑ 唤起,范围导航/搜索/收藏回填) + 插话撤回 + 对话 fork。
// 历史输入挂官方 conversation.input.dock 插槽(渲染为零高度锚点),回填走宿主公共
// 契约 inputActions.setDraft;插话撤回注入官方 pending steering 气泡操作图标排;
// fork 注入消息气泡操作排,分叉到该轮之前并把该轮用户输入回填子会话输入框(重试
// 语义),RPC 走宿主 sessions 服务面(fork+open),锚点经 remote.session.follow
// 开场帧建立轮号→{ 结束 seq, 首问文本 } 映射。浏览器半区经 webServer 路由
// ('/api/context/*')访问 Host。打包为单文件自包含格式,无法跨文件 require;
// 与 src/core.mjs 镜像的纯函数(filterHistoryInputs/forkFailureText/forkRetryText)
// 修改需两处同步。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-context-manager',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;键 = 市场短名(发现页
    // 收录显示形态);该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { 'dsh-context-manager': 'git' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    // 通知出口:公共依赖 @mzzsfy/dsh-toast 可选消费(占位条目全仓唯一,由
    // dsh-session-manager 代挂;模块表缺失或导出缺 show 即通知通道置空)
    let toast = () => {}
    try {
      toast = require('@mzzsfy/dsh-toast/client').show || (() => {})
    } catch {
      toast = () => {}
    }

const CSS = [
  // 家族版本环:操作排内 ‹n/m›,按钮克隆官方类名自带尺寸,环容器只负责排版与留隙
  '.cx-family-ring { display:inline-flex; align-items:center; gap:2px; margin:0 2px; opacity:.85; }',
  '.cx-family-ring > span { font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:var(--dsw-alias-label-caption, rgba(127,127,127,.9)); min-width:24px; text-align:center; }',
  // 开关行(规约 switch 形态):track 胶囊 + thumb 圆点,状态选择器锚定 checkbox
  '.cx-switch { display:inline-flex; align-items:center; gap:8px; margin-top:10px; cursor:pointer;',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:var(--dsw-alias-label-caption, rgba(127,127,127,.9)); }',
  '.cx-switch input[type="checkbox"] { position:absolute; width:1px; height:1px; margin:-1px; opacity:0; }',
  '.cx-switch__track { position:relative; flex:none; width:28px; height:16px; border-radius:999px;',
  '  background:light-dark(rgba(15,17,21,.22), rgba(255,255,255,.26)); transition:background .15s; }',
  '.cx-switch__thumb { position:absolute; left:2px; top:2px; width:12px; height:12px; border-radius:999px;',
  '  background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25); transition:transform .15s; }',
  '.cx-switch input[type="checkbox"]:checked + .cx-switch__track { background:#1677ff; }',
  '.cx-switch input[type="checkbox"]:checked + .cx-switch__track .cx-switch__thumb { transform:translateX(12px); }',
  '.cx-switch input[type="checkbox"]:focus-visible + .cx-switch__track { outline:2px solid #1677ff; outline-offset:1px; }',
  '.cx-switch:hover { color:var(--dsw-alias-label-primary, inherit); }',
  '@media (prefers-reduced-motion: reduce) { .cx-switch__track, .cx-switch__thumb { transition:none; } }',
  // 设置分区容器
  '.cx-panel { display:flex; flex-direction:column; gap:2px; align-items:flex-start; min-width:0;',
  '  color:var(--dsw-alias-label-primary); font:var(--dsw-font-s-14); }',
  '.cx-panel__title { margin:0 0 2px; font:var(--dsw-font-m-16, 600 16px/24px sans-serif); font-weight:600; }',
  '.cx-panel__hint { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-caption); margin-bottom:4px; }',
  // 历史输入:零高度锚点容器 + 浮层(Alt+↑ 唤起);浮层与输入框同宽对齐,
  // 不透明实底 + 宿主同款卡片投影,与消息流明确区隔。
  // 色值取自宿主实测(白底卡片/墨色文字/蓝色强调):dsw alias 变量在宿主为空,不可依赖
  '.cx-hist { position:relative; height:0; }',
  // z-index 须高于同插槽兄弟浮层(sm-hist 同为 50,DOM 序靠前时会被其盖住)
  '.cx-hist__pop { position:absolute; left:0; right:0; bottom:10px; z-index:' + (50 + 1) + ';',
  '  max-height:min(420px, 46vh); display:flex; flex-direction:column; overflow:hidden;',
  '  color-scheme:light dark; color:light-dark(#0f1115, #e8eaed);',
  '  background:light-dark(#fff, #1e1f22); border-radius:14px;',
  '  box-shadow:0 0 0 0.5px light-dark(rgba(15,17,21,.18), rgba(255,255,255,.14)), 0 4px 16px rgba(0,0,0,.08), 0 16px 48px rgba(0,0,0,.16); }',
  '.cx-hist__hint { display:flex; align-items:center; gap:10px; padding:9px 14px; flex:none;',
  '  border-bottom:1px solid light-dark(rgba(15,17,21,.08), rgba(255,255,255,.1));',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55)); }',
  '.cx-hist__scope { padding:2px 10px; border-radius:999px; flex:none;',
  '  background:#1677ff; color:#fff; font-weight:600; }',
  '.cx-hist__search { flex:1; min-width:0; padding:3px 10px; border-radius:8px; color-scheme:light dark;',
  '  border:1px solid light-dark(rgba(15,17,21,.14), rgba(255,255,255,.18));',
  '  background:transparent; color:inherit; font:var(--dsw-font-xxs-12, 12px/18px sans-serif); }',
  '.cx-hist__search:focus { outline:2px solid #1677ff; outline-offset:-1px; }',
  '.cx-hist__count { flex:none; font:12px/18px var(--ds-font-family-code, monospace);',
  '  color:light-dark(rgba(15,17,21,.4), rgba(232,234,237,.4)); font-variant-numeric:tabular-nums; }',
  '.cx-hist__list { overflow-y:auto; padding:6px; }',
  '.cx-hist__row { position:relative; display:flex; align-items:center; gap:10px; width:100%; border:0;',
  '  background:transparent; cursor:pointer; text-align:left; padding:8px 12px 8px 14px;',
  '  border-radius:8px; min-width:0; }',
  '.cx-hist__row:hover { background:light-dark(rgba(15,17,21,.05), rgba(255,255,255,.07)); }',
  '.cx-hist__row--on, .cx-hist__row--on:hover { background:light-dark(rgba(22,119,255,.1), rgba(22,119,255,.22)); }',
  '.cx-hist__row--on::before { content:""; position:absolute; left:0; top:6px; bottom:6px; width:3px;',
  '  border-radius:2px; background:#1677ff; }',
  '.cx-hist__row--on .cx-hist__text { color:#1677ff; font-weight:600; }',
  '.cx-hist__row:focus-visible { outline:2px solid #1677ff; outline-offset:-2px; }',
  '.cx-hist__text { flex:1; min-width:0; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.cx-hist__time { font:12px/18px var(--ds-font-family-code, monospace);',
  '  color:light-dark(rgba(15,17,21,.4), rgba(232,234,237,.4));',
  '  font-variant-numeric:tabular-nums; flex:none; }',
  '.cx-hist__star { border:0; background:transparent; cursor:pointer; flex:none;',
  '  font-size:15px; line-height:1; padding:2px 4px; border-radius:6px;',
  '  color:light-dark(rgba(15,17,21,.35), rgba(232,234,237,.35));',
  '  opacity:0; transition:opacity .12s; }',
  '.cx-hist__row:hover .cx-hist__star, .cx-hist__star:focus-visible { opacity:1; }',
  '.cx-hist__star--on { opacity:1; color:#f5a623; }',
  '.cx-hist__star:hover { color:#f5a623; }',
  '.cx-hist__editbtn { border:0; background:transparent; cursor:pointer; flex:none; padding:2px 8px;',
  '  border-radius:999px; font:12px/18px sans-serif; font-weight:600;',
  '  color:#1677ff; background:light-dark(rgba(22,119,255,.1), rgba(22,119,255,.22)); }',
  '.cx-hist__editbtn:hover { background:light-dark(rgba(22,119,255,.18), rgba(22,119,255,.3)); }',
  '.cx-hist__editwrap { display:flex; flex-direction:column; flex:1; min-height:0; }',
  '.cx-hist__editwrap .cx-hist__list { flex:1; min-height:0; }',
  '.cx-hist__editrow { display:flex; align-items:center; gap:6px; padding:4px 8px; }',
  '.cx-hist__editinput { flex:1; min-width:0; border:1px solid light-dark(rgba(15,17,21,.14), rgba(255,255,255,.18));',
  '  border-radius:8px; padding:6px 10px; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:inherit; background:transparent; }',
  '.cx-hist__editinput:focus { outline:2px solid #1677ff; outline-offset:-1px; }',
  '.cx-hist__del { border:0; background:transparent; cursor:pointer; flex:none;',
  '  font-size:16px; line-height:1; padding:2px 8px; border-radius:6px;',
  '  color:light-dark(rgba(15,17,21,.45), rgba(232,234,237,.45)); }',
  '.cx-hist__del:hover { color:#e5484d; }',
  '.cx-hist__addrow { display:flex; gap:6px; padding:8px; flex:none;',
  '  border-top:1px solid light-dark(rgba(15,17,21,.08), rgba(255,255,255,.1)); }',
  '.cx-hist__empty { padding:24px 14px; text-align:center; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.5), rgba(232,234,237,.5)); }',
  '.cx-hist__banner { padding:7px 14px; flex:none; text-align:center; font:var(--dsw-font-xxs-12, 12px/18px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55));',
  '  background:light-dark(rgba(15,17,21,.04), rgba(255,255,255,.06)); }',
  // 插话撤回 / fork:注入官方操作图标排,样式经克隆官方按钮类名原生同款;
  // dock 本体零 DOM,仅承载注入逻辑
  '.cx-steer-host { display:none; }',
  '.cx-fork-host { display:none; }',
].join('\n')

const INPUTS_URL = '/api/context/inputs'
const PROMPTS_TOGGLE_URL = '/api/context/prompts/toggle'
const HISTORY_ENABLED_URL = '/api/context/history-enabled'
const STEER_ENABLED_URL = '/api/context/steer-recall-enabled'
const FORK_ENABLED_URL = '/api/context/fork-enabled'
const FORK_AUTO_RESEND_URL = '/api/context/fork-auto-resend-enabled'

// 请求默认超时:host 被批量解压等同步任务阻塞时路由会迟滞数秒,
// 无超时则浮层停在「正在读取…」假死;超时按错误抛出,由调用方兜底,
// 轮询链继续,host 恢复后自动跟上
const API_TIMEOUT_MS = 8 * 1000

async function api(url, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      ...options,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
    return payload
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('响应超时(' + Math.round(API_TIMEOUT_MS / 1000) + 's),宿主繁忙中')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function h(type, props) {
  const children = Array.prototype.slice.call(arguments, 2)
  return React.createElement.apply(React, [type, props || null].concat(children))
}

function fmtTime(ms) {
  const t = Number(ms)
  if (t !== t || !t) return '—'
  const d = new Date(t)
  const pad = (n) => (n < 10 ? '0' : '') + n
  const date = d.getFullYear() === new Date().getFullYear()
    ? pad(d.getMonth() + 1) + '/' + pad(d.getDate())
    : d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate())
  return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 历史范围:按 ←/→ 切换序排列(索引 0 为常用提示词个人收藏,1 为当前会话默认落点,
// → 向更大范围,← 返回收藏);与 host core.mjs HISTORY_SCOPES 镜像,parity 测试锁定
const HISTORY_SCOPES = ['prompts', 'session', 'workspace', 'global']
const HISTORY_SCOPE_LABELS = ['常用', '当前会话', '本工作区', '全部工作区']
const HISTORY_SCOPE_DEFAULT = HISTORY_SCOPES.indexOf('session')
// 浮层打开期间固定轮询节奏:host 侧对齐是异步的,数据可能晚于首次响应到达
const HISTORY_REPULL_MS = 3 * 1000

// 历史浮层搜索镜像(与 core.mjs filterHistoryInputs 同步维护):
// 查询词去首尾空白后按不区分大小写子串匹配,空查询原样返回全量
function filterHistoryInputs(entries, query) {
  const list = Array.isArray(entries) ? entries : []
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return list
  return list.filter((entry) => String((entry && entry.text) ?? '').toLowerCase().includes(needle))
}

// fork 错误文案映射镜像(与 core.mjs forkFailureText 同步维护)
function forkFailureText(code) {
  if (code === 'session/fork-unavailable') return '该轮尚未完成,不可分叉'
  if (code === 'session/workspace-attach-failed') return '分叉成功,但挂载到工作区失败'
  return '分叉失败: ' + String(code ?? '未知错误')
}

// fork 重试文本提取镜像(与 core.mjs forkRetryText 同步维护):
// 仅用户本人消息,文本块按行拼接;空白/纯图返回 null——无法重试的轮不注入按钮
function forkRetryText(data) {
  const message = data && typeof data === 'object' ? data : {}
  if (!message.source || message.source.kind !== 'user') return null
  const text = (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && block.text !== '')
    .map((block) => block.text)
    .join('\n')
  return text.trim() === '' ? null : text
}

// 家族谱系投影镜像(与 core.mjs sessionFamilyMap/familyRing 同步维护):
// 快照行主键为 id、父引用为 parentId(与 RPC wire 的 sessionId/parentSessionId 不同名),
// 断链视为独立根;环序按 updatedAt 升序
function sessionFamilyMap(items) {
  const byId = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const id = item && item.id
    if (typeof id === 'string' && id !== '') byId.set(id, item)
  }
  const chains = new Map()
  for (const id of byId.keys()) {
    const chain = []
    let cursor = id
    let root = cursor
    while (cursor !== undefined) {
      chain.unshift(cursor)
      root = cursor
      const parent = byId.get(cursor)
      cursor = parent && typeof parent.parentId === 'string' && byId.has(parent.parentId)
        ? parent.parentId
        : undefined
      if (chain.includes(cursor)) break
    }
    chains.set(id, { root, chain, item: byId.get(id) })
  }
  return chains
}

function familyRing(chains, sessionId) {
  const entry = chains instanceof Map ? chains.get(sessionId) : undefined
  if (!entry) return null
  const members = [...chains.entries()]
    .filter(([, value]) => value.root === entry.root)
    .sort((left, right) => {
      const at = (record) => (record && record.item && typeof record.item.updatedAt === 'number' ? record.item.updatedAt : 0)
      return at(left[1]) - at(right[1])
    })
    .map(([id]) => id)
  if (members.length < 2) return null
  return { index: members.indexOf(sessionId) + 1, total: members.length, members }
}

function HistoryDock({ session, inputActions }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(-1)
  const [scopeIndex, setScopeIndex] = useState(HISTORY_SCOPE_DEFAULT)
  const [aligning, setAligning] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // 收藏集合:浮层打开时并行拉一次,行悬停星标据此显示实/空心;
  // editing 仅常用范围可进入(行内改/删 + 底部新增)
  const [collected, setCollected] = useState(() => new Set())
  const [editing, setEditing] = useState(false)
  // 搜索:query 驱动渲染,原始条目存 rawRef,items 恒为过滤后列表;
  // 组合输入(IME)期间不过滤,上屏后才应用
  const [query, setQuery] = useState('')
  const composingRef = useRef(false)
  const rootRef = React.useRef(null)
  // 键盘层权威状态:监听器挂载一次(空依赖),读写全走 ref,规避 effect 重挂
  // 时序造成的闭包陈旧;state 仅驱动渲染,变更处双写
  const viewRef = React.useRef({ open: false, items: null, cursor: -1, scopeIndex: 0, aligning: false })
  const sessionRef = React.useRef(session)
  const inputActionsRef = React.useRef(inputActions)
  const rawItemsRef = React.useRef(null)
  const queryRef = React.useRef('')
  // 历史浮层启停(设置开关):挂载拉取一次,停用即整体不渲染、键盘放行
  const enabledRef = React.useRef(true)
  const [historyEnabled, setHistoryEnabled] = useState(true)
  sessionRef.current = session
  inputActionsRef.current = inputActions
  useEffect(() => {
    api(HISTORY_ENABLED_URL)
      .then((payload) => {
        const on = payload ? payload.enabled !== false : true
        enabledRef.current = on
        setHistoryEnabled(on)
      })
      .catch(() => {})
  }, [])

  function syncView(patch) {
    viewRef.current = { ...viewRef.current, ...patch }
  }

  // 应用搜索词:原始条目重新过滤并重置光标(过滤后集合上的选择位无意义)
  function applyFilter(next) {
    queryRef.current = next
    const raw = rawItemsRef.current
    const displayed = raw === null ? null : filterHistoryInputs(raw, next)
    syncView({ items: displayed, cursor: -1 })
    setItems(displayed)
    setCursor(-1)
  }

  // host 响应信封 { inputs, aligned };解包并防御形态漂移,消费侧恒为数组。
  // aligned=false 表示工作区缓存尚未建立(首次),host 已在后台对齐
  function fetchInputs(scope) {
    return api(INPUTS_URL + '?sessionId=' + encodeURIComponent(sessionRef.current.sessionId) + '&scope=' + scope)
      .then((payload) => ({
        inputs: (payload && Array.isArray(payload.inputs)) ? payload.inputs : [],
        aligned: Boolean(payload && payload.aligned),
      }))
  }

  // 收藏集合与浮层列表共用 inputs 路由(scope=prompts),毫秒级缓存读
  function refreshCollected() {
    return api(INPUTS_URL + '?sessionId=' + encodeURIComponent(sessionRef.current.sessionId) + '&scope=prompts')
      .then((payload) => {
        const list = payload && Array.isArray(payload.inputs) ? payload.inputs : []
        setCollected(new Set(list.map((item) => item.text)))
      })
      .catch(() => {})
  }

  // 收藏切换:行悬停星标与编辑态删除共用;成功后同步星标集,
  // 当前正处于常用范围时立即重拉列表(不等轮询)
  function togglePrompt(text) {
    return api(PROMPTS_TOGGLE_URL, { method: 'POST', body: JSON.stringify({ text }) })
      .then((payload) => {
        const on = Boolean(payload && payload.collected)
        toast(on ? '已收藏到常用' : '已取消收藏')
        setCollected((prev) => {
          const next = new Set(prev)
          if (on) next.add(text)
          else next.delete(text)
          return next
        })
        if (viewRef.current.open && viewRef.current.scopeIndex === HISTORY_SCOPES.indexOf('prompts')) requestScope(viewRef.current.scopeIndex)
        return on
      })
  }

  // 编辑态改文本 = 移除旧文本 + 收藏新文本(两次 toggle 原子性由"同文本去重"保证:
  // 中断最坏留下旧文本,重改一次即自愈)
  function renamePrompt(from, to) {
    return togglePrompt(from)
      .then(() => (to === '' ? Promise.resolve() : togglePrompt(to)))
  }

  // 应用一次响应:仅当范围未变时生效,防止快速切范围后迟到响应覆盖新范围。
  // 原始条目深度不变的重复响应不重置光标(轮询期间保持用户选位);
  // 落地后经当前搜索词过滤再呈现
  function applyResult(scopeIdx, result) {
    if (viewRef.current.scopeIndex !== scopeIdx) return
    const prev = rawItemsRef.current
    if (prev !== null && JSON.stringify(prev) === JSON.stringify(result.inputs)) {
      syncView({ aligning: !result.aligned })
      setAligning(!result.aligned)
      return
    }
    rawItemsRef.current = result.inputs
    syncView({ aligning: !result.aligned })
    setAligning(!result.aligned)
    applyFilter(queryRef.current)
  }

  // 浮层打开期间固定节奏轮询当前范围:host 侧对齐/焦点对齐是异步的,
  // 数据可能晚于首次响应到达,一次性重拉预算耗尽后迟到的数据将永不出现
  // (实机验证实测:API 已就绪而浮层停在旧列表)。轮询开销为毫秒级缓存读;
  // 请求失败(含超时)也保持轮询,host 恢复后列表自愈,不假死
  function requestScope(scopeIdx) {
    const scope = HISTORY_SCOPES[scopeIdx]
    const scheduleNext = () => {
      if (!viewRef.current.open || viewRef.current.scopeIndex !== scopeIdx) return
      setTimeout(() => {
        if (viewRef.current.open && viewRef.current.scopeIndex === scopeIdx) requestScope(scopeIdx)
      }, HISTORY_REPULL_MS)
    }
    fetchInputs(scope)
      .then((result) => {
        applyResult(scopeIdx, result)
        scheduleNext()
      })
      .catch((error) => {
        if (viewRef.current.scopeIndex !== scopeIdx) return
        rawItemsRef.current = []
        syncView({ items: [] })
        setLoadError(true)
        setItems([])
        toast(error && error.message ? error.message : String(error), { kind: 'error' })
        scheduleNext()
      })
  }

  function fill(text) {
    inputActionsRef.current.setDraft(text)
    syncView({ open: false })
    setOpen(false)
  }

  function openPopup() {
    rawItemsRef.current = null
    queryRef.current = ''
    setQuery('')
    syncView({ open: true, items: null, cursor: -1, scopeIndex: HISTORY_SCOPE_DEFAULT, aligning: false })
    setOpen(true)
    setScopeIndex(HISTORY_SCOPE_DEFAULT)
    setCursor(-1)
    setAligning(false)
    setLoadError(false)
    setItems(null)
    setEditing(false)
    refreshCollected()
    requestScope(HISTORY_SCOPE_DEFAULT)
  }

  // 切换范围:→ 向大(工作区/全局),← 返回收藏;边界停住;搜索词清空后缓存直接返回
  function switchScope(delta) {
    const next = viewRef.current.scopeIndex + delta
    if (next < 0 || next >= HISTORY_SCOPE_LABELS.length) return
    rawItemsRef.current = null
    queryRef.current = ''
    setQuery('')
    syncView({ scopeIndex: next, items: null, cursor: -1, aligning: false })
    setScopeIndex(next)
    setCursor(-1)
    setAligning(false)
    setLoadError(false)
    setItems(null)
    setEditing(false)
    requestScope(next)
  }

  // Alt+↑ 唤起浮层;浮层开 = 菜单模态,捕获阶段拦截导航键,先于 Lexical 光标移动。
  // 设置开关停用时监听器直接放行(读 ref,开关值挂载拉取后即时反映)
  useEffect(() => {
    function onKeyDown(event) {
      if (enabledRef.current === false) return
      const view = viewRef.current
      if (event.isComposing) return
      if (!view.open) {
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          openPopup()
        }
        return
      }
      // 编辑态输入(重命名/新增行)聚焦时导航键留给输入本身,仅保留 Esc 关闭;
      // 搜索框不豁免:过滤后 ↑/↓ 选中与 Enter 回填正是搜索态的主路径
      const root = rootRef.current
      const searchEl = root && root.querySelector('.cx-hist__search')
      const active = document.activeElement
      if (root && active && active !== searchEl && root.contains(active)
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        if (event.key !== 'Escape') return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        if (view.items === null || view.items.length === 0) return
        const delta = event.key === 'ArrowUp' ? -1 : 1
        const next = Math.min(Math.max(view.cursor + delta, 0), view.items.length - 1)
        syncView({ cursor: next })
        setCursor(next)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // 搜索框聚焦时方向键留给光标移动,不切范围
        if (rootRef.current && rootRef.current.querySelector('.cx-hist__search') === document.activeElement) return
        event.preventDefault()
        event.stopPropagation()
        switchScope(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (event.key === 'Enter') {
        // 有选中条目即回填,搜索框聚焦同样成立(IME 组合已在函数头放行,
        // 搜索词过滤后 ↑/↓ 选中 → Enter 是搜索态的主要回填路径)
        if (view.items !== null && view.cursor >= 0 && view.cursor < view.items.length) {
          event.preventDefault()
          event.stopPropagation()
          fill(view.items[view.cursor].text)
        }
        return
      }
      if (event.key === 'Escape') {
        // 两级退出:搜索词非空先清搜索,再按才关闭;为空直接关闭(与现版一致)
        event.preventDefault()
        event.stopPropagation()
        if (queryRef.current.trim() !== '') {
          setQuery('')
          applyFilter('')
          return
        }
        syncView({ open: false })
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // 选中行滚入可视区:键盘移动后高亮行保持在视野内
  useEffect(() => {
    if (!open || cursor < 0) return
    const row = rootRef.current && rootRef.current.querySelector('.cx-hist__row--on')
    if (row) row.scrollIntoView({ block: 'nearest' })
  }, [open, cursor, items])

  // 浮层外点击关闭(双写:漏写 viewRef 会让键盘层误判浮层仍开,吞掉输入框方向键)
  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        syncView({ open: false })
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [open])

  // 零高度锚点:平时不占任何界面空间,仅浮层打开时渲染;设置停用整体不渲染
  if (session === undefined || inputActions === undefined || historyEnabled === false) return null
  const promptsIdx = HISTORY_SCOPES.indexOf('prompts')
  const inPrompts = scopeIndex === promptsIdx
  // 行悬停星标:非常用范围显示,已收藏实星(点击取消),未收藏空心(点击收藏);
  // stopPropagation 防止触发行回填
  const starButton = (item) => h('button', {
    className: 'cx-hist__star' + (collected.has(item.text) ? ' cx-hist__star--on' : ''),
    title: collected.has(item.text) ? '取消收藏' : '收藏',
    onClick: (event) => {
      event.stopPropagation()
      togglePrompt(item.text)
    },
  }, collected.has(item.text) ? '★' : '☆')
  const rowButton = (item, index) => h('button', {
    key: index + ':' + item.at,
    className: 'cx-hist__row' + (index === cursor ? ' cx-hist__row--on' : ''),
    onClick: () => fill(item.text),
  },
    h('span', { className: 'cx-hist__text', title: item.text }, item.text),
    h('span', { className: 'cx-hist__time' }, fmtTime(item.at)),
    !inPrompts ? starButton(item) : null,
  )
  // 编辑态行:key 用文本而非索引——常用范围内文本唯一,过滤后索引漂移不再重建
  // 行节点(重建会让编辑中的 input 卸载,未保存的修改静默丢失)
  const editRow = (item, index) => h('div', {
    key: item.text,
    className: 'cx-hist__editrow',
  },
    h('input', {
      className: 'cx-hist__editinput',
      defaultValue: item.text,
      title: item.text,
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          renamePrompt(item.text, event.target.value.trim())
        }
      },
      onBlur: (event) => {
        const next = event.target.value.trim()
        if (next !== item.text) renamePrompt(item.text, next)
      },
    }),
    h('button', {
      className: 'cx-hist__del',
      title: '删除',
      onClick: () => togglePrompt(item.text),
    }, '×'),
  )
  const hitCount = query.trim() === '' ? null : (items === null ? 0 : items.length)
  return h('div', { className: 'cx-hist', ref: rootRef },
    open && h('div', { className: 'cx-hist__pop' },
      h('div', { className: 'cx-hist__hint' },
        h('span', { className: 'cx-hist__scope' }, HISTORY_SCOPE_LABELS[scopeIndex]),
        inPrompts
          ? h('button', {
              className: 'cx-hist__editbtn',
              onClick: () => setEditing(!editing),
            }, editing ? '完成' : '编辑')
          : null,
        h('input', {
          className: 'cx-hist__search',
          placeholder: '搜索历史输入',
          value: query,
          onChange: (event) => {
            const next = event.target.value
            setQuery(next)
            if (!composingRef.current) applyFilter(next)
          },
          onCompositionStart: () => { composingRef.current = true },
          onCompositionEnd: (event) => {
            composingRef.current = false
            applyFilter(event.target.value)
          },
        }),
        hitCount !== null ? h('span', { className: 'cx-hist__count' }, String(hitCount)) : null,
        h('span', null, '↑/↓ 选择 · ←/→ 切换范围 · Enter 填入 · Esc 关闭')),
      aligning && h('div', { className: 'cx-hist__banner' }, '首次对齐历史中,可能需要稍等'),
      items === null
        ? h('div', { className: 'cx-hist__empty' }, '正在读取历史输入…')
        : editing && inPrompts
          ? h('div', { className: 'cx-hist__editwrap' },
              items.length === 0
                ? h('div', { className: 'cx-hist__empty' }, '还没有常用提示词,可从历史行悬停收藏,或在下方添加')
                : h('div', { className: 'cx-hist__list' }, items.map(editRow)),
              h('div', { className: 'cx-hist__addrow' },
                h('input', {
                  className: 'cx-hist__editinput',
                  placeholder: '输入常用提示词,Enter 添加',
                  ref: (el) => { if (el) el.dataset.addinput = '1' },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      const text = event.target.value.trim()
                      if (text !== '') {
                        togglePrompt(text)
                        event.target.value = ''
                      }
                    }
                  },
                }),
              ),
            )
          : items.length === 0
            ? h('div', { className: 'cx-hist__empty' }, loadError
              ? '历史输入加载失败,可关闭后重试'
              : (query.trim() !== '' ? '无匹配' : (inPrompts ? '还没有常用提示词' : '该范围内还没有历史输入')))
            : h('div', { className: 'cx-hist__list' }, items.map(rowButton)),
    ),
  )
}

// 插话撤回投影:仅用户插话(宿主队列 placement=steering,已发出但未被 step 边界
// claim 应用);queued 由官方队列面板呈现,context 为注入上下文非用户消息
function steerRowsOf(queue) {
  const rows = Array.isArray(queue) ? queue : []
  return rows.filter((row) => row && row.placement === 'steering')
}

// 撤回失败文案:queue-item-not-found = 消息已被 step 边界 claim(应用),无法撤回;
// 其余透传宿主错误消息
function withdrawFailureText(result) {
  const error = result && result.error
  if (error && error.code === 'session/queue-item-not-found') return '插话已被应用,无法撤回'
  return '撤回失败: ' + ((error && error.message) || '未知错误')
}

// 撤回动作:先宿主移除(inbox next-step 摘除,未应用即消失),成功才回填草稿,
// 顺序保证「移除失败绝不覆盖输入框」;actions 注入便于测试与组件解耦
async function withdrawSteer(row, actions) {
  let result
  try {
    result = await actions.updateQueue(row.id, { kind: 'remove' })
  } catch (error) {
    actions.notify('撤回失败: ' + String(error && error.message || error), { kind: 'error' })
    return false
  }
  if (!(result && result.ok)) {
    actions.notify(withdrawFailureText(result), { kind: 'error' })
    return false
  }
  try {
    actions.setDraft(row.text)
  } catch (error) {
    // 摘除已成功,草稿回填失败(会话切换等竞态)时文本必须可达:通知兜底展示原文
    actions.notify('草稿回填失败,原文: ' + row.text, { kind: 'error' })
    return false
  }
  actions.notify('已撤回到输入框')
  return true
}

// 撤回图标 svg(undo 弯箭头,stroke 继承 currentColor,尺寸由所克隆的官方按钮类控制)
function steerRecallSvg() {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const paths = ['M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6', 'M6 3.5 3 6.5l3 3']
  for (const d of paths) {
    const path = document.createElementNS(namespace, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

// fork 图标 svg:与官方分支按钮(IconBranchOutline16)同源,fill 细路径形态;
// path 数据采自官方运行时 DOM,官方图标升级时需同步
function forkSvg() {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('clip-rule', 'evenodd')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('d', 'M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z')
  svg.appendChild(path)
  return svg
}

// 注入按钮标记:识别自家节点与官方按钮,防止重复注入与误删官方节点
const STEER_BTN_FLAG = 'data-cx-steer-recall'
const FORK_BTN_FLAG = 'data-cx-fork'
// 家族版本环标记:识别自家 ‹n/m› 计数器节点,防重复注入
const FAMILY_RING_FLAG = 'data-cx-family-ring'
// 官方 pending steering 气泡的语义标记(官方同构:UserStyleBubble data 属性)与
// 其操作图标排的 CSS module 类名后缀(哈希前缀随构建漂移,后缀稳定);
// 消息节点的轮号标记(fork 锚点输入)
const STEER_BUBBLE_SELECTOR = '[data-pending-steering]'
const STEER_ACTIONS_SUFFIX = '[class$="_actions"]'
const TURN_ATTR = 'data-chat-turn'
// 官方消息流气泡的语义类型标记:user=用户输入气泡(turn-tail=官方轮尾,官方分支按钮驻留处)
const FLOW_KIND_ATTR = 'data-chat-flow-kind'
// fork 锚点窗口:follow 开场帧回溯的事件数上限(长会话全量回溯的内存/耗时护栏;
// 窗口覆盖不到的更早轮与进行中的轮不注入分叉按钮,新近轮——fork 的主要目标——总在覆盖内)
const FORK_PAGE_MAX_MESSAGES = 2000

// 重试草稿通道:分叉成功后子会话尚未挂载,原输入先按子会话 id 暂存,
// 子会话的 dock 挂载(inputActions 就绪)时消费回填并清除
const pendingForkDrafts = new Map()
// 草稿消费重查:覆盖 open 切换期间「挂载先于登记」的窗口(单次即可,上限留裕量)
const FORK_DRAFT_POLL_MS = 400
const FORK_DRAFT_POLLS = 3

// 取 follow 开场帧(回溯窗口内的事件快照,自带 seq)后立即断开:
// for-await break 触发 iterator.return,流即关闭,不消费 live 帧
async function followOpening(remote, sessionId) {
  const frames = remote.follow({ address: { kind: 'session', sessionId }, maxMessages: FORK_PAGE_MAX_MESSAGES })
  for await (const frame of frames) {
    if (frame && frame.type === 'snapshot') return Array.isArray(frame.records) ? frame.records : []
    return []
  }
  return []
}

// 插话撤回:注入原生 pending steering 气泡的操作图标排(复制图标旁),样式经克隆
// 官方按钮 className 完全原生;气泡被应用后整棵卸载,注入按钮随之消失。
// dock 本体 display:none 零占位,仅承载观察与注入;官方 DOM 结构漂移时注入静默
// 跳过(不报错),干净禁用精神
function SteerRecallDock({ session, useSession, inputActions, updateQueue }) {
  const queue = useSession((state) => state.queue)
  const queueMutable = useSession((state) => state.subagent === null || state.subagent.address.mode === 'continuable')
  const [busy, setBusy] = useState(false)
  // 启停开关(设置页):挂载拉取一次,停用即不注入并移除已注入按钮;失败按启用兜底
  const [enabled, setEnabled] = useState(true)
  const enabledRef = useRef(true)
  useEffect(() => {
    api(STEER_ENABLED_URL)
      .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
      .catch(() => {})
  }, [])
  // 条件 return 之前同步:停用路径也要让 scan 门控看到最新值
  enabledRef.current = enabled
  // 观察回调经由 ref 读最新状态,观察器只挂一次不随渲染重挂
  const rowsRef = useRef([])
  const mutableRef = useRef(true)
  const busyRef = useRef(false)
  const actionsRef = useRef(null)
  rowsRef.current = steerRowsOf(queue)
  mutableRef.current = queueMutable
  busyRef.current = busy
  actionsRef.current = { updateQueue, setDraft: inputActions ? inputActions.setDraft : undefined }
  const scanRef = useRef(null)
  useEffect(() => {
    function withdraw(row) {
      const actions = actionsRef.current
      if (busyRef.current || !actions || typeof actions.updateQueue !== 'function') return
      setBusy(true)
      void withdrawSteer(row, { updateQueue: actions.updateQueue, setDraft: actions.setDraft, notify: toast })
        .finally(() => setBusy(false))
    }
    function syncButton(button, row) {
      const textOnly = row.text !== null
      button.disabled = busyRef.current || !textOnly
      button.title = textOnly ? '撤回到输入框: ' + row.preview : '含附件的插话不支持撤回'
    }
    function scan() {
      // 停用即不注入并移除已注入按钮(开关可在挂载后才到达停用值)
      if (!enabledRef.current) {
        document.querySelectorAll('[' + STEER_BTN_FLAG + ']').forEach((button) => button.remove())
        return
      }
      const bubbles = document.querySelectorAll(STEER_BUBBLE_SELECTOR)
      const rows = mutableRef.current ? rowsRef.current : []
      bubbles.forEach((bubble, index) => {
        const actionsRow = bubble.querySelector(STEER_ACTIONS_SUFFIX)
        if (!actionsRow) return
        let button = actionsRow.querySelector('[' + STEER_BTN_FLAG + ']')
        const row = rows[index]
        if (!row) {
          // 气泡尚存但行已被应用/撤回(帧差瞬态):按钮随气泡卸载,先禁用防误触
          if (button) button.disabled = true
          return
        }
        if (!button) {
          const official = actionsRow.querySelector('button:not([' + STEER_BTN_FLAG + '])')
          if (!official) return
          button = document.createElement('button')
          button.type = 'button'
          button.setAttribute(STEER_BTN_FLAG, '')
          // 克隆官方按钮类名:尺寸/hover/悬停显隐(reveal)全部原生
          button.className = official.className
          button.addEventListener('click', () => withdraw(row))
          button.appendChild(steerRecallSvg())
          actionsRow.appendChild(button)
        }
        syncButton(button, row)
      })
    }
    scanRef.current = scan
    const observer = new MutationObserver(scan)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    scan()
    return () => {
      scanRef.current = null
      observer.disconnect()
      document.querySelectorAll('[' + STEER_BTN_FLAG + ']').forEach((button) => button.remove())
    }
  }, [])
  // 行集/开关/忙碌变化即时重扫(观察器只覆盖 DOM 变更,状态变化需主动对账)
  useEffect(() => {
    if (scanRef.current) scanRef.current()
  }, [queue, enabled, busy, queueMutable])
  if (session === undefined || inputActions === undefined || updateQueue === undefined) return null
  if (!enabled || !queueMutable) return null
  return h('div', { className: 'cx-steer-host' })
}

// 对话 fork:重写式分叉——从消息气泡处分叉到该轮之前(该轮不带入子会话消息流),
// 该轮用户输入回填子会话输入框供编辑重发(与插话撤回同构,作用于 fork 场景,不动原会话)。
// 锚点通道:消息气泡 DOM 携带官方轮号标记 data-chat-turn,轮号 → { 结束 seq, 首问文本 }
// 映射经 remote.session.follow 开场帧一次拉取(点分门控,旧宿主缺失即整体不注册);
// 轮号无映射 = 该轮未完成,首问无文本(纯图等)= 无法重试,均不注入;
// 首轮无前锚(宿主 fork 边界必须落在 turn/end 上,复制零事件不可表达),也不注入。
// 分叉动作经宿主 sessions 服务面 fork+open(与官方 chat 同构),成功 toast 并切换
function ForkDockWithBootstrap({ session, inputActions, forkSession, cancelSession, openSession, loadFamily, submitPrompt, loadTurnEnds }) {
  // 依赖键 = 会话 id:session 快照身份随每次投影更新漂移,不能作 effect 依赖;
  // loadTurnEnds 闭包身份同样不稳定,经 ref 取用
  const sessionId = session && session.sessionId
  const loadRef = useRef(loadTurnEnds)
  loadRef.current = loadTurnEnds
  // 自动重发通道:宿主 prompt 调用经 apply 闭包注入(与 forkSession 同构),ref 取用
  const submitRef = useRef(null)
  submitRef.current = submitPrompt
  const [turnEnds, setTurnEnds] = useState(null)
  useEffect(() => {
    if (sessionId === undefined) return undefined
    let disposed = false
    // 拉取前置空:会话切换后旧会话的映射不得继续服务新会话——轮号跨会话重叠,
    // 旧 seq 会让分叉锚点错位;置空期间 ForkDock 以 null 短路,不注入按钮
    setTurnEnds(null)
    loadRef.current()
      .then((map) => {
        if (!disposed) setTurnEnds(map)
      })
      .catch((error) => {
        // 映射拉取失败(网络/宿主繁忙):fork 无锚点可用,保持禁用不注入;
        // 刷新页面重试,不做自动重试风暴
        console.warn('[context-manager] fork 轮号映射拉取失败', error)
      })
    return () => { disposed = true }
  }, [sessionId])
  // 重试草稿消费:open 切到子会话后本 dock 随之挂载,inputActions 绑定子会话,
  // 暂存文本此刻回填;消费即清除。open 失败时暂存保留,用户手动打开子会话仍兑现。
  // 宿主 open 可能先于点击处登记草稿完成子会话 dock 挂载(实测 ~400ms 切换),
  // 挂载时草稿未到即空跑一次且依赖不再变化——安排有限次延迟重查兜底。
  // 自动重发(开关开):草稿带 autoSubmit 标记,setDraft 后经 remote.session.prompt
  // 立即提交原文(重生成语义);prompt 失败仅 toast——文本已在输入框,可手动发送
  const [draftPollTick, setDraftPollTick] = useState(0)
  useEffect(() => {
    if (sessionId === undefined || !inputActions || typeof inputActions.setDraft !== 'function') return undefined
    const draft = pendingForkDrafts.get(sessionId)
    if (draft === undefined) {
      if (draftPollTick >= FORK_DRAFT_POLLS) return undefined
      const timer = setTimeout(() => setDraftPollTick(draftPollTick + 1), FORK_DRAFT_POLL_MS)
      return () => clearTimeout(timer)
    }
    pendingForkDrafts.delete(sessionId)
    const text = draft && typeof draft === 'object' ? draft.text : draft
    const autoSubmit = Boolean(draft && typeof draft === 'object' && draft.autoSubmit === true)
    inputActions.setDraft(text)
    if (autoSubmit && submitRef.current) {
      Promise.resolve(submitRef.current({ sessionId, text })).catch((error) => {
        toast('自动重发失败,文本已在输入框可手动发送: ' + String(error && error.message || error), { kind: 'error' })
      })
    }
    return undefined
  }, [sessionId, inputActions, draftPollTick])
  return h(ForkDock, { session, forkSession, cancelSession, openSession, loadFamily, turnEnds })
}

function ForkDock({ session, forkSession, cancelSession, openSession, loadFamily, turnEnds }) {
  const [enabled, setEnabled] = useState(true)
  const [autoResend, setAutoResend] = useState(false)
  const turnEndsRef = useRef(null)
  const forkRef = useRef(null)
  const cancelRef = useRef(null)
  const familyRef = useRef(null)
  const openRef = useRef(null)
  const sessionRef = useRef(null)
  const enabledRef = useRef(true)
  const autoResendRef = useRef(false)
  useEffect(() => {
    api(FORK_ENABLED_URL)
      .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
      .catch(() => {})
    api(FORK_AUTO_RESEND_URL)
      .then((payload) => setAutoResend(Boolean(payload && payload.enabled === true)))
      .catch(() => {})
  }, [])
  // 条件 return 之前同步全部 ref:停用与映射置空窗口内 scan 门控也要看到最新值,
  // 否则旧会话的映射会继续服务新 DOM(轮号跨会话重叠,锚点错位)
  enabledRef.current = enabled
  autoResendRef.current = autoResend
  turnEndsRef.current = turnEnds
  forkRef.current = forkSession
  cancelRef.current = cancelSession
  familyRef.current = loadFamily
  openRef.current = openSession
  sessionRef.current = session
  useEffect(() => {
    function removeAll() {
      document.querySelectorAll('[' + FORK_BTN_FLAG + ']').forEach((button) => button.remove())
      document.querySelectorAll('[' + FAMILY_RING_FLAG + ']').forEach((node) => node.remove())
    }
    function scan() {
      // 停用即不注入并移除已注入按钮(开关可在挂载后才到达停用值)
      if (!enabledRef.current) {
        removeAll()
        return
      }
      if (turnEndsRef.current === null) return
      const bubbles = document.querySelectorAll('[' + TURN_ATTR + ']')
      bubbles.forEach((bubble) => {
        // 只注入用户输入气泡:重写该轮改的是该轮的输入;官方分支按钮已驻留在
        // 轮尾操作排(含该轮的完整分叉),两者语义互补,位置也不重叠
        if (bubble.getAttribute(FLOW_KIND_ATTR) !== 'user') return
        const actionsRow = bubble.querySelector(STEER_ACTIONS_SUFFIX)
        if (!actionsRow) return
        if (actionsRow.querySelector('[' + FORK_BTN_FLAG + ']')) return
        // 空属性串 Number('') = 0,会把无轮号气泡误判为第 0 轮,先判空
        const rawTurn = bubble.getAttribute(TURN_ATTR)
        if (rawTurn === null || rawTurn.trim() === '') return
        const turn = Number(rawTurn)
        if (!Number.isInteger(turn)) return
        // 重试资格三查:映射缺失的轮(超窗口)不可分叉;首轮无前锚(宿主
        // fork 边界必须落在 turn/end,复制零事件不可表达);无首问文本(纯图等)
        // 回填无从谈起。open=true 的进行中轮 turn/end 未落账,同样可分叉——
        // 锚点取其前一个闭合轮,该轮未完成的回复分叉后停掉(见点击处理器)。
        // 按钮在场即暗示可用,禁用态文案无法区分成因,不注入即误导
        const entry = turnEndsRef.current.get(turn)
        if (entry === undefined || entry.text === null) return
        let previous = null
        for (const key of turnEndsRef.current.keys()) {
          const candidate = turnEndsRef.current.get(key)
          if (key < turn && candidate && candidate.seq !== null && (previous === null || key > previous)) previous = key
        }
        if (previous === null) return
        const anchor = turnEndsRef.current.get(previous)
        const official = actionsRow.querySelector('button:not([' + FORK_BTN_FLAG + ']):not([' + STEER_BTN_FLAG + '])')
        if (!official) return
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(FORK_BTN_FLAG, '')
        // 克隆官方按钮类名:尺寸/hover/悬停显隐(reveal)全部原生
        button.className = official.className
        button.title = entry.open
          ? '重写该轮(进行中):分叉到该轮之前,原输入回填输入框重新编辑;分叉后停止本会话该轮未完成的回复'
          : '重写该轮:分叉到该轮之前,原输入回填输入框重新编辑(官方「在新对话中分支」含该轮,两者互补)'
        button.addEventListener('click', () => {
          const forkSessionFn = forkRef.current
          const cancelSessionFn = cancelRef.current
          const autoResendOn = autoResendRef.current
          const current = sessionRef.current
          const currentEntry = turnEndsRef.current === null ? undefined : turnEndsRef.current.get(turn)
          const previousEntry = turnEndsRef.current === null || previous === null ? undefined : turnEndsRef.current.get(previous)
          if (!forkSessionFn || !currentEntry || !previousEntry || !current) {
            toast('该轮不可分叉', { kind: 'error' })
            return
          }
          forkSessionFn({ sessionId: current.sessionId, atSeq: previousEntry.seq, increaseTitle: true })
            .then((childId) => {
              // 暂存先于 toast:open 的子会话挂载可能紧随 resolve,回填承诺必须先就位;
              // open 失败时暂存保留,用户手动打开子会话仍兑现;
              // 自动重发开关开:登记带标记草稿,子会话消费时回填后经 prompt 提交
              if (typeof childId === 'string' && childId !== '') {
                pendingForkDrafts.set(childId, { text: currentEntry.text, autoSubmit: autoResendOn })
              }
              // 进行中轮分叉后原会话该轮无人再读,停掉止损;失败不影响分叉成功事实
              if (currentEntry.open === true && typeof cancelSessionFn === 'function') {
                Promise.resolve(cancelSessionFn({ sessionId: current.sessionId })).catch((error) => {
                  console.warn('[context-manager] 分叉后停止原会话进行中回复失败', error)
                })
              }
              toast('已分叉,原输入已填入子会话输入框')
              return childId
            })
            .catch((error) => {
              const code = error && error.code
              toast(forkFailureText(code ?? (error && error.message)), { kind: 'error', sticky: true })
            })
        })
        button.appendChild(forkSvg())
        actionsRow.appendChild(button)
      })
      // 家族版本环:每个用户气泡操作排的 ‹n/m›,箭头在家族成员间跳转;
      // 单成员家族/快照面缺失不注入(与官方按钮并存,hover 显隐一致)
      const loadFamilyFn = familyRef.current
      const ring = (sessionRef.current && typeof loadFamilyFn === 'function')
        ? loadFamilyFn(sessionRef.current.sessionId)
        : null
      if (ring && ring.total >= 2) {
        bubbles.forEach((bubble) => {
          if (bubble.getAttribute(FLOW_KIND_ATTR) !== 'user') return
          const actionsRow = bubble.querySelector(STEER_ACTIONS_SUFFIX)
          if (!actionsRow || actionsRow.querySelector('[' + FAMILY_RING_FLAG + ']')) return
          const official = actionsRow.querySelector('button:not([' + FORK_BTN_FLAG + ']):not([' + STEER_BTN_FLAG + '])')
          if (!official) return
          const ringEl = document.createElement('span')
          ringEl.setAttribute(FAMILY_RING_FLAG, '')
          ringEl.className = official.className + ' cx-family-ring'
          ringEl.title = '家族版本:本会话在同源分叉家族中的序位,‹ › 在各版本间切换'
          const prev = document.createElement('button')
          prev.type = 'button'
          prev.className = official.className
          prev.setAttribute(FAMILY_RING_FLAG, '')
          prev.textContent = '‹'
          prev.title = '上一个家族版本'
          prev.addEventListener('click', () => jumpFamilyMember(-1))
          const label = document.createElement('span')
          label.setAttribute(FAMILY_RING_FLAG, '')
          label.textContent = ring.index + '/' + ring.total
          const next = document.createElement('button')
          next.type = 'button'
          next.className = official.className
          next.setAttribute(FAMILY_RING_FLAG, '')
          next.textContent = '›'
          next.title = '下一个家族版本'
          next.addEventListener('click', () => jumpFamilyMember(1))
          ringEl.appendChild(prev)
          ringEl.appendChild(label)
          ringEl.appendChild(next)
          actionsRow.appendChild(ringEl)
        })
      }
    }
    function jumpFamilyMember(offset) {
      const loadFamilyFn = familyRef.current
      const openFn = openRef.current
      const current = sessionRef.current
      if (!current || typeof loadFamilyFn !== 'function' || typeof openFn !== 'function') return
      const ring = loadFamilyFn(current.sessionId)
      if (!ring) return
      const nextIndex = ring.index - 1 + offset
      if (nextIndex < 0 || nextIndex >= ring.members.length) return
      const target = ring.members[nextIndex]
      if (target && target !== current.sessionId) openFn(target)
    }
    if (typeof MutationObserver === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
    const scanRef = { current: scan }
    const observer = new MutationObserver(() => { if (scanRef.current) scanRef.current() })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    scan()
    return () => {
      scanRef.current = null
      observer.disconnect()
      removeAll()
    }
  }, [turnEnds])
  if (session === undefined || turnEnds === null) return null
  if (!enabled) return null
  return h('div', { className: 'cx-fork-host' })
}

// 面板设置项悬停说明:原生 title(设置侧栏为滚动容器,CSS 气泡会被 overflow
// 裁剪,JS 定位复杂度不成比例);文案与功能行为同源维护,由源码契约测试锁定
const HISTORY_SWITCH_TITLE = '在输入框按 Alt+↑ 唤起历史输入浮层,浏览并回填历史输入;浮层内 ←/→ 切换范围(常用 / 当前会话 / 本工作区 / 全部工作区),顶部搜索框过滤条目,行悬停星标可收藏常用提示词。停用后快捷键与浮层整体关闭,刷新页面生效。'
const STEER_SWITCH_TITLE = '插话发送后、尚未被智能体应用期间,在该插话气泡的操作图标排显示撤回按钮,点击撤回并把原文填回输入框(覆盖输入框现有草稿);含附件的插话不可撤回;消息被应用后按钮随气泡消失,恰在应用瞬间点击会提示已应用且不动草稿。停用即不再注入,刷新页面生效。'
const FORK_SWITCH_TITLE = '消息气泡操作排显示分叉按钮,点击分叉出新会话到该轮之前(该轮不带入子会话),该轮的用户输入自动回填子会话输入框供编辑重发,子会话自动打开且标题尾号递增;进行中的轮(回复尚未完成)同样可分叉,分叉后自动停止本会话该轮未完成的回复;首轮(无更早上下文可继承,新建会话即为同义操作)与无文本输入的轮(纯图等,无从重发)不注入;停用即不再注入,刷新页面生效。'
const FORK_AUTO_RESEND_SWITCH_TITLE = '分叉成功后自动把该轮原输入发送到子会话立即开跑(重生成语义,相当于原输入重跑一遍);关闭时分叉仅把原输入回填子会话输入框,由你编辑后再手动发送。'

// 启停开关行工厂:三个开关同构(受控 checkbox + cx-switch 形态),值存宿主 settings,
// 切换经本插件路由中转,变更刷新页面生效
function switchRow(url, label, title, okText) {
  function Row() {
    const [enabled, setEnabled] = useState(null)
    useEffect(() => {
      api(url)
        .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
        .catch(() => setEnabled(true))
    }, [])
    // 受控 checkbox:onChange 内同步落 state(异步确认会让 DOM 与渲染竞态,
    // 视觉慢一拍),服务端响应仅用于失败回滚
    const flip = (event) => {
      const next = event.target.checked
      setEnabled(next)
      api(url, { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then((payload) => {
          toast(okText + (payload && payload.enabled !== false ? '已启用' : '已停用') + ',刷新页面后生效')
        })
        .catch(() => {
          setEnabled(!next)
          toast('切换失败', { kind: 'error' })
        })
    }
    return h('label', { className: 'cx-switch', title },
      h('input', { type: 'checkbox', checked: enabled !== false, onChange: flip }),
      h('span', { className: 'cx-switch__track' }, h('span', { className: 'cx-switch__thumb' })),
      h('span', { className: 'cx-switch__label', onClick: (event) => event.preventDefault() }, label),
    )
  }
  return Row
}

const HistorySwitchRow = switchRow(HISTORY_ENABLED_URL, '历史输入浮层(Alt+↑)', HISTORY_SWITCH_TITLE, '历史输入浮层')
const SteerSwitchRow = switchRow(STEER_ENABLED_URL, '插话撤回', STEER_SWITCH_TITLE, '插话撤回')
const ForkSwitchRow = switchRow(FORK_ENABLED_URL, '对话 fork', FORK_SWITCH_TITLE, '对话 fork')
const ForkAutoResendSwitchRow = switchRow(FORK_AUTO_RESEND_URL, '分叉后自动重发', FORK_AUTO_RESEND_SWITCH_TITLE, '分叉后自动重发')

// 「插件」设置页卡片:标题 + 四启停开关行
function ContextPanel() {
  return h('div', { className: 'cx-panel' },
    h('h3', { className: 'cx-panel__title' }, '对话增强'),
    h('span', { className: 'cx-panel__hint' }, '历史输入、插话撤回与对话分叉的启停;变更刷新页面生效。'),
    h(HistorySwitchRow),
    h(SteerSwitchRow),
    h(ForkSwitchRow),
    h(ForkAutoResendSwitchRow),
  )
}

    return {
      // remote.session 点分声明交 cordis 门控(规约禁 apply 内同步探测该面):
      // namespace 由宿主异步 $mount,fiber 等其就绪才激活,旧宿主无此 namespace
      // 即整体未激活(干净禁用,不阻塞 web 启动)
      inject: ['slots', 'sessions', 'workspaces', 'remote', 'remote.session'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')
        const remoteSession = ctx.remote ? ctx.remote.session : undefined
        // 分叉动作通道:fork 成功即打开子会话;open 失败不影响分叉成功的事实,
        // 单独吞掉(警告日志),点击处不再误报「分叉失败」
        const forkService = (sessions && typeof sessions.fork === 'function' && typeof sessions.open === 'function')
          ? (opts) => sessions.fork(opts).then((childId) => {
            try {
              Promise.resolve(sessions.open(childId)).catch((error) => {
                console.warn('[context-manager] 分叉子会话已创建,但打开失败', error)
              })
            } catch (error) {
              console.warn('[context-manager] 分叉子会话已创建,但打开失败', error)
            }
            return childId
          })
          : null

        // 家族环通道:会话列表快照(parentSessionId 字段)投影为当前会话的 ‹n/m› 计数;
        // 快照面缺失(旧宿主)时返回 null,计数器整体不注入
        const loadFamily = (sessionId) => {
          if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null
          const snapshot = sessions.list.getSnapshot()
          const rows = snapshot && snapshot.byId
            ? (Array.isArray(snapshot.ids) ? snapshot.ids : []).map((id) => snapshot.byId[id]).filter(Boolean)
            : (Array.isArray(snapshot) ? snapshot : [])
          if (rows.length === 0) return null
          return familyRing(sessionFamilyMap(rows), sessionId)
        }

        // 自动重发通道:开启开关时分叉后以该轮原输入 prompt 子会话;
        // remote.session 缺失或缺 prompt(旧宿主/部分 stub)时返回 null,降级为仅回填;
        // 请求形态与官方 client face 同源:content 为 text 分段数组(宿主 hasPromptContent
        // 校验),mode=queue(无进行中轮即直接开跑),clientTimeZone 随本地时区
        const submitPrompt = (remoteSession && typeof remoteSession.prompt === 'function')
          ? ({ sessionId: targetId, text }) => remoteSession.prompt({
              requestId: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
              sessionId: targetId,
              mode: 'queue',
              content: [{ type: 'text', text }],
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })
          : null

        // 样式挂载在宿主文档级:设置页未打开时面板不存在,
        // 样式若随面板注入则面板裸样式渲染
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-context-manager')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'context-manager styles')

        // 设置卡片:注册进官方「插件」设置页的可配置插件区(keyed slot,
        // key = 本插件 settings namespace),不占独立设置导航项
        ctx.slots.inject('settings.plugin.item', () =>
          ctx.slots.register(
            { name: 'settings.plugin.item', id: 'context', key: 'context' },
            () => React.createElement(ContextPanel),
          ))

        // 历史输入回溯入口:官方 conversation.input.dock 插槽(dsh-client-ui-goal 同构)。
        // 宿主缺该插槽时注册抛错即禁用本功能,不阻塞其余能力
        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: 'context-manager-history', order: 90 },
              HistoryDock,
            ))
        } catch (error) {
          console.warn('[context-manager] 历史输入入口未注册(宿主无 conversation.input.dock 插槽)', error)
        }

        // 插话撤回入口:未应用的插话撤回到输入框重新编辑。RPC 走会话绑定面
        // binding.session.updateQueue(RemoteResult 不抛错,与官方 conversation 服务
        // 无耦合);会话面缺失或无 updateQueue(旧宿主)返回空 props,组件不渲染
        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'context-manager-steer',
                order: 25,
                inject: (sessionId) => {
                  const binding = sessions.binding(sessionId)
                  const updateQueue = binding && binding.session && binding.session.updateQueue
                  if (typeof updateQueue !== 'function') return {}
                  return { updateQueue: (itemId, action) => binding.session.updateQueue(itemId, action) }
                },
              },
              SteerRecallDock,
            ))
        } catch (error) {
          console.warn('[context-manager] 插话撤回入口未注册(宿主无 conversation.input.dock 插槽)', error)
        }

        // 对话 fork 入口:锚点映射经 remote.session.follow 开场帧一次拉取
        // (开场帧自带回溯窗口内的全部事件与 seq,取到即断开订阅,不做 live 消费),
        // 分叉动作经 sessions 服务面;分叉服务面缺失即整体不注册(干净禁用)。
        // inputActions 由插槽宿主按会话绑定注入,子会话挂载时消费重试草稿
        if (forkService) {
          try {
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'context-manager-fork',
                  order: 24,
                  inject: (sessionId) => ({
                    forkSession: forkService,
                    cancelSession: (typeof remoteSession.cancel === 'function')
                      ? (opts) => remoteSession.cancel(opts)
                      : null,
                    openSession: (sessions && typeof sessions.open === 'function') ? (id) => sessions.open(id) : null,
                    loadFamily: () => loadFamily(sessionId),
                    submitPrompt,
                    loadTurnEnds: () => followOpening(remoteSession, sessionId).then((records) => {
                      // 轮号 → { 结束 seq, 该轮首问文本, open }:上个 turn/end 之后首条
                      // 携带非空文本的 user 本人消息即该轮首问(轮内纯图消息跳过,
                      // 后续文本插话可补位);turn/end 落账并重置;
                      // 流末尾文本已累积而无 turn/end 的轮是进行中轮:seq=null +
                      // open=true 登记(分叉锚点取其前一个闭合轮,分叉后可停原会话);
                      // data 缺 turn 号时按出现顺序计数
                      const map = new Map()
                      let ordered = 0
                      let turnText = null
                      for (const record of records) {
                        const event = record && record.event
                        if (!event) continue
                        if (event.type === 'user/message') {
                          if (turnText === null) turnText = forkRetryText(event.data)
                          continue
                        }
                        if (event.type !== 'turn/end') continue
                        const turn = event.data && Number.isInteger(event.data.turn) ? event.data.turn : ordered
                        map.set(turn, { seq: event.seq, text: turnText, open: false })
                        turnText = null
                        ordered += 1
                      }
                      if (turnText !== null) {
                        const turn = map.size > 0 ? Math.max(...map.keys()) + 1 : 0
                        map.set(turn, { seq: null, text: turnText, open: true })
                      }
                      return map
                    }),
                  }),
                },
                ForkDockWithBootstrap,
              ))
          } catch (error) {
            console.warn('[context-manager] 对话 fork 入口未注册(宿主无 conversation.input.dock 插槽)', error)
          }
        }
      },
    }
  },
})


