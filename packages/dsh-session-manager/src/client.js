// dsh-session-manager Client 半区:settings.section 归档面板 + 归档/操作反馈通知
// + 历史输入浮层(Alt+↑ 唤起,列表浏览与点选回填)。
// 归档快照来自官方 workspace.follow 客户端模型(ctx.get('workspaces')),会话行来自
// ctx.get('sessions');面板数据 = 会话行 ∩ 归档集合(纯投影),通知由 archived
// 增量帧的集合差分驱动,经公共依赖 @mzzsfy/dsh-toast 展示。历史输入挂官方
// conversation.input.dock 插槽(行数据由 host /api/session-manager/inputs 聚合),
// 回填走宿主公共契约 inputActions.setDraft。浏览器半区经 webServer
// 路由('/api/session-manager/*')访问 Host。打包为单文件自包含格式,无法跨文件
// require;与 src/core.mjs 镜像的纯函数(projectRows / archiveToastStep /
// archiveToastText / projectDeletedRows / pageArchiveRows /
// groupArchiveRowsByWorkspace / filterArchiveRows)修改需两处同步。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-session-manager',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useSyncExternalStore } = React

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;双键 = 分区 label + 市场
    // 短名(发现页收录显示形态);该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '会话归档': 'archive', 'dsh-session-manager': 'archive' }
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
  '.sm-row__title-wrap { display:flex; align-items:center; gap:6px; min-width:0; }',
  '.sm-row__ws { flex:none; max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;',
  '  padding:0 6px; border-radius:999px; font:11px/18px var(--ds-font-family-code, monospace);',
  '  color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-interactive-bg-hover); }',
  '.sm-row__ws--none { background:transparent; box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3); }',
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
  // 删除确认弹窗:遮罩 + 居中卡片;高 z-index 压过设置面板层,点击遮罩不关闭(强制显式选择)
  '.sm-dialog { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;',
  '  background:rgba(0,0,0,.45); }',
  '.sm-dialog__card { width:min(420px, calc(100vw - 48px)); border-radius:12px; padding:20px;',
  '  background:var(--dsw-alias-surface-primary, light-dark(#fff, #1f2126)); color:inherit;',
  '  box-shadow:0 12px 40px rgba(0,0,0,.3); }',
  '.sm-dialog__title { font:var(--dsw-font-m-strong-16, 600 16px/24px sans-serif);',
  '  color:var(--dsw-alias-state-error-primary); margin:0 0 10px; }',
  '.sm-dialog__body { font:var(--dsw-font-s-14, 14px/22px sans-serif); color:var(--dsw-alias-label-secondary); margin:0 0 8px; }',
  '.sm-dialog__warn { font:var(--dsw-font-s-14, 14px/22px sans-serif); color:var(--dsw-alias-state-error-primary); margin:0 0 16px; }',
  '.sm-dialog__actions { display:flex; justify-content:flex-end; gap:8px; }',
  '.sm-dialog__btn { border:1px solid var(--dsw-alias-border-l3); background:transparent; cursor:pointer;',
  '  padding:6px 16px; border-radius:8px; font:var(--dsw-font-s-strong-14); color:var(--dsw-alias-label-secondary); }',
  '.sm-dialog__btn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }',
  '.sm-dialog__btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }',
  '.sm-dialog__btn--confirm { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }',
  '.sm-dialog__btn--confirm:hover { background:var(--dsw-alias-interactive-bg-hover-danger); color:var(--dsw-alias-state-error-primary); }',
  '.sm-empty { padding:24px 12px; text-align:center; color:var(--dsw-alias-label-caption); }',
  '.sm-empty__hint { font:var(--dsw-font-xxs-12); margin-top:2px; }',
  // 归档库二级视图:工具行(搜索)与工作区分组、分页展开按钮
  '.sm-lib { display:flex; flex-direction:column; gap:8px; }',
  '.sm-libbar { display:flex; align-items:center; gap:8px; }',
  '.sm-libbar__search { flex:1; min-width:0; padding:4px 10px; border-radius:8px; color-scheme:light dark;',
  '  border:1px solid var(--dsw-alias-border-l3); background:transparent; color:inherit; font:var(--dsw-font-s-14); }',
  '.sm-libbar__search:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-1px; }',
  '.sm-libbar__count { flex:none; font:12px/18px var(--ds-font-family-code, monospace); color:var(--dsw-alias-label-caption); font-variant-numeric:tabular-nums; }',
  '.sm-group { display:flex; flex-direction:column; }',
  '.sm-group__head { display:flex; align-items:center; gap:8px; width:100%; border:0; background:transparent; cursor:pointer;',
  '  padding:8px 10px; border-radius:8px; text-align:left; color:inherit; font:var(--dsw-font-s-strong-14); }',
  '.sm-group__head:hover { background:var(--dsw-alias-interactive-bg-hover); }',
  '.sm-group__head:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-1px; }',
  '.sm-group__chev { flex:none; color:var(--dsw-alias-label-caption); transition:transform .15s ease; }',
  '.sm-group__head--on .sm-group__chev { transform:rotate(90deg); }',
  '.sm-group__name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
  '.sm-group__count { margin-left:auto; flex:none; font:12px/18px var(--ds-font-family-code, monospace); color:var(--dsw-alias-label-caption); font-variant-numeric:tabular-nums; }',
  '.sm-group__body { padding-bottom:4px; }',
  '.sm-more { display:block; width:100%; border:0; background:transparent; cursor:pointer; padding:8px;',
  '  text-align:center; border-radius:8px; font:var(--dsw-font-xxs-strong-12); color:var(--dsw-alias-label-caption); }',
  '.sm-more:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }',
  '.sm-more:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-1px; }',
  '@media (prefers-reduced-motion: reduce) { .sm-group__chev { transition:none; } }',
  '@media (prefers-reduced-motion: reduce) { .sm-row__actions { transition:none; } }',
  // 自动归档配置行:数值输入内联呈现,窄面板可换行
  '.sm-cfg { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:10px;',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:var(--dsw-alias-label-caption, rgba(127,127,127,.9)); }',
  '.sm-cfg__field { display:inline-flex; align-items:center; gap:4px; }',
  '.sm-cfg__field input { width:56px; padding:2px 6px; border-radius:6px; color-scheme:light dark;',
  '  border:1px solid light-dark(rgba(15,17,21,.18), rgba(255,255,255,.22));',
  '  background:transparent; color:inherit; font:inherit; }',
  '.sm-cfg__field input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary, #1677ff); outline-offset:0; }',
].join('\n')

