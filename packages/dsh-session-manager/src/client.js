// dsh-session-manager Client 半区:settings.section 归档面板 + 归档/操作反馈通知
// + 历史输入浮层(Alt+↑ 唤起,列表浏览与点选回填)。
// 归档快照来自官方 workspace.follow 客户端模型(ctx.get('workspaces')),会话行来自
// ctx.get('sessions');面板数据 = 会话行 ∩ 归档集合(纯投影),通知由 archived
// 增量帧的集合差分驱动,经公共依赖 @mzzsfy/dsh-toast 展示。历史输入挂官方
// conversation.input.dock 插槽(行数据由 host /api/session-manager/inputs 聚合),
// 回填走宿主公共契约 inputActions.setDraft。浏览器半区经 webServer
// 路由('/api/session-manager/*')访问 Host。打包为单文件自包含格式,无法跨文件
// require;与 src/core.mjs 镜像的纯函数(projectArchiveRows / archiveToastStep /
// projectDeletedRows)修改需两处同步。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-session-manager',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useSyncExternalStore } = React

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染(本插件分区 → archive);
    // 该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '会话归档': 'archive' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    // 通知出口:公共依赖 @mzzsfy/dsh-toast(external require,宿主占位条目由
    // 本插件 cordis.patch.yml 代挂)
    const { show: toast } = require('@mzzsfy/dsh-toast/client')

