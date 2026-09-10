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
  '.sm-histsw { display:inline-flex; align-items:center; gap:8px; margin-top:10px; cursor:pointer;',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:var(--dsw-alias-label-caption, rgba(127,127,127,.9)); }',
  '.sm-histsw input[type="checkbox"] { position:absolute; width:1px; height:1px; margin:-1px; opacity:0; }',
  '.sm-histsw__track { position:relative; flex:none; width:28px; height:16px; border-radius:999px;',
  '  background:light-dark(rgba(15,17,21,.22), rgba(255,255,255,.26)); transition:background .15s; }',
  '.sm-histsw__thumb { position:absolute; left:2px; top:2px; width:12px; height:12px; border-radius:999px;',
  '  background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25); transition:transform .15s; }',
  '.sm-histsw input[type="checkbox"]:checked + .sm-histsw__track { background:#1677ff; }',
  '.sm-histsw input[type="checkbox"]:checked + .sm-histsw__track .sm-histsw__thumb { transform:translateX(12px); }',
  '.sm-histsw input[type="checkbox"]:focus-visible + .sm-histsw__track { outline:2px solid #1677ff; outline-offset:1px; }',
  '.sm-histsw:hover { color:var(--dsw-alias-label-primary, inherit); }',
  '@media (prefers-reduced-motion: reduce) { .sm-histsw__track, .sm-histsw__thumb { transition:none; } }',
  '@media (prefers-reduced-motion: reduce) { .sm-row__actions { transition:none; } }',
  // 自动归档配置行:数值输入内联呈现,窄面板可换行
  '.sm-cfg { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:10px;',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:var(--dsw-alias-label-caption, rgba(127,127,127,.9)); }',
  '.sm-cfg__field { display:inline-flex; align-items:center; gap:4px; }',
  '.sm-cfg__field input { width:56px; padding:2px 6px; border-radius:6px; color-scheme:light dark;',
  '  border:1px solid light-dark(rgba(15,17,21,.18), rgba(255,255,255,.22));',
  '  background:transparent; color:inherit; font:inherit; }',
  '.sm-cfg__field input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary, #1677ff); outline-offset:0; }',
  // 历史输入:零高度锚点容器 + 浮层(Alt+↑ 唤起);浮层与输入框同宽对齐,
  // 不透明实底 + 宿主同款卡片投影,与消息流明确区隔。
  // 色值取自宿主实测(白底卡片/墨色文字/蓝色强调):dsw alias 变量在宿主为空,不可依赖
  '.sm-hist { position:relative; height:0; }',
  '.sm-hist__pop { position:absolute; left:0; right:0; bottom:10px; z-index:50;',
  '  max-height:min(420px, 46vh); display:flex; flex-direction:column; overflow:hidden;',
  '  color-scheme:light dark; color:light-dark(#0f1115, #e8eaed);',
  '  background:light-dark(#fff, #1e1f22); border-radius:14px;',
  '  box-shadow:0 0 0 0.5px light-dark(rgba(15,17,21,.18), rgba(255,255,255,.14)), 0 4px 16px rgba(0,0,0,.08), 0 16px 48px rgba(0,0,0,.16); }',
  '.sm-hist__hint { display:flex; align-items:center; gap:10px; padding:9px 14px; flex:none;',
  '  border-bottom:1px solid light-dark(rgba(15,17,21,.08), rgba(255,255,255,.1));',
  '  font:var(--dsw-font-xxs-12, 12px/18px sans-serif); color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55)); }',
  '.sm-hist__scope { padding:2px 10px; border-radius:999px; flex:none;',
  '  background:#1677ff; color:#fff; font-weight:600; }',
  '.sm-hist__list { overflow-y:auto; padding:6px; }',
  '.sm-hist__row { position:relative; display:flex; align-items:center; gap:10px; width:100%; border:0;',
  '  background:transparent; cursor:pointer; text-align:left; padding:8px 12px 8px 14px;',
  '  border-radius:8px; min-width:0; }',
  '.sm-hist__row:hover { background:light-dark(rgba(15,17,21,.05), rgba(255,255,255,.07)); }',
  '.sm-hist__row--on, .sm-hist__row--on:hover { background:light-dark(rgba(22,119,255,.1), rgba(22,119,255,.22)); }',
  '.sm-hist__row--on::before { content:""; position:absolute; left:0; top:6px; bottom:6px; width:3px;',
  '  border-radius:2px; background:#1677ff; }',
  '.sm-hist__row--on .sm-hist__text { color:#1677ff; font-weight:600; }',
  '.sm-hist__row:focus-visible { outline:2px solid #1677ff; outline-offset:-2px; }',
  '.sm-hist__text { flex:1; min-width:0; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:inherit; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-hist__time { font:12px/18px var(--ds-font-family-code, monospace);',
  '  color:light-dark(rgba(15,17,21,.4), rgba(232,234,237,.4));',
  '  font-variant-numeric:tabular-nums; flex:none; }',
  '.sm-hist__star { border:0; background:transparent; cursor:pointer; flex:none;',
  '  font-size:15px; line-height:1; padding:2px 4px; border-radius:6px;',
  '  color:light-dark(rgba(15,17,21,.35), rgba(232,234,237,.35));',
  '  opacity:0; transition:opacity .12s; }',
  '.sm-hist__row:hover .sm-hist__star, .sm-hist__star:focus-visible { opacity:1; }',
  '.sm-hist__star--on { opacity:1; color:#f5a623; }',
  '.sm-hist__star:hover { color:#f5a623; }',
  '.sm-hist__editbtn { border:0; background:transparent; cursor:pointer; flex:none; padding:2px 8px;',
  '  border-radius:999px; font:12px/18px sans-serif; font-weight:600;',
  '  color:#1677ff; background:light-dark(rgba(22,119,255,.1), rgba(22,119,255,.22)); }',
  '.sm-hist__editbtn:hover { background:light-dark(rgba(22,119,255,.18), rgba(22,119,255,.3)); }',
  '.sm-hist__editwrap { display:flex; flex-direction:column; flex:1; min-height:0; }',
  '.sm-hist__editwrap .sm-hist__list { flex:1; min-height:0; }',
  '.sm-hist__editrow { display:flex; align-items:center; gap:6px; padding:4px 8px; }',
  '.sm-hist__editinput { flex:1; min-width:0; border:1px solid light-dark(rgba(15,17,21,.14), rgba(255,255,255,.18));',
  '  border-radius:8px; padding:6px 10px; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:inherit; background:transparent; }',
  '.sm-hist__editinput:focus { outline:2px solid #1677ff; outline-offset:-1px; }',
  '.sm-hist__del { border:0; background:transparent; cursor:pointer; flex:none;',
  '  font-size:16px; line-height:1; padding:2px 8px; border-radius:6px;',
  '  color:light-dark(rgba(15,17,21,.45), rgba(232,234,237,.45)); }',
  '.sm-hist__del:hover { color:#e5484d; }',
  '.sm-hist__addrow { display:flex; gap:6px; padding:8px; flex:none;',
  '  border-top:1px solid light-dark(rgba(15,17,21,.08), rgba(255,255,255,.1)); }',
  '.sm-hist__empty { padding:24px 14px; text-align:center; font:var(--dsw-font-s-14, 14px/22px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.5), rgba(232,234,237,.5)); }',
  '.sm-hist__banner { padding:7px 14px; flex:none; text-align:center; font:var(--dsw-font-xxs-12, 12px/18px sans-serif);',
  '  color:light-dark(rgba(15,17,21,.55), rgba(232,234,237,.55));',
  '  background:light-dark(rgba(15,17,21,.04), rgba(255,255,255,.06)); }',
].join('\n')