const UNARCHIVE_URL = '/api/session-manager/unarchive'
const DELETE_URL = '/api/session-manager/delete'
const INFO_URL = '/api/session-manager/info'
const DELETED_URL = '/api/session-manager/deleted'
const REMOUNT_URL = '/api/session-manager/remount'
const FORGET_URL = '/api/session-manager/forget'
const STATUS_URL = '/api/session-manager/status'

// 删除确认链文案:两击行内确认后弹窗强提示,弹窗内确认才发请求。
// 删除产物不可再生,其他插件(用量统计等)依赖会话产物,删后其会话级数据一并消失
const DELETE_BUTTON_TITLE = '删除会话产物会影响其他插件的工作(用量统计等依赖会话产物);若无特殊需求,请不要删除。删除需再次行内确认与弹窗确认。'
const DELETE_DIALOG_TITLE = '确认删除该会话?'
const DELETE_DIALOG_BODY_PREFIX = '即将删除会话「'
const DELETE_DIALOG_BODY_SUFFIX = '」。'
const DELETE_DIALOG_WARN = '删除会影响其他插件的工作,若无特殊需求,请不要删除;删除后请到「已删除」区查看找回方式。'
const DELETE_TOAST_OS = '已移入系统回收站;还原后可在「已删除」区重新挂载'
const DELETE_TOAST_QUARANTINE = '环境无系统回收站,已移入插件回收区;可在「已删除」区直接重新挂载找回'

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

// 工作区路径末段(官方 workspaceTitleOf 同构,镜像 core.mjs 同名函数)
function workspaceTitleOf(path) {
  const trimmed = String(path).replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

// 会话所属工作区标题:workspace 账本(sessionIds)一级映射与官方
// dsh-client-ui-workspace workspaceBySession 同构;cwd 回退为本插件收紧决策
// (官方回退 cwd basename 无需命中工作区,此处要求命中登记路径,防未登记目录名
// 冒充工作区),未命中 null(未分组)(镜像 core.mjs workspaceTitleForSession)
function workspaceTitleForSession(workspaces, sessionId, cwd) {
  const items = Array.isArray(workspaces) ? workspaces : []
  for (const workspace of items) {
    if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      return workspace.title || (workspace.path ? workspaceTitleOf(workspace.path) : null)
    }
  }
  const normalizedCwd = cwd ? String(cwd).replace(/[/\\]+$/, '') : ''
  if (!normalizedCwd) return null
  for (const workspace of items) {
    if (workspace && workspace.path && String(workspace.path).replace(/[/\\]+$/, '') === normalizedCwd) {
      return workspace.title || workspaceTitleOf(workspace.path)
    }
  }
  return null
}