// 视觉方案:归档台账——全部取宿主 alias 令牌(双主题自适应,不造色),数据列
// 用宿主代码字体(会话即文件的档案词汇),签名元素为托盘内的归档轨
const CSS = [
  '.sm-panel { display:flex; flex-direction:column; gap:8px; min-width:0; color:var(--dsw-alias-label-primary); font:var(--dsw-font-s-14); }',
  '.sm-head { display:flex; align-items:baseline; gap:8px; }',
  '.sm-head__title { font:var(--dsw-font-m-18); }',
  '.sm-head__count { font:12px/18px var(--ds-font-family-code, monospace); color:var(--dsw-alias-label-caption); font-variant-numeric:tabular-nums; }',
  '.sm-head__hint { font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-caption); }',
  '.sm-tray { position:relative; background:var(--dsw-alias-bg-module-platform); border-radius:10px; padding:4px 0; }',
  '.sm-tray::before { content:""; position:absolute; left:15px; top:12px; bottom:12px; width:1px; background:var(--dsw-alias-border-l3); }',
  '.sm-row { position:relative; display:grid; grid-template-columns:88px minmax(0, 1fr) auto; align-items:center; gap:8px;',
  '  padding:7px 10px 7px 28px; border-radius:8px; }',
  '.sm-row::before { content:""; position:absolute; left:13px; top:50%; width:5px; height:5px; margin:-2.5px 0 0;',
  '  border-radius:50%; background:var(--dsw-alias-border-l4); }',
  '.sm-row:hover, .sm-row:focus-within { background:var(--dsw-alias-interactive-bg-hover); }',
  '.sm-row:hover::before, .sm-row:focus-within::before { background:var(--dsw-alias-state-business-primary); }',
  '.sm-row--armed { background:var(--dsw-alias-interactive-bg-hover-danger); }',
  '.sm-row--armed::before { background:var(--dsw-alias-state-error-primary); }',
  '.sm-row--busy { opacity:.45; pointer-events:none; }',
  '.sm-row__time, .sm-row__size { font:12px/18px var(--ds-font-family-code, monospace); color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }',
  '.sm-row__size { color:var(--dsw-alias-state-error-primary); }',
  '.sm-row__title { font:var(--dsw-font-s-strong-14); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-row__error { grid-column:2 / -1; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-state-error-primary); }',
  '.sm-row__path { grid-column:2 / -1; font:12px/16px var(--ds-font-family-code, monospace); color:var(--dsw-alias-label-caption);',
  '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-deleted { display:flex; flex-direction:column; gap:8px; min-width:0; }',
  '.sm-row__actions { display:flex; gap:2px; justify-content:flex-end; opacity:0; transition:opacity 0.12s ease; }',
  '.sm-row:hover .sm-row__actions, .sm-row:focus-within .sm-row__actions, .sm-row--armed .sm-row__actions { opacity:1; }',
  '.sm-btn { border:0; background:transparent; cursor:pointer; padding:2px 8px; border-radius:6px;',
  '  font:var(--dsw-font-xxs-strong-12); color:var(--dsw-alias-label-tertiary); }',
  '.sm-btn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }',
  '.sm-btn--restore:hover { color:var(--dsw-alias-state-business-primary); }',
  '.sm-btn--danger:hover { color:var(--dsw-alias-state-error-primary); }',
  '.sm-btn--confirm { color:var(--dsw-alias-state-error-primary); border:1px solid var(--dsw-alias-state-error-primary); }',
  '.sm-btn--confirm:hover { background:var(--dsw-alias-interactive-bg-hover-danger); }',
  '.sm-btn:disabled { opacity:.45; cursor:default; background:transparent; color:var(--dsw-alias-label-tertiary); }',
  '.sm-btn--confirm:disabled { color:var(--dsw-alias-state-error-primary); }',
  '.sm-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }',
  '.sm-empty { padding:24px 12px; text-align:center; color:var(--dsw-alias-label-caption); }',
  '.sm-empty__hint { font:var(--dsw-font-xxs-12); margin-top:2px; }',
  '@media (prefers-reduced-motion: reduce) { .sm-row__actions { transition:none; } }',
  // 历史输入:零高度锚点容器 + 向上弹出浮层(Alt+↑ 唤起)
  '.sm-hist { position:relative; height:0; }',
  '.sm-hist__pop { position:absolute; right:12px; bottom:8px; z-index:30; width:min(560px, 90%);',
  '  max-height:320px; display:flex; flex-direction:column; overflow:hidden;',
  '  background:var(--dsw-alias-bg-module-platform); border:1px solid var(--dsw-alias-border-l3); border-radius:10px;',
  '  box-shadow:0 8px 24px rgba(0,0,0,.18); }',
  '.sm-hist__hint { padding:8px 12px 4px; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-caption); flex:none; }',
  '.sm-hist__scope { margin-right:8px; padding:1px 8px; border-radius:999px;',
  '  background:var(--dsw-alias-interactive-bg-selected); color:var(--dsw-alias-label-primary); }',
  '.sm-hist__more { padding:6px 10px; text-align:center; font:var(--dsw-font-xxs-12); color:var(--dsw-alias-label-caption); }',
  '.sm-hist__list { overflow-y:auto; padding:4px; }',
  '.sm-hist__row { display:flex; align-items:baseline; gap:8px; width:100%; border:0; background:transparent;',
  '  cursor:pointer; text-align:left; padding:6px 10px; border-radius:6px; min-width:0; }',
  '.sm-hist__row:hover { background:var(--dsw-alias-interactive-bg-hover); }',
  '.sm-hist__row--on, .sm-hist__row--on:hover { background:var(--dsw-alias-interactive-bg-selected); }',
  '.sm-hist__row:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-2px; }',
  '.sm-hist__text { flex:1; min-width:0; font:var(--dsw-font-s-14); color:var(--dsw-alias-label-primary);',
  '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-hist__time { font:12px/18px var(--ds-font-family-code, monospace); color:var(--dsw-alias-label-caption);',
  '  font-variant-numeric:tabular-nums; flex:none; }',
  '.sm-hist__empty { padding:20px 12px; text-align:center; font:var(--dsw-font-s-14); color:var(--dsw-alias-label-caption); }',
].join('\n')