const UNARCHIVE_URL = '/api/session-manager/unarchive'
const DELETE_URL = '/api/session-manager/delete'
const INFO_URL = '/api/session-manager/info'
const DELETED_URL = '/api/session-manager/deleted'
const REMOUNT_URL = '/api/session-manager/remount'
const FORGET_URL = '/api/session-manager/forget'
const STATUS_URL = '/api/session-manager/status'
const INPUTS_URL = '/api/session-manager/inputs'

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
        h('button', { key: 'delete', className: 'sm-btn sm-btn--danger', disabled: busy, onClick: props.onDelete }, '删除'),
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
  // 归档库视图状态:recent 为时间倒序主列表(分页手动展开),library 为工作区分组
  // 浏览 + 标题搜索;分组默认收起,展开即见首页,组内沿用同一分页机制
  const [view, setView] = useState('recent')
  const [recentCount, setRecentCount] = useState(ARCHIVE_PAGE_SIZE)
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

  // 主列表(最近归档):默认首页,余量手动分页展开
  const recentPage = pageArchiveRows(rows, recentCount)
  const recentTray = h('div', { className: 'sm-tray' },
    rows.length === 0
      ? h('div', { className: 'sm-empty' },
          h('div', null, '还没有归档的会话'),
          h('div', { className: 'sm-empty__hint' }, '会话归档后集中显示在这里'))
      : [...recentPage.visible.map(renderArchiveRow),
        expandMore(recentPage.remaining, () => setRecentCount((count) => count + ARCHIVE_PAGE_SIZE))],
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
    h('div', { className: 'sm-head__hint' }, '恢复放回会话列表;删除移入系统回收站,可还原后重新挂载。'),
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
    h(HistorySwitchRow, null),
  )
}