// 已归档会话面板行:官方会话行 ∩ 归档集合,按更新时间倒序;workspace 为所属
// 工作区标题或 null(镜像 core.mjs projectArchiveRows)
function projectRows(listState, archivedIds, workspaceState) {
  const archived = new Set(archivedIds)
  const byId = (listState && listState.byId) || {}
  const workspaces = (workspaceState && workspaceState.items) || []
  return Object.keys(byId)
    .filter((id) => archived.has(id))
    .map((id) => ({
      id,
      title: byId[id].displayTitle || id,
      updatedAt: byId[id].updatedAt,
      workspace: workspaceTitleForSession(workspaces, id, byId[id].cwd),
    }))
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

// 归档通知标题列举上限:超过该数只列前段并以「 等」收尾(镜像 core.mjs 同名常量)
const TOAST_MAX_TITLES = 3

// 归档通知文案:单个报标题,多个为计数加列举标题,标题数超展示阈值只列前段并以
// 「 等」收尾,计数恒为真实总数;标题缺失、空白或行不存在回退会话 id
// (镜像 core.mjs archiveToastText,修改需两处同步)
function archiveToastText(addedIds, rows) {
  const added = Array.isArray(addedIds) ? addedIds : []
  if (added.length === 0) return ''
  const safeRows = Array.isArray(rows) ? rows : []
  const titleById = new Map()
  for (const row of safeRows) {
    if (!row || row.id === undefined || row.id === null) continue
    const trimmed = String(row.title ?? '').trim()
    if (trimmed !== '') titleById.set(String(row.id), trimmed)
  }
  const names = added.map((id) => titleById.get(String(id)) || String(id))
  if (names.length === 1) return '会话「' + names[0] + '」已归档'
  const listed = names.slice(0, TOAST_MAX_TITLES)
  return '有 ' + names.length + ' 个会话已归档:' + listed.join('、') + (names.length > TOAST_MAX_TITLES ? ' 等' : '')
}

// 归档库主列表默认展开行数与手动展开步长(镜像 core.mjs 同名常量)
const ARCHIVE_PAGE_SIZE = 100

// 归档列表分页:取前 visibleCount 条并报告剩余量,非有限或非正可见数按 0 处理
// (镜像 core.mjs pageArchiveRows,修改需两处同步)
function pageArchiveRows(rows, visibleCount) {
  const list = Array.isArray(rows) ? rows : []
  const count = Number.isFinite(visibleCount) && visibleCount > 0 ? visibleCount : 0
  const visible = list.slice(0, count)
  return { visible, remaining: list.length - visible.length }
}

// 归档列表按工作区分组:workspace 假值并桶为未分组(null),组内保持输入序,
// 组间按组内最新 updatedAt 倒序(镜像 core.mjs groupArchiveRowsByWorkspace,修改需两处同步)
function groupArchiveRowsByWorkspace(rows) {
  const list = Array.isArray(rows) ? rows : []
  const byKey = new Map()
  for (const row of list) {
    const title = row.workspace ? String(row.workspace) : ''
    if (!byKey.has(title)) byKey.set(title, { workspace: title === '' ? null : title, latest: row.updatedAt, rows: [] })
    const group = byKey.get(title)
    group.rows.push(row)
    if (row.updatedAt > group.latest) group.latest = row.updatedAt
  }
  return [...byKey.values()]
    .sort((left, right) => right.latest - left.latest)
    .map(({ workspace, rows: groupRows }) => ({ workspace, rows: groupRows }))
}

// 归档列表标题搜索:查询词去首尾空白后按不区分大小写子串匹配标题,空查询原样
// 返回全量(镜像 core.mjs filterArchiveRows,修改需两处同步)
function filterArchiveRows(rows, query) {
  const list = Array.isArray(rows) ? rows : []
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return list
  return list.filter((row) => String(row.title ?? '').toLowerCase().includes(needle))
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
        h('button', { key: 'delete', className: 'sm-btn sm-btn--danger', disabled: busy, title: DELETE_BUTTON_TITLE, onClick: props.onDelete }, '删除'),
      ]
  return h('div', {
    className: 'sm-row' + (armed ? ' sm-row--armed' : '') + (busy ? ' sm-row--busy' : ''),
  },
    armed && confirm && !confirm.error
      ? h('span', { key: 'meta', className: 'sm-row__size' }, confirm.missing ? '产物已丢失' : fmtSize(confirm.sizeBytes))
      : h('span', { key: 'meta', className: 'sm-row__time', title: new Date(row.updatedAt).toLocaleString() }, fmtTime(row.updatedAt)),
    h('span', { className: 'sm-row__title-wrap' },
      row.workspace
        ? h('span', { className: 'sm-row__ws', title: row.workspace }, row.workspace)
        : h('span', { className: 'sm-row__ws sm-row__ws--none', title: '该会话不属于任何已登记工作区' }, '未分组'),
      h('span', { className: 'sm-row__title', title: row.title }, row.title),
    ),
    h('div', { className: 'sm-row__actions' }, actions),
    confirm && confirm.error ? h('span', { className: 'sm-row__error' }, confirm.error) : null,
  )
}