const UNARCHIVE_URL = '/api/session-manager/unarchive'
const DELETE_URL = '/api/session-manager/delete'
const INFO_URL = '/api/session-manager/info'
const DELETED_URL = '/api/session-manager/deleted'
const REMOUNT_URL = '/api/session-manager/remount'
const FORGET_URL = '/api/session-manager/forget'
const STATUS_URL = '/api/session-manager/status'
const INPUTS_URL = '/api/session-manager/inputs'

async function api(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
  return payload
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

function fmtSize(bytes) {
  const n = Number(bytes)
  if (n !== n || n < 0) return '—'
  const UNIT_STEP = 1024
  if (n < UNIT_STEP) return n + ' B'
  if (n < UNIT_STEP * UNIT_STEP) return (n / UNIT_STEP).toFixed(1) + ' KB'
  return (n / (UNIT_STEP * UNIT_STEP)).toFixed(1) + ' MB'
}

function useSnapshot(source) {
  return useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => source.getSnapshot(),
  )
}

// 已归档会话面板行:官方会话行 ∩ 归档集合,按更新时间倒序(镜像 core.mjs projectArchiveRows)
function projectRows(listState, archivedIds) {
  const archived = new Set(archivedIds)
  const byId = (listState && listState.byId) || {}
  return Object.keys(byId)
    .filter((id) => archived.has(id))
    .map((id) => ({ id, title: byId[id].displayTitle || id, updatedAt: byId[id].updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

// 已删除面板行:标题回退会话 id,按删除时间倒序(镜像 core.mjs projectDeletedRows)
function projectDeletedRows(deleted, listState) {
  const byId = (listState && listState.byId) || {}
  return [...(deleted || [])]
    .sort((left, right) => right.deletedAt - left.deletedAt)
    .map((item) => ({
      sessionId: item.sessionId,
      path: item.path,
      deletedAt: item.deletedAt,
      title: (byId[item.sessionId] && byId[item.sessionId].displayTitle) || item.sessionId,
    }))
}

// Toast 差分守卫:连续两个 ready 快照才计新增(镜像 core.mjs archiveToastStep)。
// 模型订阅即时发射 pending 空态,基线(存量归档)成为第二帧;基线是重连权威而非
// 归档事件,启动与重连首装不误报。差分 Set 每帧构建一次,与 core.diffArchived 同构
function archiveToastStep(previous, snapshot) {
  const ready = Boolean(snapshot && snapshot.phase === 'ready')
  const ids = (snapshot && snapshot.archivedSessionIds) || []
  const baseline = previous !== undefined && previous.ready && ready ? new Set(previous.ids) : null
  const added = baseline ? ids.filter((id) => !baseline.has(id)) : []
  return { state: { ready, ids }, added }
}

function ArchiveRow(props) {
  const row = props.row
  const armed = props.armed
  const busy = props.busy
  const confirm = props.confirm
  const actions = armed
    ? [
        h('button', {
          key: 'confirm',
          className: 'sm-btn sm-btn--confirm',
          disabled: busy || !confirm || Boolean(confirm.error),
          onClick: props.onConfirm,
        }, '移入回收站'),
        h('button', { key: 'cancel', className: 'sm-btn', disabled: busy, onClick: props.onDisarm }, '取消'),
      ]
    : [
        h('button', { key: 'restore', className: 'sm-btn sm-btn--restore', disabled: busy, onClick: props.onUnarchive }, '恢复'),
        h('button', { key: 'delete', className: 'sm-btn sm-btn--danger', disabled: busy, onClick: props.onDelete }, '删除'),
      ]
  return h('div', {
    className: 'sm-row' + (armed ? ' sm-row--armed' : '') + (busy ? ' sm-row--busy' : ''),
  },
    armed && confirm && !confirm.error
      ? h('span', { key: 'meta', className: 'sm-row__size' }, confirm.missing ? '产物已丢失' : fmtSize(confirm.sizeBytes))
      : h('span', { key: 'meta', className: 'sm-row__time', title: new Date(row.updatedAt).toLocaleString() }, fmtTime(row.updatedAt)),
    h('span', { className: 'sm-row__title', title: row.title }, row.title),
    h('div', { className: 'sm-row__actions' }, actions),
    confirm && confirm.error ? h('span', { className: 'sm-row__error' }, confirm.error) : null,
  )
}

function DeletedRow(props) {
  const row = props.row
  const busy = props.busy
  return h('div', { className: 'sm-row' + (busy ? ' sm-row--busy' : '') },
    h('span', { key: 'meta', className: 'sm-row__time', title: new Date(row.deletedAt).toLocaleString() }, fmtTime(row.deletedAt)),
    h('span', { className: 'sm-row__title', title: row.title }, row.title),
    h('div', { className: 'sm-row__actions' },
      h('button', { key: 'remount', className: 'sm-btn sm-btn--restore', disabled: busy, onClick: props.onRemount }, '重新挂载'),
      h('button', { key: 'forget', className: 'sm-btn', disabled: busy, onClick: props.onForget }, '移除记录'),
    ),
    h('span', { className: 'sm-row__path', title: row.path }, '原位置 ' + row.path),
  )
}

// 已删除分区:仅非空渲染;还原指引在分区头部,行内提供重挂载与移除记录
function DeletedSection(props) {
  const rows = props.rows
  if (rows.length === 0) return null
  return h('div', { className: 'sm-deleted' },
    h('div', { className: 'sm-head' },
      h('span', { className: 'sm-head__title' }, '已删除'),
      h('span', { className: 'sm-head__count' }, rows.length + ' 条'),
    ),
    h('div', { className: 'sm-head__hint' },
      '到系统回收站将会话文件夹还原到原位置,再点「重新挂载」找回;清空回收站后无法找回。'),
    h('div', { className: 'sm-tray' },
      rows.map((row) => h(DeletedRow, {
        key: row.sessionId,
        row,
        busy: props.busyId === row.sessionId,
        onRemount: () => props.onRemount(row),
        onForget: () => props.onForget(row),
      }))),
  )
}

function SessionManagerApp(props) {
  const rows = props.rows
  const listState = props.listState
  const [busyId, setBusyId] = useState(null)
  const [armedId, setArmedId] = useState(null)
  const [confirms, setConfirms] = useState({})
  const [deleted, setDeleted] = useState([])
  const [periodic, setPeriodic] = useState(null)

  function refreshDeleted() {
    api(DELETED_URL)
      .then((payload) => setDeleted((payload && payload.deleted) || []))
      .catch((error) => {
        // 加载失败保留旧数据:清空会让用户误读为台账已清空(数据丢失假象)
        console.warn('[session-manager] 已删除列表加载失败', error)
      })
  }

  useEffect(() => { refreshDeleted() }, [])

  // 周期评估状态仅用于降级提示,加载失败按无提示处理
  useEffect(() => {
    api(STATUS_URL)
      .then((payload) => setPeriodic(payload && payload.periodic))
      .catch(() => {})
  }, [])

  function run(sessionId, action, successText) {
    setBusyId(sessionId)
    return action()
      .then((result) => {
        if (result && result.partial) toast(result.message, { kind: 'ok' })
        else if (result && result.message) toast(result.message, { kind: 'ok' })
        else toast(successText || '操作完成', { kind: 'ok' })
        setArmedId(null)
        setConfirms({})
      })
      .catch((error) => toast(error && error.message ? error.message : String(error), { kind: 'error', sticky: true }))
      .then(() => setBusyId(null))
  }

  function onDelete(row) {
    if (armedId !== row.id) {
      setArmedId(row.id)
      // 两段式确认:首段拉取标题 / 时间 / 体积;产物已缺失(missing)仍可确认,删除仅清理列表
      if (confirms[row.id] === undefined) {
        api(INFO_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
          .then((info) => setConfirms((prev) => ({ ...prev, [row.id]: info.supported
            ? { sizeBytes: info.sizeBytes, missing: Boolean(info.missing) }
            : { error: '当前存储后端不支持按会话删除' } })))
          .catch((error) => setConfirms((prev) => ({ ...prev, [row.id]: { error: String(error.message || error) } })))
      }
      return
    }
    void run(row.id, () => api(DELETE_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) }),
      '已移入系统回收站;还原后可在「已删除」区重新挂载')
      .then(refreshDeleted)
  }

  function onRemount(row) {
    void run(row.sessionId, () => api(REMOUNT_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.sessionId }) }),
      '已重新挂载,会话回到工作区列表')
      .then(refreshDeleted)
  }

  function onForget(row) {
    void run(row.sessionId, () => api(FORGET_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.sessionId }) }))
      .then(refreshDeleted)
  }

  return h('div', { className: 'sm-panel' },
    h('div', { className: 'sm-head' },
      h('span', { className: 'sm-head__title' }, '会话归档'),
      rows.length > 0 ? h('span', { className: 'sm-head__count' }, rows.length + ' 条') : null,
    ),
    h('div', { className: 'sm-head__hint' }, '恢复放回会话列表;删除移入系统回收站,可还原后重新挂载。'),
    periodic && periodic.running === false
      ? h('div', { className: 'sm-head__hint' },
          '周期评估未运行(' + (periodic.reason || '宿主定时服务不可用') + ');自动归档仍在新会话创建与启动时生效。')
      : null,
    h('div', { className: 'sm-tray' },
      rows.length === 0
        ? h('div', { className: 'sm-empty' },
            h('div', null, '还没有归档的会话'),
            h('div', { className: 'sm-empty__hint' }, '会话归档后集中显示在这里'))
        : rows.map((row) => h(ArchiveRow, {
            key: row.id,
            row,
            armed: armedId === row.id,
            busy: busyId === row.id,
            confirm: confirms[row.id],
            onUnarchive: () => {
              void run(row.id, () => api(UNARCHIVE_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) }))
            },
            onDelete: () => onDelete(row),
            onConfirm: () => onDelete(row),
            onDisarm: () => { setArmedId(null); setConfirms({}) },
          }))),
    h(DeletedSection, {
      rows: projectDeletedRows(deleted, listState),
      busyId,
      onRemount,
      onForget,
    }),
  )
}