// 历史浮层启停开关:低频功能,收在面板末行小尺寸呈现;
// 值存宿主 settings(与原生设置页同存储),切换经本插件路由中转
function HistorySwitchRow() {
  const [enabled, setEnabled] = useState(null)
  useEffect(() => {
    api(HISTORY_ENABLED_URL)
      .then((payload) => setEnabled(payload ? payload.enabled !== false : true))
      .catch(() => setEnabled(true))
  }, [])
  // 受控 checkbox:onChange 内同步落 state(异步确认会让 DOM 与渲染竞态,
  // 视觉慢一拍),服务端响应仅用于失败回滚
  const flip = (event) => {
    const next = event.target.checked
    setEnabled(next)
    api(HISTORY_ENABLED_URL, { method: 'POST', body: JSON.stringify({ enabled: next }) })
      .then((payload) => {
        toast('历史输入浮层已' + (payload && payload.enabled !== false ? '启用' : '停用') + ',刷新页面后生效')
      })
      .catch(() => {
        setEnabled(!next)
        toast('切换失败', { kind: 'error' })
      })
  }
  return h('label', { className: 'sm-histsw' },
    h('input', { type: 'checkbox', checked: enabled !== false, onChange: flip }),
    h('span', { className: 'sm-histsw__track' }, h('span', { className: 'sm-histsw__thumb' })),
    h('span', { className: 'sm-histsw__label', onClick: (event) => event.preventDefault() }, '历史输入浮层(Alt+↑)'),
  )
}

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
    h('span', null, '自动归档'),
    h('label', { className: 'sm-cfg__field' }, '阈值', numberInput('days'), '天未活跃(0 关闭)'),
    h('label', { className: 'sm-cfg__field' }, '检查周期', numberInput('intervalHours'), '小时(0 关闭)'),
  )
}

