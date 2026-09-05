// dsh-session-manager Client 半区:settings.section 归档面板 + 归档/操作反馈通知。
// 归档快照来自官方 workspace.follow 客户端模型(ctx.get('workspaces')),会话行来自
// ctx.get('sessions');面板数据 = 会话行 ∩ 归档集合(纯投影),通知由 archived
// 增量帧的集合差分驱动,经公共依赖 @mzzsfy/dsh-toast 展示。浏览器半区经 webServer
// 路由('/api/session-manager/*')访问 Host。打包为单文件自包含格式,无法跨文件
// require;与 src/core.mjs 镜像的纯函数(projectArchiveRows / archiveToastStep)
// 修改需两处同步。

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
].join('\n')

const UNARCHIVE_URL = '/api/session-manager/unarchive'
const DELETE_URL = '/api/session-manager/delete'
const INFO_URL = '/api/session-manager/info'
const DELETED_URL = '/api/session-manager/deleted'
const REMOUNT_URL = '/api/session-manager/remount'
const FORGET_URL = '/api/session-manager/forget'
const STATUS_URL = '/api/session-manager/status'

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
// 归档事件,启动与重连首装不误报。差分用 Set,与 core.diffArchived 同构
function archiveToastStep(previous, snapshot) {
  const ready = Boolean(snapshot && snapshot.phase === 'ready')
  const ids = (snapshot && snapshot.archivedSessionIds) || []
  const added = previous !== undefined && previous.ready && ready
    ? ids.filter((id) => !new Set(previous.ids).has(id))
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
