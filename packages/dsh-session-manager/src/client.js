// dsh-session-manager Client 半区:settings.section 归档面板 + shell.overlay 归档 Toast。
// 归档快照来自官方 workspace.follow 客户端模型(ctx.get('workspaces')),会话行来自
// ctx.get('sessions');面板数据 = 会话行 ∩ 归档集合(纯投影),Toast 由 archived
// 增量帧的集合差分驱动。浏览器半区经 webServer 路由('/api/session-manager/*')访问 Host。

window.__ModuleLoader__.load({
  id: 'dsh-session-manager',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useSyncExternalStore } = React

const CSS = [
  '.sm-panel { display:flex; flex-direction:column; gap:12px; color:inherit; font-size:13px; }',
  '.sm-head { display:flex; align-items:center; gap:8px; }',
  '.sm-head__title { font-weight:600; font-size:14px; }',
  '.sm-head__hint { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.sm-btn { cursor:pointer; border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); background:transparent;',
  '  color:inherit; border-radius:6px; padding:3px 10px; font-size:12px; }',
  '.sm-btn:hover { opacity:0.8; }',
  '.sm-btn:disabled { opacity:0.45; cursor:default; }',
  '.sm-btn--danger { color:var(--dsw-alias-state-error-primary, #d43a3a); border-color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.sm-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); flex-wrap:wrap; }',
  '.sm-row__title { font-weight:600; }',
  '.sm-row__time { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.sm-row__size { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.sm-spacer { flex:1; }',
  '.sm-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }',
  '.sm-notice { font-size:12px; padding:4px 8px; border-radius:6px;',
  '  border:1px solid var(--dsw-alias-separator-primary, rgba(128,128,128,0.35)); }',
  '.sm-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.sm-notice--ok { color:var(--dsw-alias-state-success-primary, #1a9e55); }',
  '.sm-toast { position:fixed; left:50%; bottom:32px; transform:translateX(-50%); z-index:60;',
  '  background:var(--dsw-alias-toast-bg, rgba(22,24,28,0.94)); color:#f0f1f3; font-size:13px;',
  '  padding:8px 16px; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.3); }',
].join('\n')

const UNARCHIVE_URL = '/api/session-manager/unarchive'
const DELETE_URL = '/api/session-manager/delete'
const INFO_URL = '/api/session-manager/info'

// Toast 持续时长,设计文档定值
const TOAST_HOLD_MS = 4 * 1000

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
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
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

// 已归档会话面板行:官方会话行 ∩ 归档集合,按更新时间倒序
function projectRows(listState, archivedIds) {
  const archived = new Set(archivedIds)
  const byId = (listState && listState.byId) || {}
  return Object.keys(byId)
    .filter((id) => archived.has(id))
    .map((id) => ({ id, title: byId[id].displayTitle || id, updatedAt: byId[id].updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

function ArchiveRow(props) {
  const row = props.row
  const armed = props.armed
  const busy = props.busy
  const confirm = props.confirm
  return h('div', { className: 'sm-row' },
    h('span', { className: 'sm-row__title' }, row.title),
    h('span', { className: 'sm-row__time' }, fmtTime(row.updatedAt)),
    confirm ? h('span', { className: 'sm-row__size' }, fmtSize(confirm.sizeBytes)) : null,
    confirm && confirm.error ? h('span', { className: 'sm-meta' }, confirm.error) : null,
    h('span', { className: 'sm-spacer' }),
    h('button', { className: 'sm-btn', disabled: busy, onClick: props.onUnarchive }, '取消归档'),
    h('button', {
      className: 'sm-btn sm-btn--danger',
      disabled: busy,
      onClick: props.onDelete,
    }, armed ? '确认删除(移入回收站)' : '删除'),
  )
}

function SessionManagerApp(props) {
  const actions = props.actions
  const [notice, setNotice] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [armedId, setArmedId] = useState(null)
  const [confirms, setConfirms] = useState({})

  const rows = projectRows(props.listState, props.archivedIds)

  function run(sessionId, action) {
    setBusyId(sessionId)
    return action()
      .then((result) => {
        if (result && result.partial) setNotice({ kind: 'ok', text: result.message })
        else if (result && result.message) setNotice({ kind: 'ok', text: result.message })
        else setNotice({ kind: 'ok', text: '操作完成' })
        setArmedId(null)
        setConfirms({})
      })
      .catch((error) => setNotice({ kind: 'error', text: error && error.message ? error.message : String(error) }))
      .then(() => setBusyId(null))
  }

  function onDelete(row) {
    if (armedId !== row.id) {
      setArmedId(row.id)
      // 两段式确认:首段拉取标题 / 时间 / 体积
      if (confirms[row.id] === undefined) {
        api(INFO_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
          .then((info) => setConfirms((prev) => ({ ...prev, [row.id]: info.supported
            ? { sizeBytes: info.sizeBytes }
            : { error: '当前存储后端不支持按会话删除' } })))
          .catch((error) => setConfirms((prev) => ({ ...prev, [row.id]: { error: String(error.message || error) } })))
      }
      return
    }
    void run(row.id, () => api(DELETE_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) }))
  }

  return h('div', { className: 'sm-panel' },
    h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
    h('div', { className: 'sm-head' },
      h('span', { className: 'sm-head__title' }, '归档会话'),
      h('span', { className: 'sm-head__hint' }, '删除仅对已归档会话生效,内容移入系统回收站,可还原'),
    ),
    notice !== null ? h('div', { className: 'sm-notice sm-notice--' + notice.kind }, notice.text) : null,
    rows.length === 0 ? h('span', { className: 'sm-meta' }, '暂无已归档会话') : null,
    rows.map((row) => h(ArchiveRow, {
      key: row.id,
      row,
      armed: armedId === row.id,
      busy: busyId === row.id,
      confirm: confirms[row.id],
      onUnarchive: () => {
        void run(row.id, () => api(UNARCHIVE_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) }))
      },
      onDelete: () => onDelete(row),
    })),
  )
}

// 归档 Toast:archived 增量帧带来的新增条数;key 保证重复提示可重放
function ArchiveToast(props) {
  const text = props.toastText
  if (text === null || text === undefined) return null
  return h('div', { className: 'sm-toast', role: 'alert' }, text)
}

    return {
      inject: ['slots', 'sessions', 'workspaces'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')

        // 归档快照差分:新增条数驱动 Toast;基线首帧(无前值)不提示
        let previousArchived
        let toastText = null
        const toastListeners = new Set()
        const emitToast = (text) => {
          toastText = text
          for (const listener of toastListeners) listener()
        }
        const toastSource = {
          getSnapshot: () => toastText,
          subscribe: (listener) => {
            toastListeners.add(listener)
            return () => toastListeners.delete(listener)
          },
        }
        const unsubscribe = workspaces.list.subscribe(() => {
          const snapshot = workspaces.list.getSnapshot()
          const nextIds = (snapshot && snapshot.archivedSessionIds) || []
          const added = diffIds(previousArchived, nextIds)
          previousArchived = nextIds
          if (added.length > 0) emitToast('有 ' + added.length + ' 个会话已归档')
        })

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'session-manager', order: 46, label: '会话归档' },
            () => React.createElement(SessionManagerPanel, { sessions, workspaces }),
          ))
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'session-manager-toast' },
            () => React.createElement(OverlayToast, { source: toastSource }),
          ))

        ctx.effect(() => unsubscribe, 'session-manager archived diff')

        function SessionManagerPanel({ sessions: sessionSvc, workspaces: workspaceSvc }) {
          const listState = useSnapshot(sessionSvc.list)
          const workspaceState = useSnapshot(workspaceSvc.list)
          return React.createElement(SessionManagerApp, {
            listState,
            archivedIds: (workspaceState && workspaceState.archivedSessionIds) || [],
          })
        }

        function OverlayToast({ source }) {
          const text = useSyncExternalStore(source.subscribe, source.getSnapshot)
          useEffect(() => {
            if (text === null || text === undefined) return
            const timer = setTimeout(() => emitToast(null), TOAST_HOLD_MS)
            return () => clearTimeout(timer)
          }, [text])
          return React.createElement(ArchiveToast, { toastText: text })
        }
      },
    }

    function diffIds(previousIds, nextIds) {
      if (previousIds === undefined) return []
      const previous = new Set(previousIds)
      return nextIds.filter((id) => !previous.has(id))
    }
  },
})