// 历史输入浮层:Alt+↑ 快捷键唤起,平时零占位;浮层内点选或键盘(↑/↓ 选择、
// ←/→ 切范围、Enter 填入、Esc 关闭)回填历史,填入走宿主公共契约
// inputActions.setDraft,不直改编辑器 DOM。数据由 host 工作区持久缓存
// (~/.dsh/historyPrompt)直接返回,后台对齐保持新鲜
// 历史输入范围:索引即 ←/→ 切换顺序(索引 0 为常用收藏,→ 向更大范围),
// 与 core.mjs HISTORY_SCOPES 同序同值;浮层默认落点为当前会话
const HISTORY_SCOPES = ['prompts', 'session', 'workspace', 'global']
const HISTORY_SCOPE_LABELS = ['常用', '当前会话', '本工作区', '全部工作区']
const HISTORY_SCOPE_DEFAULT = HISTORY_SCOPES.indexOf('session')
// 对齐未就绪时的静默重拉间隔与上限(对齐通常秒级完成,上限防死循环)
const HISTORY_REPULL_MS = 3 * 1000
const PROMPTS_TOGGLE_URL = '/api/session-manager/prompts/toggle'
const HISTORY_ENABLED_URL = '/api/session-manager/history-enabled'

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
  const rootRef = React.useRef(null)
  // 键盘层权威状态:监听器挂载一次(空依赖),读写全走 ref,规避 effect 重挂
  // 时序造成的闭包陈旧;state 仅驱动渲染,变更处双写
  const viewRef = React.useRef({ open: false, items: null, cursor: -1, scopeIndex: 0, aligning: false })
  const sessionRef = React.useRef(session)
  const inputActionsRef = React.useRef(inputActions)
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
  // items 深度不变的重复响应不重置光标(轮询期间保持用户选位)
  function applyResult(scopeIdx, result) {
    if (viewRef.current.scopeIndex !== scopeIdx) return
    const prev = viewRef.current.items
    if (prev !== null && JSON.stringify(prev) === JSON.stringify(result.inputs)) {
      syncView({ aligning: !result.aligned })
      setAligning(!result.aligned)
      return
    }
    syncView({ items: result.inputs, cursor: -1, aligning: !result.aligned })
    setItems(result.inputs)
    setCursor(-1)
    setAligning(!result.aligned)
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

  // 切换范围:→ 向大(工作区/全局),← 返回收藏;边界停住;缓存直接返回(毫秒级),后台保持对齐
  function switchScope(delta) {
    const next = viewRef.current.scopeIndex + delta
    if (next < 0 || next >= HISTORY_SCOPE_LABELS.length) return
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
        // 未选中条目时放行:用户可能只是在草稿里按 Enter 发消息,吞掉即是「假死锁定」
        if (!(view.items !== null && view.cursor >= 0 && view.cursor < view.items.length)) return
        event.preventDefault()
        event.stopPropagation()
        fill(view.items[view.cursor].text)
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

  // 选中行滚入可视区:键盘移动后高亮行保持在视野内
  useEffect(() => {
    if (!open || cursor < 0) return
    const row = rootRef.current && rootRef.current.querySelector('.sm-hist__row--on')
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
    className: 'sm-hist__star' + (collected.has(item.text) ? ' sm-hist__star--on' : ''),
    title: collected.has(item.text) ? '取消收藏' : '收藏',
    onClick: (event) => {
      event.stopPropagation()
      togglePrompt(item.text)
    },
  }, collected.has(item.text) ? '★' : '☆')
  const rowButton = (item, index) => h('button', {
    key: index + ':' + item.at,
    className: 'sm-hist__row' + (index === cursor ? ' sm-hist__row--on' : ''),
    onClick: () => fill(item.text),
  },
    h('span', { className: 'sm-hist__text', title: item.text }, item.text),
    h('span', { className: 'sm-hist__time' }, fmtTime(item.at)),
    !inPrompts ? starButton(item) : null,
  )
  // 编辑态行:文本可改(行内 input,回车/失焦保存)+ 删除
  const editRow = (item, index) => h('div', {
    key: index + ':' + item.at,
    className: 'sm-hist__editrow',
  },
    h('input', {
      className: 'sm-hist__editinput',
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
      className: 'sm-hist__del',
      title: '删除',
      onClick: () => togglePrompt(item.text),
    }, '×'),
  )
  return h('div', { className: 'sm-hist', ref: rootRef },
    open && h('div', { className: 'sm-hist__pop' },
      h('div', { className: 'sm-hist__hint' },
        h('span', { className: 'sm-hist__scope' }, HISTORY_SCOPE_LABELS[scopeIndex]),
        inPrompts
          ? h('button', {
              className: 'sm-hist__editbtn',
              onClick: () => setEditing(!editing),
            }, editing ? '完成' : '编辑')
          : null,
        h('span', null, '↑/↓ 选择 · ←/→ 切换范围 · Enter 填入 · Esc 关闭')),
      aligning && h('div', { className: 'sm-hist__banner' }, '首次对齐历史中,可能需要稍等'),
      items === null
        ? h('div', { className: 'sm-hist__empty' }, '正在读取历史输入…')
        : editing && inPrompts
          ? h('div', { className: 'sm-hist__editwrap' },
              items.length === 0
                ? h('div', { className: 'sm-hist__empty' }, '还没有常用提示词,可从历史行悬停收藏,或在下方添加')
                : h('div', { className: 'sm-hist__list' }, items.map(editRow)),
              h('div', { className: 'sm-hist__addrow' },
                h('input', {
                  className: 'sm-hist__editinput',
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
            ? h('div', { className: 'sm-hist__empty' }, loadError ? '历史输入加载失败,可关闭后重试' : (inPrompts ? '还没有常用提示词' : '该范围内还没有历史输入'))
            : h('div', { className: 'sm-hist__list' }, items.map(rowButton)),
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
            rows: projectRows(listState, (workspaceState && workspaceState.archivedSessionIds) || [], workspaceState),
            listState,
          })
        }
      },
    }
  },
})