// 删除确认弹窗:确认链最后一环,行内两击确认之后仍需在此显式确认才发请求。
// 无确认前不发任何请求;遮罩不响应点击,取消与确认按钮是仅有的出口。
// 初始焦点落「取消」(安全默认出口),Escape 等价取消;不做焦点圈闭
// (tab 可离开弹窗但不会误触发删除,圈闭实现成本不成比例)
function DeleteDialog(props) {
  const row = props.row
  const busy = props.busy
  const cancelRef = useRef(null)
  useEffect(() => {
    if (cancelRef.current) cancelRef.current.focus()
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) props.onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return h('div', { className: 'sm-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'sm-dialog-title', 'aria-describedby': 'sm-dialog-body' },
    h('div', { className: 'sm-dialog__card' },
      h('p', { id: 'sm-dialog-title', className: 'sm-dialog__title' }, DELETE_DIALOG_TITLE),
      h('p', { id: 'sm-dialog-body', className: 'sm-dialog__body' }, DELETE_DIALOG_BODY_PREFIX + (row.title || row.id) + DELETE_DIALOG_BODY_SUFFIX),
      h('p', { className: 'sm-dialog__warn' }, DELETE_DIALOG_WARN),
      h('div', { className: 'sm-dialog__actions' },
        h('button', { ref: cancelRef, className: 'sm-dialog__btn', disabled: busy, onClick: props.onCancel }, '取消'),
        h('button', { className: 'sm-dialog__btn sm-dialog__btn--confirm', disabled: busy, onClick: props.onConfirm }, '确认删除'),
      ),
    ),
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
      '到系统回收站将会话文件夹还原到原位置,再点「重新挂载」找回;回收区暂存的会话直接点「重新挂载」即可找回;清空回收站后无法找回。'),
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
  // 删除弹窗受控状态:非 null 即弹窗展示中,确认后才真正发删除请求
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleted, setDeleted] = useState([])
  const [periodic, setPeriodic] = useState(null)
  // 归档库视图状态:recent 为主列表固定首页,library 为工作区分组浏览 + 标题
  // 搜索;分组默认收起,展开即见首页,组内沿用同一分页机制
  const [view, setView] = useState('recent')
  const [query, setQuery] = useState('')
  const [libraryCount, setLibraryCount] = useState(ARCHIVE_PAGE_SIZE)
  const [openGroups, setOpenGroups] = useState(() => new Set())
  const [groupCounts, setGroupCounts] = useState({})

  function toggleGroup(key) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function expandGroup(key) {
    setGroupCounts((prev) => ({ ...prev, [key]: (prev[key] || ARCHIVE_PAGE_SIZE) + ARCHIVE_PAGE_SIZE }))
  }

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

  // 删除确认链:击删除(拉体积)→ 行内确认 → 弹窗确认,弹窗内确认才发请求
  function onDelete(row) {
    if (armedId !== row.id) {
      setArmedId(row.id)
      // 首段拉取标题 / 时间 / 体积;产物已缺失(missing)仍可确认,删除仅清理列表
      if (confirms[row.id] === undefined) {
        api(INFO_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
          .then((info) => setConfirms((prev) => ({ ...prev, [row.id]: info.supported
            ? { sizeBytes: info.sizeBytes, missing: Boolean(info.missing) }
            : { error: '当前存储后端不支持按会话删除' } })))
          .catch((error) => setConfirms((prev) => ({ ...prev, [row.id]: { error: String(error.message || error) } })))
      }
      return
    }
    setPendingDelete(row)
  }

  // 弹窗确认:处置模式区分成功文案——两种模式找回路径不同
  function onDialogConfirm() {
    const row = pendingDelete
    if (row === null) return
    void run(row.id, async () => {
      const body = await api(DELETE_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }) })
      if (body && body.ok && !body.message) {
        return { ...body, message: body.mode === 'quarantine' ? DELETE_TOAST_QUARANTINE : DELETE_TOAST_OS }
      }
      return body
    }, DELETE_TOAST_OS).then(refreshDeleted)
    setPendingDelete(null)
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

  const renderArchiveRow = (row) => h(ArchiveRow, {
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
  })

  // 分页展开按钮:无余量不渲染(React 忽略 null 子节点);key 恒定,
  // 免得数组子节点内无 key 元素随页扩位触发不必要的卸载重挂
  const expandMore = (remaining, onMore) => remaining <= 0
    ? null
    : h('button', { key: 'more', className: 'sm-more', onClick: onMore }, '展开更多(剩 ' + remaining + ' 条)')

  // 主列表(最近归档):固定首页不翻页,尾部「按工作区浏览」入口跳转二级视图看全部
  const recentPage = pageArchiveRows(rows, ARCHIVE_PAGE_SIZE)
  const recentTray = h('div', { className: 'sm-tray' },
    rows.length === 0
      ? h('div', { className: 'sm-empty' },
          h('div', null, '还没有归档的会话'),
          h('div', { className: 'sm-empty__hint' }, '会话归档后集中显示在这里'))
      : [...recentPage.visible.map(renderArchiveRow),
        recentPage.remaining > 0
          ? h('button', { key: 'more', className: 'sm-more', onClick: () => setView('library') }, '按工作区浏览')
          : null],
  )

  // 归档库区域:有搜索词时命中平铺(分页),无搜索词按工作区分组(默认收起);
  // 仅二级视图构建,recent 视图不做分组与搜索投影,防大集合重渲染放大
  function renderLibrary() {
    const searching = query.trim() !== ''
    const matchedRows = filterArchiveRows(rows, query)
    const searchPage = pageArchiveRows(matchedRows, libraryCount)
    const tray = rows.length === 0
      ? h('div', { className: 'sm-empty' }, '还没有归档的会话')
      : searching
        ? (matchedRows.length === 0
            ? h('div', { className: 'sm-empty' }, '没有匹配的归档会话')
            : h('div', { className: 'sm-tray' },
                [...searchPage.visible.map(renderArchiveRow),
                  expandMore(searchPage.remaining, () => setLibraryCount((count) => count + ARCHIVE_PAGE_SIZE))]))
        : h('div', { className: 'sm-tray' },
            groupArchiveRowsByWorkspace(rows).map((group) => {
              // 未分组桶键为空串,空串本身是合法 React key,直接用桶键防与用户标题撞车
              const key = group.workspace || ''
              const open = openGroups.has(key)
              const page = pageArchiveRows(group.rows, groupCounts[key] || ARCHIVE_PAGE_SIZE)
              return h('div', { className: 'sm-group', key },
                h('button', {
                  className: 'sm-group__head' + (open ? ' sm-group__head--on' : ''),
                  'aria-expanded': open,
                  onClick: () => toggleGroup(key),
                },
                  h('span', { className: 'sm-group__chev', 'aria-hidden': 'true' }, '▸'),
                  h('span', { className: 'sm-group__name' }, group.workspace || '未分组'),
                  h('span', { className: 'sm-group__count' }, group.rows.length + ' 条'),
                ),
                open
                  ? h('div', { className: 'sm-group__body' },
                      page.visible.map(renderArchiveRow),
                      expandMore(page.remaining, () => expandGroup(key)))
                  : null,
              )
            }))
    return h('div', { className: 'sm-lib' },
      h('div', { className: 'sm-libbar' },
        h('input', {
          className: 'sm-libbar__search',
          type: 'search',
          placeholder: '搜索会话标题',
          'aria-label': '搜索会话标题',
          value: query,
          // 搜索词变化即重置平铺分页:命中集变小后旧可见数无意义
          onChange: (event) => { setQuery(event.target.value); setLibraryCount(ARCHIVE_PAGE_SIZE) },
        }),
        searching ? h('span', { className: 'sm-libbar__count' }, matchedRows.length + ' 条匹配') : null,
      ),
      tray,
    )
  }

  const archiveRegion = view === 'recent' ? recentTray : renderLibrary()

  return h('div', { className: 'sm-panel' },
    view === 'recent'
      ? h('div', { className: 'sm-head' },
          h('span', { className: 'sm-head__title' }, '会话归档'),
          rows.length > 0 ? h('span', { className: 'sm-head__count' }, rows.length + ' 条') : null,
          rows.length > 0
            ? h('button', { className: 'sm-btn', onClick: () => setView('library') }, '按工作区浏览 ›')
            : null,
        )
      : h('div', { className: 'sm-head' },
          h('button', { className: 'sm-btn', onClick: () => setView('recent') }, '‹ 返回'),
          h('span', { className: 'sm-head__title' }, '按工作区浏览'),
          h('span', { className: 'sm-head__count' }, rows.length + ' 条'),
        ),
    h('div', { className: 'sm-head__hint' }, '恢复放回会话列表;删除移入系统回收站(无回收站环境移入插件回收区),可经「已删除」区找回。'),
    periodic && periodic.running === false
      ? h('div', { className: 'sm-head__hint' },
          '周期评估未运行(' + (periodic.reason || '宿主定时服务不可用') + ');自动归档仍在新会话创建与启动时生效。')
      : null,
    archiveRegion,
    h(DeletedSection, {
      rows: projectDeletedRows(deleted, listState),
      busyId,
      onRemount,
      onForget,
    }),
    h(AutoArchiveConfig, null),
    pendingDelete !== null
      ? h(DeleteDialog, {
          row: pendingDelete,
          busy: busyId === pendingDelete.id,
          onCancel: () => setPendingDelete(null),
          onConfirm: onDialogConfirm,
        })
      : null,
  )
}