// 历史输入浮层:Alt+↑ 快捷键唤起,平时零占位;浮层内点选或键盘(↑/↓ 选择、
// Enter 填入、Esc 关闭)回填历史,填入走宿主公共契约 inputActions.setDraft,
// 不直改编辑器 DOM。数据由 host 按当前会话所属工作区聚合,每次唤起即强刷
// 历史输入范围:索引即 ←/→ 切换顺序(← 向窄,→ 向宽),与 core.mjs HISTORY_SCOPES 同序
const HISTORY_SCOPE_LABELS = ['当前会话', '本工作区', '全部工作区']
// 单次请求最多解压的会话数档位(最近优先),与 core.mjs HISTORY_BATCH_LIMITS 同序同值
const HISTORY_BATCH_LIMITS = [3, 10, 20]

function HistoryDock({ session, inputActions }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [cursor, setCursor] = useState(-1)
  const [scopeIndex, setScopeIndex] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const rootRef = React.useRef(null)
  // 键盘层权威状态:监听器挂载一次(空依赖),读写全走 ref,规避 effect 重挂
  // 时序造成的闭包陈旧;state 仅驱动渲染,变更处双写
  const viewRef = React.useRef({ open: false, items: null, cursor: -1, scopeIndex: 0, limitIdx: 0, scanned: 0, total: 0, loadingMore: false })
  const sessionRef = React.useRef(session)
  const inputActionsRef = React.useRef(inputActions)
  sessionRef.current = session
  inputActionsRef.current = inputActions

  function syncView(patch) {
    viewRef.current = { ...viewRef.current, ...patch }
  }

  // host 响应信封 { inputs, scanned, total };解包并防御形态漂移,消费侧恒为数组。
  // 不传 refresh:host 会话级 TTL 缓存内不重复解压,缓存过期后由 host 自动重扫
  function fetchInputs(scope, limit) {
    return api(INPUTS_URL + '?sessionId=' + encodeURIComponent(sessionRef.current.sessionId) + '&scope=' + scope + '&limit=' + limit)
      .then((payload) => {
        const inputs = (payload && Array.isArray(payload.inputs)) ? payload.inputs : []
        return { inputs, scanned: payload && Number.isFinite(payload.scanned) ? payload.scanned : inputs.length, total: payload && Number.isFinite(payload.total) ? payload.total : inputs.length }
      })
  }

  function fill(text) {
    inputActionsRef.current.setDraft(text)
    syncView({ open: false })
    setOpen(false)
  }

  function openPopup() {
    syncView({ open: true, items: null, cursor: -1, scopeIndex: 0, limitIdx: 0, scanned: 0, total: 0, loadingMore: false })
    setOpen(true)
    setScopeIndex(0)
    setCursor(-1)
    setLoadingMore(false)
    setLoadError(false)
    setItems(null)
    fetchInputs('session', HISTORY_BATCH_LIMITS[0])
      .then((result) => {
        syncView({ items: result.inputs, cursor: -1, scanned: result.scanned, total: result.total })
        setItems(result.inputs)
        setCursor(-1)
      })
      .catch((error) => {
        syncView({ items: [] })
        setLoadError(true)
        setItems([])
        toast(error && error.message ? error.message : String(error), { kind: 'error' })
      })
  }

  // 切换范围:向宽(→)/向窄(←),边界停住;切换即按新范围首档拉取(已缓存会话秒回)
  function switchScope(delta) {
    const next = viewRef.current.scopeIndex + delta
    if (next < 0 || next >= HISTORY_SCOPE_LABELS.length) return
    syncView({ scopeIndex: next, items: null, cursor: -1, limitIdx: 0, scanned: 0, total: 0, loadingMore: false })
    setScopeIndex(next)
    setCursor(-1)
    setLoadingMore(false)
    setLoadError(false)
    setItems(null)
    fetchInputs(HISTORY_SCOPES[next], HISTORY_BATCH_LIMITS[0])
      .then((result) => {
        if (viewRef.current.scopeIndex !== next) return
        syncView({ items: result.inputs, cursor: -1, scanned: result.scanned, total: result.total })
        setItems(result.inputs)
        setCursor(-1)
      })
      .catch((error) => {
        if (viewRef.current.scopeIndex !== next) return
        syncView({ items: [] })
        setLoadError(true)
        setItems([])
        toast(error && error.message ? error.message : String(error), { kind: 'error' })
      })
  }

  // 滚动近底部逐档加深:仅扩大解压档位重新聚合(host 对已缓存会话不再解压),
  // 档位用尽或范围内会话已扫尽则不再请求
  function loadMore() {
    const view = viewRef.current
    if (!view.open || view.items === null || view.loadingMore) return
    const nextIdx = Math.min(view.limitIdx + 1, HISTORY_BATCH_LIMITS.length - 1)
    if (nextIdx === view.limitIdx || view.scanned >= view.total) return
    const scope = HISTORY_SCOPES[view.scopeIndex]
    syncView({ limitIdx: nextIdx, loadingMore: true })
    setLoadingMore(true)
    fetchInputs(scope, HISTORY_BATCH_LIMITS[nextIdx])
      .then((result) => {
        if (viewRef.current.scopeIndex !== view.scopeIndex || viewRef.current.limitIdx !== nextIdx) return
        const cursor = Math.min(viewRef.current.cursor, result.inputs.length - 1)
        syncView({ items: result.inputs, cursor, scanned: result.scanned, total: result.total, loadingMore: false })
        setItems(result.inputs)
        setCursor(cursor)
        setLoadingMore(false)
      })
      .catch(() => {
        // 加载更多失败保留现有列表,静默可重试(再次滚动触发)
        syncView({ loadingMore: false })
        setLoadingMore(false)
      })
  }

  function onListScroll(event) {
    const el = event.currentTarget
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return
    loadMore()
  }

  // Alt+↑ 唤起浮层;浮层开 = 菜单模态,捕获阶段拦截导航键,先于 Lexical 光标移动
  useEffect(() => {
    function onKeyDown(event) {
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
        event.preventDefault()
        event.stopPropagation()
        switchScope(event.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (view.items !== null && view.cursor >= 0 && view.cursor < view.items.length) fill(view.items[view.cursor].text)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        syncView({ open: false })
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // 浮层外点击关闭
  useEffect(() => {
    if (!open) return undefined
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [open])

  // 零高度锚点:平时不占任何界面空间,仅浮层打开时渲染
  if (session === undefined || inputActions === undefined) return null
  return h('div', { className: 'sm-hist', ref: rootRef },
    open && h('div', { className: 'sm-hist__pop' },
      h('div', { className: 'sm-hist__hint' },
        h('span', { className: 'sm-hist__scope' }, HISTORY_SCOPE_LABELS[scopeIndex]),
        '↑/↓ 选择,←/→ 切换范围,Enter 填入,Esc 关闭'),
      items === null
        ? h('div', { className: 'sm-hist__empty' }, '正在解析历史会话,首次加载可能较长,请稍候…')
        : items.length === 0
          ? h('div', { className: 'sm-hist__empty' }, loadError ? '历史输入加载失败,可关闭后重试' : '该范围内还没有历史输入')
          : h('div', { className: 'sm-hist__list', onScroll: onListScroll },
              items.map((item, index) => h('button', {
                key: index + ':' + item.at,
                className: 'sm-hist__row' + (index === cursor ? ' sm-hist__row--on' : ''),
                onClick: () => fill(item.text),
              },
                h('span', { className: 'sm-hist__text', title: item.text }, item.text),
                h('span', { className: 'sm-hist__time' }, fmtTime(item.at)),
              )),
              loadingMore && h('div', { className: 'sm-hist__more' }, '正在解析更多历史…'),
            ),
    ),
  )
}

    return {
      inject: ['slots', 'sessions', 'workspaces'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')

        // 样式挂载在宿主文档级:设置页未打开时面板不存在,
        // 样式若随面板注入则面板裸样式渲染
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-manager styles')

        // 归档快照差分:新增条数驱动通知
        let previous
        const unsubscribe = workspaces.list.subscribe(() => {
          const step = archiveToastStep(previous, workspaces.list.getSnapshot())
          previous = step.state
          if (step.added.length > 0) toast('有 ' + step.added.length + ' 个会话已归档')
        })

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'session-manager', order: 46, label: '会话归档' },
            () => React.createElement(SessionManagerPanel, { sessions, workspaces }),
          ))

        // 历史输入回溯入口:官方 conversation.input.dock 插槽(dsh-client-ui-goal 同构)。
        // 宿主缺该插槽时注册抛错即禁用本功能,不阻塞其余能力
        try {
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              { name: 'conversation.input.dock', id: 'session-manager-history', order: 90 },
              HistoryDock,
            ))
        } catch (error) {
          console.warn('[session-manager] 历史输入入口未注册(宿主无 conversation.input.dock 插槽)', error)
        }

        ctx.effect(() => unsubscribe, 'session-manager archived diff')

        function SessionManagerPanel({ sessions: sessionSvc, workspaces: workspaceSvc }) {
          const listState = useSnapshot(sessionSvc.list)
          const workspaceState = useSnapshot(workspaceSvc.list)
          return React.createElement(SessionManagerApp, {
            rows: projectRows(listState, (workspaceState && workspaceState.archivedSessionIds) || []),
            listState,
          })
        }
      },
    }
  },
})
