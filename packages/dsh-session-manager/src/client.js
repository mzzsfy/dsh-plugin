// dsh-session-manager Client 半区:settings.section 归档面板 + shell.overlay 归档 Toast。
// 归档快照来自官方 workspace.follow 客户端模型(ctx.get('workspaces')),会话行来自
// ctx.get('sessions');面板数据 = 会话行 ∩ 归档集合(纯投影),Toast 由 archived
// 增量帧的集合差分驱动。浏览器半区经 webServer 路由('/api/session-manager/*')访问 Host。
// 打包为单文件自包含格式,无法跨文件 require;与 src/core.mjs 镜像的纯函数
// (projectArchiveRows / archiveToastStep)修改需两处同步。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-session-manager',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useSyncExternalStore } = React

// 主题令牌走官方 alias 变量并带兜底;中性色用 currentColor 调和,双主题自适应
const CSS = [
  '.sm-panel { display:flex; flex-direction:column; gap:10px; color:inherit; font-size:13px; }',
  '.sm-head { display:flex; align-items:baseline; gap:8px; }',
  '.sm-head__title { font-weight:600; font-size:14px; letter-spacing:.01em; }',
  '.sm-head__count { color:var(--dsw-alias-label-secondary, #8a8f98); font-size:12px; font-variant-numeric:tabular-nums; }',
  '.sm-head__hint { color:var(--dsw-alias-label-secondary, #8a8f98); font-size:12px; }',
  '.sm-list { display:flex; flex-direction:column; }',
  '.sm-row { display:grid; grid-template-columns:minmax(0, 1fr) auto auto auto; align-items:center; gap:12px;',
  '  padding:7px 10px; border-radius:8px; border-left:2px solid transparent; }',
  '.sm-row:hover { background:color-mix(in srgb, currentColor 6%, transparent); }',
  '.sm-row--armed { border-left-color:var(--dsw-alias-state-error-primary, #d43a3a);',
  '  background:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d43a3a) 8%, transparent); }',
  '.sm-row--busy { opacity:.5; pointer-events:none; }',
  '.sm-row__title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-row__time, .sm-row__size { color:var(--dsw-alias-label-secondary, #8a8f98); font-size:12px; font-variant-numeric:tabular-nums; }',
  '.sm-row__error { grid-column:1 / -1; color:var(--dsw-alias-state-error-primary, #d43a3a); font-size:12px; }',
  '.sm-row__actions { display:flex; gap:4px; justify-content:flex-end; }',
  '.sm-btn { border:0; background:transparent; color:inherit; cursor:pointer; padding:3px 8px;',
  '  border-radius:6px; font-size:12px; font-family:inherit; }',
  '.sm-btn:hover { background:color-mix(in srgb, currentColor 10%, transparent); }',
  '.sm-btn:disabled { opacity:.45; cursor:default; background:transparent; }',
  '.sm-btn--danger { color:var(--dsw-alias-state-error-primary, #d43a3a); }',
  '.sm-btn--confirm { border:1px solid var(--dsw-alias-state-error-primary, #d43a3a); font-weight:600; }',
  '.sm-empty { padding:18px 10px; text-align:center; color:var(--dsw-alias-label-secondary, #8a8f98); }',
  '.sm-empty__hint { font-size:12px; margin-top:4px; opacity:.8; }',
  '.sm-notice { font-size:12px; padding:5px 9px; border-radius:6px; }',
  '.sm-notice--error { color:var(--dsw-alias-state-error-primary, #d43a3a);',
  '  background:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d43a3a) 8%, transparent); }',
  '.sm-notice--ok { color:var(--dsw-alias-state-success-primary, #1a9e55);',
  '  background:color-mix(in srgb, var(--dsw-alias-state-success-primary, #1a9e55) 8%, transparent); }',
  '.sm-toast { position:fixed; left:50%; bottom:32px; transform:translateX(-50%); z-index:60;',
  '  background:var(--dsw-alias-toast-bg, rgba(22,24,28,0.94)); color:#f0f1f3; font-size:13px;',
  '  padding:8px 16px; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.3);',
  '  animation:sm-toast-in 0.18s ease-out; }',
  '@keyframes sm-toast-in { from { transform:translate(-50%, 8px); opacity:0; } to { transform:translate(-50%, 0); opacity:1; } }',
  '@media (prefers-reduced-motion: reduce) { .sm-toast { animation:none; } }',
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

// 已归档会话面板行:官方会话行 ∩ 归档集合,按更新时间倒序(镜像 core.mjs projectArchiveRows)
function projectRows(listState, archivedIds) {
  const archived = new Set(archivedIds)
  const byId = (listState && listState.byId) || {}
  return Object.keys(byId)
    .filter((id) => archived.has(id))
    .map((id) => ({ id, title: byId[id].displayTitle || id, updatedAt: byId[id].updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

// Toast 差分守卫:连续两个 ready 快照才计新增(镜像 core.mjs archiveToastStep)。
// 模型订阅即时发射 pending 空态,基线(存量归档)成为第二帧;基线是重连权威而非
// 归档事件,启动与重连首装不误报。
function archiveToastStep(previous, snapshot) {
  const ready = Boolean(snapshot && snapshot.phase === 'ready')
  const ids = (snapshot && snapshot.archivedSessionIds) || []
  const added = previous !== undefined && previous.ready && ready
    ? ids.filter((id) => !previous.ids.includes(id))
    : []
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
        h('button', { key: 'unarchive', className: 'sm-btn', disabled: busy, onClick: props.onUnarchive }, '恢复'),
        h('button', { key: 'delete', className: 'sm-btn sm-btn--danger', disabled: busy, onClick: props.onDelete }, '删除'),
      ]
  return h('div', {
    className: 'sm-row' + (armed ? ' sm-row--armed' : '') + (busy ? ' sm-row--busy' : ''),
    title: row.title,
  },
    h('span', { className: 'sm-row__title' }, row.title),
    h('span', { className: 'sm-row__time' }, fmtTime(row.updatedAt)),
    confirm && !confirm.error ? h('span', { className: 'sm-row__size' }, fmtSize(confirm.sizeBytes)) : null,
    h('div', { className: 'sm-row__actions' }, actions),
    confirm && confirm.error ? h('span', { className: 'sm-row__error' }, confirm.error) : null,
  )
}

function SessionManagerApp(props) {
  const rows = props.rows
  const [notice, setNotice] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [armedId, setArmedId] = useState(null)
  const [confirms, setConfirms] = useState({})

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
    h('div', { className: 'sm-head' },
      h('span', { className: 'sm-head__title' }, '会话归档'),
      rows.length > 0 ? h('span', { className: 'sm-head__count' }, rows.length + ' 条') : null,
    ),
    h('div', { className: 'sm-head__hint' }, '删除进入系统回收站,可还原;恢复把会话放回工作区列表。'),
    notice !== null ? h('div', { className: 'sm-notice sm-notice--' + notice.kind }, notice.text) : null,
    rows.length === 0
      ? h('div', { className: 'sm-empty' },
          h('div', null, '没有已归档的会话'),
          h('div', { className: 'sm-empty__hint' }, '会话归档后会集中显示在这里'))
      : h('div', { className: 'sm-list' }, rows.map((row) => h(ArchiveRow, {
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
  )
}

// 归档 Toast:archived 增量帧带来的新增条数;seq 单调递增保证同文案重复提示
// 也会重渲染(计时器重置 + 入场动画重放)
function ArchiveToast(props) {
  const text = props.toast.text
  if (text === null || text === undefined) return null
  return h('div', { className: 'sm-toast', role: 'alert' }, text)
}

    return {
      inject: ['slots', 'sessions', 'workspaces'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')

        // 样式挂载在宿主文档级:Toast 渲染于 shell.overlay 槽位,设置页未打开时
        // 面板不存在,样式若随面板注入则 Toast 裸样式渲染
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-manager styles')

        // 归档快照差分:新增条数驱动 Toast;快照以 {seq, text} 存放,seq 变化即重渲染
        let previous
        let toastSeq = 0
        let toast = { seq: toastSeq, text: null }
        const toastListeners = new Set()
        const emitToast = (text) => {
          toast = { seq: ++toastSeq, text }
          for (const listener of toastListeners) listener()
        }
        const toastSource = {
          getSnapshot: () => toast,
          subscribe: (listener) => {
            toastListeners.add(listener)
            return () => toastListeners.delete(listener)
          },
        }
        const unsubscribe = workspaces.list.subscribe(() => {
          const step = archiveToastStep(previous, workspaces.list.getSnapshot())
          previous = step.state
          if (step.added.length > 0) emitToast('有 ' + step.added.length + ' 个会话已归档')
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
            rows: projectRows(listState, (workspaceState && workspaceState.archivedSessionIds) || []),
          })
        }

        function OverlayToast({ source }) {
          const current = useSyncExternalStore(source.subscribe, source.getSnapshot)
          useEffect(() => {
            if (current.text === null || current.text === undefined) return
            const timer = setTimeout(() => emitToast(null), TOAST_HOLD_MS)
            return () => clearTimeout(timer)
          }, [current.seq])
          return React.createElement(ArchiveToast, { key: current.seq, toast: current })
        }
      },
    }
  },
})