// 面板设置项悬停说明:原生 title(设置侧栏为滚动容器,CSS 气泡会被 overflow
// 裁剪,JS 定位复杂度不成比例);文案与功能行为同源维护,由源码契约测试锁定
const ARCHIVE_OVERVIEW_TITLE = '超过阈值天数未活跃的会话自动移入归档;触发时机为新会话创建、插件启动与周期检查;归档会话在本面板管理,可恢复或删除。'
const ARCHIVE_DAYS_TITLE = '会话超过该天数未活跃(产物无更新)即自动归档,空白(无消息)会话不参与归档;0 = 关闭自动归档。仅对产物可读的会话评估,产物不可读的跳过以免误归档,已归档的会话不会重复处理。'
const ARCHIVE_INTERVAL_TITLE = '周期检查的间隔小时数,到期会话在下一轮检查时归档;0 = 关闭周期检查(新会话创建与插件启动时的检查不受影响);调小最迟等新间隔即可提前触发,调大自下一轮排期起生效。'

// 自动归档配置:阈值天数与检查周期小时数,数值语义,失焦或 Enter 单字段即时提交;
// 值存宿主 settings(与评估逻辑同源,0 = 关闭),非法输入前端拒绝不发包,
// 服务端失败后回读生效值回滚显示
const AUTO_ARCHIVE_URL = '/api/session-manager/auto-archive'

// 提交判定三态(镜像 core.mjs classifyAutoArchiveInput):noop 值未变 /
// invalid 非非负整数 / post 可提交;受控输入下显示值随击键同步,提交守卫
// 必须对照已提交值而非显示值
function classifyAutoArchiveInput(committedText, text) {
  const trimmed = text.trim()
  if (trimmed === committedText) return { action: 'noop' }
  const value = Number(trimmed)
  if (trimmed === '' || !Number.isInteger(value) || value < 0) return { action: 'invalid' }
  return { action: 'post', value }
}

function AutoArchiveConfig() {
  const [state, setState] = useState(null)
  // 已提交值快照:非法输入与保存失败的回滚基准,与编辑中的显示值分离
  const committedRef = React.useRef(null)
  useEffect(() => {
    api(AUTO_ARCHIVE_URL)
      .then((payload) => {
        if (!payload) return
        const next = { days: String(payload.days), intervalHours: String(payload.intervalHours) }
        committedRef.current = next
        setState(next)
      })
      .catch((error) => { console.warn('[session-manager] 自动归档配置读取失败', error) })
  }, [])
  function refresh() {
    return api(AUTO_ARCHIVE_URL)
      .then((payload) => {
        if (!payload) return
        const next = { days: String(payload.days), intervalHours: String(payload.intervalHours) }
        committedRef.current = next
        setState(next)
      })
      .catch((error) => { console.warn('[session-manager] 自动归档配置回读失败', error) })
  }
  function commit(field, text) {
    const committed = committedRef.current
    if (committed === null) return
    // 提交判定与 core.mjs classifyAutoArchiveInput 镜像同规:受控输入下显示值已随
    // 击键同步,守卫必须对已提交基准比较,与显示值比较恒相等
    const verdict = classifyAutoArchiveInput(committed[field], text)
    if (verdict.action === 'noop') return
    if (verdict.action === 'invalid') {
      setState({ ...committed })
      toast('自动归档配置须为非负整数', { kind: 'error' })
      return
    }
    const value = verdict.value
    api(AUTO_ARCHIVE_URL, { method: 'POST', body: JSON.stringify({ [field]: value }) })
      .then((payload) => {
        // 仅合回已提交字段,不清掉另一字段的未提交编辑
        const saved = String(payload[field])
        committedRef.current = { ...committedRef.current, [field]: saved }
        setState((prev) => (prev === null ? prev : { ...prev, [field]: saved }))
        toast('自动归档配置已保存')
      })
      .catch(() => {
        toast('自动归档配置保存失败', { kind: 'error' })
        void refresh()
      })
  }
  if (state === null) return null
  const numberInput = (field) => h('input', {
    type: 'number', min: 0, step: 1, value: state[field],
    onChange: (event) => setState((prev) => (prev === null ? prev : { ...prev, [field]: event.target.value })),
    // Enter 经 blur 走同一提交路径,避免与 onBlur 双触发重复提交
    onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() },
    onBlur: (event) => commit(field, event.target.value),
  })
  return h('div', { className: 'sm-cfg' },
    h('span', { title: ARCHIVE_OVERVIEW_TITLE }, '自动归档'),
    h('label', { className: 'sm-cfg__field', title: ARCHIVE_DAYS_TITLE }, '阈值', numberInput('days'), '天未活跃(0 关闭)'),
    h('label', { className: 'sm-cfg__field', title: ARCHIVE_INTERVAL_TITLE }, '检查周期', numberInput('intervalHours'), '小时(0 关闭)'),
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
          // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-session-manager')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-manager styles')

        // 归档快照差分:新增驱动通知,文案携带会话标题
        let previous
        const unsubscribe = workspaces.list.subscribe(() => {
          const step = archiveToastStep(previous, workspaces.list.getSnapshot())
          previous = step.state
          if (step.added.length > 0) {
            // 会话行快照与面板投影同源取 byId,标题映射为通知文案行数据
            const listState = sessions.list.getSnapshot()
            const byId = (listState && listState.byId) || {}
            const rows = Object.keys(byId).map((id) => ({ id, title: byId[id].displayTitle }))
            toast(archiveToastText(step.added, rows))
          }
        })

        // 工作区文件夹运行标记:服务状态驱动的侧边栏组头标注——官方折叠组不渲染
        // 会话行(deriveGroups 的 sessions 为空数组),DOM 扫描对折叠态失效,
        // 归属与运行态一律取服务快照;DOM 仅按下标对位官方组容器(渲染序 = 快照
        // items 序,未分组桶恒在末位)。开关拉取失败按启用兜底;拉取未决期间仅清除
        // 不标记(停用用户刷新不闪现),缺 MutationObserver 或 querySelectorAll 的
        // 环境(异常宿主)整体跳过,不阻塞其余能力

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
            rows: projectRows(listState, (workspaceState && workspaceState.archivedSessionIds) || [], workspaceState),
            listState,
          })
        }
      },
    }
  },
})
