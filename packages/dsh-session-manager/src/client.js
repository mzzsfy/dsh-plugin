// dsh-session-manager Client 半区:settings.section 归档面板 + 归档/操作反馈通知。
// 归档快照来自官方 workspace.follow 客户端模型(ctx.get('workspaces')),会话行来自
// ctx.get('sessions');面板数据 = 会话行 ∩ 归档集合(纯投影),通知由 archived
// 增量帧的集合差分驱动,经公共依赖 @mzzsfy/dsh-common-tools 展示。
// 浏览器半区经 webServer 路由('/api/session-manager/*')访问 Host。打包为单文件自包含格式,无法跨文件
// require;与 src/core.mjs 镜像的纯函数(projectRows / archiveToastStep /
// archiveToastText / resolveArchivedIds / projectDeletedRows / pageArchiveRows /
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

    // 通知出口:公共依赖 @mzzsfy/dsh-common-tools(external require,装载行由本包
    // cordis.patch.yml 自带;每个消费插件各自携带装载行,本包只带自己那一行)
    const { show: toast } = require('@mzzsfy/dsh-common-tools/client').toast

// 视觉方案:L1 设置分区——全部语义色经包局部 token 引用宿主 alias(双主题自适应),
// 卡片分组、行 8px 内边距、控件 28-32px 高,窄栏设置页不铺满宽屏
const CSS = [
  '.sm-panel { --sm-accent:var(--dsw-alias-brand-primary); --sm-accent-deep:var(--dsw-alias-button-primary-hover); --sm-accent-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent); --sm-ok:var(--dsw-alias-state-success-primary); --sm-warn:var(--dsw-alias-state-warn-primary); --sm-danger:var(--dsw-alias-state-error-primary); --sm-danger-wash:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent); --sm-text:var(--dsw-alias-label-primary); --sm-text-sub:var(--dsw-alias-label-secondary); --sm-text-dim:var(--dsw-alias-label-tertiary); --sm-bg:var(--dsw-alias-bg-layer-1); --sm-bg-sub:var(--dsw-alias-bg-layer-2); --sm-bg-muted:var(--dsw-alias-bg-module-platform); --sm-card:var(--dsw-alias-bg-layer-1); --sm-card-border:var(--dsw-alias-border-l2); --sm-border:var(--dsw-alias-border-l2); --sm-border-strong:var(--dsw-alias-border-l3); --sm-hover:var(--dsw-alias-interactive-bg-hover); --sm-hover-danger:var(--dsw-alias-interactive-bg-hover-danger); --sm-skeleton:var(--dsw-alias-bg-skeleton); --sm-radius-sm:var(--dsw-radius-sm); --sm-radius-md:var(--dsw-radius-md); --sm-radius-lg:var(--dsw-radius-lg);',
  '  display:flex; flex-direction:column; gap:16px; min-width:0; max-width:560px; color:var(--sm-text); font-size:14px; line-height:22px; }',
  '.sm-toolbar { display:flex; flex-direction:column; gap:8px; min-width:0; }',
  '.sm-heading { display:flex; flex-direction:column; gap:4px; min-width:0; }',
  '.sm-title { font-size:18px; line-height:26px; font-weight:600; }',
  '.sm-desc { font-size:13px; line-height:20px; color:var(--sm-text-sub); }',
  '.sm-meta { display:flex; align-items:center; gap:12px; min-width:0; }',
  '.sm-spacer { flex:1; }',
  '.sm-meta__count { font-family:var(--ds-font-family-code); font-size:12px; line-height:18px; color:var(--sm-text-dim); font-variant-numeric:tabular-nums; }',
  '.sm-meta__missing { color:var(--sm-danger); }',
  '.sm-card { display:flex; flex-direction:column; gap:10px; min-width:0; }',
  '.sm-card__head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }',
  '.sm-card__title { font-size:14px; line-height:22px; font-weight:600; }',
  '.sm-card__meta { font-size:13px; line-height:20px; color:var(--sm-text-sub); }',
  '.sm-tray { display:flex; flex-direction:column; min-width:0; background:var(--sm-bg-muted); border-radius:var(--sm-radius-md); padding:4px 0; }',
  '.sm-row { display:grid; grid-template-columns:88px minmax(0,1fr) auto; justify-content:start; align-items:center; gap:8px;',
  '  padding:8px 10px; border-radius:var(--sm-radius-sm); }',
  // 归档行:标题与元信息单列纵向排布,操作列贴右;紧凑 padding 换取信息密度,
  // 已删除行继续使用上面的 grid 结构(原位置路径需要跨列)
  '.sm-row--archive { display:flex; align-items:center; gap:8px; padding:4px 10px; }',
  '.sm-row__main { flex:1; min-width:0; display:flex; flex-direction:column; }',
  '.sm-row__meta { display:flex; align-items:center; gap:4px; font-family:var(--ds-font-family-code); font-size:11px; line-height:16px;',
  '  color:var(--sm-text-dim); font-variant-numeric:tabular-nums; }',
  '.sm-row--archive .sm-row__title { font-size:14px; line-height:20px; }',
  '.sm-row--archive .sm-row__time, .sm-row--archive .sm-row__size { font-size:11px; line-height:16px; }',
  '.sm-row:first-child { border-top:0; }',
  '.sm-row:hover, .sm-row:focus-within { background:var(--sm-hover); }',
  '.sm-row--armed { background:var(--sm-danger-wash); }',
  '.sm-row--busy { opacity:.5; pointer-events:none; }',
  '.sm-row__time, .sm-row__size { font-family:var(--ds-font-family-code); font-size:12px; line-height:18px; color:var(--sm-text-dim); font-variant-numeric:tabular-nums; }',
  '.sm-row__size { color:var(--sm-text-dim); }',
  '.sm-row--armed .sm-row__size { color:var(--sm-danger); }',
  '.sm-row__ws { flex:none; max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;',
  '  padding:0 6px; border-radius:999px; font-family:var(--ds-font-family-code); font-size:11px; line-height:16px;',
  '  color:var(--sm-text-dim); background:var(--sm-bg-muted); }',
  '.sm-row__ws--none { background:transparent; box-shadow:inset 0 0 0 1px var(--sm-border-strong); }',
  '.sm-row__title { font-size:14px; line-height:22px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-row__error { font-size:12px; line-height:18px; color:var(--sm-danger); }',
  '.sm-row__path { grid-column:2 / -1; font-family:var(--ds-font-family-code); font-size:12px; line-height:18px; color:var(--sm-text-dim);',
  '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
  '.sm-deleted { display:flex; flex-direction:column; gap:12px; min-width:0; }',
  // 归档行:恢复常显;已删除区保持整组操作悬停显现(删除按钮显隐规则在 .sm-btn 块后)
  '.sm-row__actions { display:flex; gap:2px; justify-content:flex-end; }',
  '.sm-deleted .sm-row__actions { opacity:0; transition:opacity 0.12s ease; }',
  '.sm-deleted .sm-row:hover .sm-row__actions, .sm-deleted .sm-row:focus-within .sm-row__actions { opacity:1; }',
  '.sm-btn { border:1px solid transparent; background:transparent; cursor:pointer; min-height:28px; padding:0 8px;',
  '  border-radius:var(--sm-radius-sm); font-size:13px; line-height:20px; color:var(--sm-text-sub); }',
  '.sm-btn:hover { background:var(--sm-hover); color:var(--sm-text); }',
  '.sm-btn--restore { color:var(--sm-accent); }',
  '.sm-btn--restore:hover { background:var(--sm-accent-wash); color:var(--sm-accent); }',
  '.sm-btn--danger:hover { color:var(--sm-danger); background:var(--sm-hover-danger); }',
  '.sm-btn--confirm { color:var(--sm-danger); border-color:var(--sm-danger); }',
  '.sm-btn--confirm:hover { background:var(--sm-hover-danger); }',
  '.sm-btn:disabled { opacity:.5; cursor:not-allowed; background:transparent; color:var(--sm-text-dim); }',
  '.sm-btn--confirm:disabled { color:var(--sm-danger); }',
  '.sm-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  // 删除按钮显隐:隐藏规则必须位于 .sm-btn:disabled 之后——同特异度后出者胜,
  // 否则 busy 禁用态被禁用半透明规则压过而幽灵显形;显现规则特异度更高,不受顺序约束
  '.sm-btn--danger, .sm-btn--danger:disabled { opacity:0; transition:opacity 0.12s ease; }',
  '.sm-row:hover .sm-btn--danger, .sm-row:focus-within .sm-btn--danger { opacity:1; }',
  // 删除确认弹窗:遮罩 + 居中卡片;高 z-index 压过设置面板层,点击遮罩不关闭(强制显式选择)
  '.sm-dialog { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; padding:24px;',
  '  background:color-mix(in srgb, var(--sm-text) 45%, transparent); }',
  '.sm-dialog__card { width:min(420px, calc(100vw - 48px)); border:.5px solid var(--sm-card-border); border-radius:var(--sm-radius-lg); padding:20px;',
  '  background:var(--sm-card); color:var(--sm-text); box-shadow:var(--dsw-shadow-lv3);',
  '  display:flex; flex-direction:column; gap:12px; }',
  '.sm-dialog__title { font-size:16px; line-height:24px; font-weight:600;',
  '  color:var(--sm-danger); margin:0; }',
  '.sm-dialog__body { font-size:14px; line-height:22px; color:var(--sm-text-sub); margin:0; }',
  '.sm-dialog__warn { font-size:13px; line-height:20px; color:var(--sm-text-sub); margin:0; }',
  '.sm-dialog__actions { display:flex; justify-content:flex-end; gap:8px; }',
  '.sm-dialog__btn { border:1px solid var(--sm-border-strong); background:transparent; cursor:pointer;',
  '  min-height:36px; padding:0 14px; border-radius:var(--sm-radius-sm); font-size:14px; line-height:22px; color:var(--sm-text-sub); }',
  '.sm-dialog__btn:hover { background:var(--sm-hover); color:var(--sm-text); }',
  '.sm-dialog__btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  '.sm-dialog__btn--confirm { border-color:var(--sm-danger); color:var(--sm-danger); }',
  '.sm-dialog__btn--confirm:hover { background:var(--sm-hover-danger); color:var(--sm-danger); }',
  '.sm-empty { display:flex; flex-direction:column; align-items:center; gap:4px; padding:24px 12px; text-align:center;',
  '  color:var(--sm-text-dim); font-size:13px; line-height:20px; }',
  '.sm-empty__hint { font-size:12px; line-height:18px; color:var(--sm-text-dim); }',
  // 搜索框:独立一行占满面板宽度(宿主设置页搜索同构),放大镜按钮内嵌在输入框右侧;
  // 输入与按钮共用外框,焦点环落在整框上;空归档时不渲染
  '.sm-search { display:flex; align-items:center; gap:2px; height:36px; padding:0 4px 0 0; border-radius:var(--sm-radius-sm);',
  '  border:1px solid var(--sm-border-strong); background:var(--sm-bg); }',
  '.sm-search:focus-within { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  '.sm-search__input { flex:1; min-width:0; height:100%; padding:0 10px; border:0; background:transparent; color:var(--sm-text);',
  '  font:inherit; font-size:13px; line-height:20px; outline:none; }',
  '.sm-search__input::placeholder { color:var(--sm-text-dim); }',
  // 内嵌按钮占住输入框右侧,原生清除叉与之重叠故隐藏
  '.sm-search__input::-webkit-search-cancel-button { -webkit-appearance:none; display:none; }',
  '.sm-search__go, .sm-search__clear { flex:none; display:flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0;',
  '  border-radius:var(--sm-radius-sm); background:transparent; color:var(--sm-text-dim); cursor:pointer; }',
  '.sm-search__go:hover, .sm-search__clear:hover { color:var(--sm-text); background:var(--sm-hover); }',
  '.sm-search__go:focus-visible, .sm-search__clear:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }',
  '.sm-search__icon { display:block; width:14px; height:14px; }',
  '.sm-search__icon--close { width:12px; height:12px; }',
  '.sm-group { display:flex; flex-direction:column; }',
  '.sm-group__head { display:flex; align-items:center; gap:8px; width:100%; border:0; background:transparent; cursor:pointer;',
  '  min-height:40px; padding:0 12px; border-radius:var(--sm-radius-sm); text-align:left; color:inherit; font-size:14px; line-height:22px; font-weight:500; }',
  '.sm-group__head:hover { background:var(--sm-hover); }',
  '.sm-group__head:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  '.sm-group__chev { flex:none; font-size:14px; color:var(--sm-text-dim); transition:transform .15s ease; }',
  '.sm-group__head--on .sm-group__chev { transform:rotate(90deg); }',
  '.sm-group__name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
  '.sm-group__count { margin-left:auto; flex:none; font-family:var(--ds-font-family-code); font-size:12px; line-height:18px; color:var(--sm-text-dim); font-variant-numeric:tabular-nums; }',
  '.sm-group__body { padding-bottom:4px; }',
  '.sm-more { display:block; width:100%; border:0; background:transparent; cursor:pointer; min-height:28px; padding:0 8px;',
  '  text-align:center; border-radius:var(--sm-radius-sm); font-size:13px; line-height:20px; color:var(--sm-text-sub); }',
  '.sm-more:hover { background:var(--sm-hover); color:var(--sm-text); }',
  '.sm-more:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
  '@media (prefers-reduced-motion: reduce) { .sm-group__chev { transition:none; } }',
  '@media (prefers-reduced-motion: reduce) { .sm-btn--danger, .sm-deleted .sm-row__actions { transition:none; } }',
  // 自动归档配置:卡片内数值字段行,窄面板可换行
  '.sm-cfg { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:10px;',
  '  font-size:12px; line-height:18px; color:var(--sm-text-dim); }',
  '.sm-cfg__row { display:flex; align-items:center; gap:16px; flex-wrap:wrap; font-size:12px; line-height:18px; color:var(--sm-text-dim); }',
  '.sm-cfg__field { display:inline-flex; align-items:center; gap:4px; }',
  '.sm-cfg__field input { width:56px; height:28px; padding:0 6px; border-radius:var(--sm-radius-sm); color-scheme:light dark;',
  '  border:1px solid var(--sm-border-strong);',
  '  background:var(--sm-bg); color:var(--sm-text); font-size:13px; line-height:20px; }',
  '.sm-cfg__field input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
].join('\n')

const UNARCHIVE_URL = '/api/session-manager/unarchive'
const DELETE_URL = '/api/session-manager/delete'
const INFO_URL = '/api/session-manager/info'
const DELETED_URL = '/api/session-manager/deleted'
const REMOUNT_URL = '/api/session-manager/remount'
const FORGET_URL = '/api/session-manager/forget'
const STATUS_URL = '/api/session-manager/status'
const SIZES_URL = '/api/session-manager/sizes'

// 批量大小查询单批上限:与 host SIZES_MAX_IDS 同值,由 client-size 契约测试锁定。
// 归档集合可达数百条,按批发送避免单请求体超过 host 读取上限。
const SIZES_BATCH_SIZE = 500

// 删除确认链文案:两击行内确认后弹窗强提示,弹窗内确认才发请求。
// 删除产物不可再生,其他插件(用量统计等)依赖会话产物,删后其会话级数据一并消失
const DELETE_BUTTON_TITLE = '删除会话产物会影响其他插件的工作(用量统计等依赖会话产物);若无特殊需求,请不要删除。删除需再次行内确认与弹窗确认。'
// 行操作按钮悬停说明:文案与行为同源维护,由源码契约测试锁定
const RESTORE_BUTTON_TITLE = '把该会话从归档移回会话列表;恢复后 10 分钟内暂停自动归档,保护「恢复 → 首条消息」窗口,期间发言即恢复正常活跃计时。'
const REMOUNT_BUTTON_TITLE = '把这条已删除记录对应的会话重新挂回列表:产物仍在原位置时直接挂载,产物已进系统回收站时先还原再挂载。'
const FORGET_BUTTON_TITLE = '只移除这条已删除记录,不动磁盘上的会话产物;用于产物已手动找回、或不再需要追踪的情况。'
const MORE_BUTTON_TITLE = '展开该工作区剩余的归档会话;只改变面板显示条数,不改变任何会话的归档状态。'
const SEARCH_MORE_BUTTON_TITLE = '展开剩余命中;只改变面板显示条数,不改变任何会话的归档状态。'
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
// 长事务超时:删除与重挂载在服务端要搬整份会话产物(回收站命令自带 60s 超时,
// 级联逐子会话各走一次),远超普通请求。共用 8s 会让前端先放弃而服务端继续执行,
// 面板弹「响应超时」谎报失败并诱发重复点击,故单列更长超时并在文案里说明仍在执行
const LONG_ACTION_TIMEOUT_MS = 3 * 60 * 1000
const LONG_ACTION_TIMEOUT_HINT = '服务端可能仍在执行,请稍后刷新面板确认结果'

async function api(url, options) {
  const { timeoutMs = API_TIMEOUT_MS, ...init } = options || {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      ...init,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
    return payload
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const hint = timeoutMs > API_TIMEOUT_MS ? LONG_ACTION_TIMEOUT_HINT : '宿主繁忙中'
      throw new Error('响应超时(' + Math.round(timeoutMs / 1000) + 's),' + hint)
    }
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

// 行内大小文案:未加载显示占位,后端不支持显示破折,产物缺失明确标注
function sizeLabelOf(size) {
  if (!size) return '…'
  if (size.supported === false) return '—'
  if (size.missing) return '产物已丢失'
  return fmtSize(size.sizeBytes)
}

// 归档大小汇总:仅统计可读大小;缺失、不可得与未加载分桶,供面板头展示
function sizeSummaryOf(rows, sizes) {
  const list = Array.isArray(rows) ? rows : []
  const byId = sizes || {}
  let totalBytes = 0
  let known = 0
  let missing = 0
  let unsupported = 0
  let pending = 0
  for (const row of list) {
    const size = byId[row.id]
    if (!size) {
      pending += 1
      continue
    }
    if (size.supported === false || !Number.isFinite(size.sizeBytes)) {
      unsupported += 1
      continue
    }
    if (size.missing) {
      missing += 1
      continue
    }
    totalBytes += size.sizeBytes
    known += 1
  }
  return { totalBytes, known, missing, unsupported, pending }
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
// 工作区标题或 null(生产实现;core.mjs projectArchiveRows 是它的 parity 镜像,
// 仅供测试比对,host 不做面板投影)
function projectRows(listState, archivedIds, workspaceState) {
  const archived = new Set(archivedIds)
  const byId = (listState && listState.byId) || {}
  const workspaces = (workspaceState && workspaceState.items) || []
  return Object.keys(byId)
    // client 行只有 origin,没有 delegationDepth:旧格式派生子会话在此不可判。
    // 该判定由 core 镜像覆盖;生产面靠启动自愈把派生 id 从归档集合清掉
    .filter((id) => archived.has(id) && byId[id].origin !== 'subagent')
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

// 归档集合权威解箱:只有快照 phase==='ready' 时 archivedSessionIds 才权威。
// 未就绪(挂载/重连 pending 帧)按「未知」处理:有上一次权威集合时沿用(stale),
// 从未就绪则 phase='unknown';禁止把未知当空集,否则面板把「还不知道」渲染成
// 「没有归档会话」(镜像 core.mjs resolveArchivedIds,修改需两处同步)
function resolveArchivedIds(previousIds, snapshot) {
  const ids = snapshot ? snapshot.archivedSessionIds : undefined
  if (snapshot && snapshot.phase === 'ready' && Array.isArray(ids)) {
    return { phase: 'ready', ids: ids.map(String) }
  }
  if (Array.isArray(previousIds)) return { phase: 'stale', ids: previousIds }
  return { phase: 'unknown', ids: [] }
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
        h('button', { key: 'delete', className: 'sm-btn sm-btn--danger', disabled: busy, title: DELETE_BUTTON_TITLE, onClick: props.onDelete }, '删除'),
        h('button', { key: 'restore', className: 'sm-btn sm-btn--restore', disabled: busy, title: RESTORE_BUTTON_TITLE, onClick: props.onUnarchive }, '恢复'),
      ]
  return h('div', {
    className: 'sm-row sm-row--archive' + (armed ? ' sm-row--armed' : '') + (busy ? ' sm-row--busy' : ''),
  },
    h('div', { className: 'sm-row__main' },
      h('span', { className: 'sm-row__title', title: row.title }, row.title),
      h('span', { className: 'sm-row__meta' },
        row.workspace
          ? h('span', { className: 'sm-row__ws', title: row.workspace }, row.workspace)
          : h('span', { className: 'sm-row__ws sm-row__ws--none', title: '该会话不属于任何已登记工作区' }, '未分组'),
        h('span', { key: 'time', className: 'sm-row__time', title: new Date(row.updatedAt).toLocaleString() }, ' · ' + fmtTime(row.updatedAt) + ' · '),
        armed && confirm && !confirm.error
          ? h('span', { key: 'size', className: 'sm-row__size' }, confirm.missing ? '产物已丢失' : fmtSize(confirm.sizeBytes))
          : h('span', { key: 'size', className: 'sm-row__size', title: '会话日志文件大小' }, sizeLabelOf(props.size)),
      ),
      confirm && confirm.error ? h('span', { className: 'sm-row__error' }, confirm.error) : null,
    ),
    h('div', { className: 'sm-row__actions' }, actions),
  )
}

// 搜索框内嵌图标:放大镜与清除叉均为纯装饰图形,可访问名由按钮承担
function SearchIcon() {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }
  return h('svg', { className: 'sm-search__icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    h('circle', { cx: 7, cy: 7, r: 4.4, ...stroke }),
    h('line', { x1: 10.4, y1: 10.4, x2: 14, y2: 14, ...stroke }),
  )
}

function ClearIcon() {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }
  return h('svg', { className: 'sm-search__icon sm-search__icon--close', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    h('line', { x1: 4, y1: 4, x2: 12, y2: 12, ...stroke }),
    h('line', { x1: 12, y1: 4, x2: 4, y2: 12, ...stroke }),
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
      h('button', { key: 'remount', className: 'sm-btn sm-btn--restore', disabled: busy, title: REMOUNT_BUTTON_TITLE, onClick: props.onRemount }, '重新挂载'),
      h('button', { key: 'forget', className: 'sm-btn', disabled: busy, title: FORGET_BUTTON_TITLE, onClick: props.onForget }, '移除记录'),
    ),
    h('span', { className: 'sm-row__path', title: row.path }, '原位置 ' + row.path),
  )
}

// 已删除分区:仅非空渲染;还原指引在分区头部,行内提供重挂载与移除记录
function DeletedSection(props) {
  const rows = props.rows
  if (rows.length === 0) return null
  return h('div', { className: 'sm-card sm-deleted' },
    h('div', { className: 'sm-card__head' },
      h('span', { className: 'sm-card__title' }, '已删除'),
      h('span', { className: 'sm-card__meta' }, rows.length + ' 条'),
    ),
    h('div', { className: 'sm-desc' },
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
  // 归档快照未就绪:空列表是「未知」而非法据,空态文案必须区分,不许渲染成「没有归档」
  const archiveKnown = props.archiveKnown !== false
  const [busyId, setBusyId] = useState(null)
  const [armedId, setArmedId] = useState(null)
  const [confirms, setConfirms] = useState({})
  // 删除弹窗受控状态:非 null 即弹窗展示中,确认后才真正发删除请求
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleted, setDeleted] = useState([])
  const [periodic, setPeriodic] = useState(null)
  // 归档库视图状态:recent 为主列表固定首页,library 为按工作区分组浏览;
  // 搜索是面板级能力(两种视图常显),命中集恒为全部归档会话
  const [view, setView] = useState('recent')
  const [query, setQuery] = useState('')
  const [searchCount, setSearchCount] = useState(ARCHIVE_PAGE_SIZE)
  const [openGroups, setOpenGroups] = useState(() => new Set())
  const [groupCounts, setGroupCounts] = useState({})
  // 归档行文件大小:按会话 id 缓存,请求过的 id 不重复发
  const [sizes, setSizes] = useState({})
  const requestedSizesRef = useRef(new Set())
  const searchInputRef = useRef(null)
  // 行 id 序列作为 effect 依赖:行内容更新但 id 集合不变时不重跑,避免取消在途请求
  const rowIdsKey = rows.map((row) => row.id).join('\u0000')
  const sizeSummary = sizeSummaryOf(rows, sizes)
  const sizeSummaryTitle = sizeSummary.pending === 0 && sizeSummary.known > 0
    ? '按可读取大小的 ' + sizeSummary.known + ' 条统计'
      + (sizeSummary.missing > 0 ? ';产物缺失 ' + sizeSummary.missing + ' 条' : '')
      + (sizeSummary.unsupported > 0 ? ';大小不可得 ' + sizeSummary.unsupported + ' 条' : '')
    : undefined

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

  // 归档行文件大小:按行 id 序列分批请求,失败批次清除标记供下次渲染重试;
  // 卸载或行集合变化时只释放未完成批次,已取到的 id 不重复请求
  useEffect(() => {
    const ids = rowIdsKey === '' ? [] : rowIdsKey.split('\u0000')
    const pending = ids.filter((id) => !requestedSizesRef.current.has(id))
    if (pending.length === 0) return
    for (const id of pending) requestedSizesRef.current.add(id)
    const settled = new Set()
    let cancelled = false
    void (async () => {
      for (let at = 0; at < pending.length; at += SIZES_BATCH_SIZE) {
        const batch = pending.slice(at, at + SIZES_BATCH_SIZE)
        try {
          const payload = await api(SIZES_URL, { method: 'POST', body: JSON.stringify({ sessionIds: batch }) })
          if (cancelled) return
          for (const id of batch) settled.add(id)
          setSizes((prev) => ({ ...prev, ...(payload && payload.sizes) }))
        } catch (error) {
          if (cancelled) return
          // 失败批次按不可得落态,避免占位符永久停留;清除请求标记供行集合变化时重试
          for (const id of batch) requestedSizesRef.current.delete(id)
          setSizes((prev) => ({ ...prev, ...Object.fromEntries(batch.map((id) => [id, { supported: false }])) }))
          console.warn('[session-manager] 会话大小加载失败', error)
        }
      }
    })()
    return () => {
      cancelled = true
      for (const id of pending) {
        if (!settled.has(id)) requestedSizesRef.current.delete(id)
      }
    }
  }, [rowIdsKey])

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
      const body = await api(DELETE_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.id }), timeoutMs: LONG_ACTION_TIMEOUT_MS })
      if (body && body.ok && !body.message) {
        return { ...body, message: body.mode === 'quarantine' ? DELETE_TOAST_QUARANTINE : DELETE_TOAST_OS }
      }
      return body
    }, DELETE_TOAST_OS).then(refreshDeleted)
    setPendingDelete(null)
  }

  function onRemount(row) {
    void run(row.sessionId, () => api(REMOUNT_URL, { method: 'POST', body: JSON.stringify({ sessionId: row.sessionId }), timeoutMs: LONG_ACTION_TIMEOUT_MS }),
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
    size: sizes[row.id],
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

  // 归档空态:快照未就绪时说明「读取中」,不把未知折成空集结论
  const archiveEmptyState = (hint) => h('div', { className: 'sm-empty' },
    h('div', null, archiveKnown ? '还没有归档的会话' : '归档状态读取中…'),
    hint === undefined
      ? null
      : h('div', { className: 'sm-empty__hint' }, archiveKnown ? hint : '等待宿主归档快照就绪'))

  // 分页展开按钮:无余量不渲染(React 忽略 null 子节点);key 恒定,
  // 免得数组子节点内无 key 元素随页扩位触发不必要的卸载重挂
  const expandMore = (remaining, onMore) => remaining <= 0
    ? null
    : h('button', { key: 'more', className: 'sm-more', title: MORE_BUTTON_TITLE, onClick: onMore }, '展开更多(剩 ' + remaining + ' 条)')

  // 搜索框:标题/说明之下的搜索行独立常显,两种视图共用;命中集取全部归档会话而非
  // 当前视图可见行,否则主列表首页 100 条之外的会话永远搜不到
  const searching = query.trim() !== ''
  const matchedRows = searching ? filterArchiveRows(rows, query) : []
  const searchPage = pageArchiveRows(matchedRows, searchCount)
  const searchField = rows.length === 0
    ? null
    : h('div', { className: 'sm-search' },
        h('input', {
          ref: searchInputRef,
          className: 'sm-search__input',
          type: 'search',
          placeholder: '搜索会话标题',
          'aria-label': '搜索会话标题',
          value: query,
          // 搜索词变化即重置命中分页:命中集变小后旧可见数无意义
          onChange: (event) => { setQuery(event.target.value); setSearchCount(ARCHIVE_PAGE_SIZE) },
        }),
        // 清除按钮仅在有搜索词时出现(原生清除叉被内嵌按钮占位)
        searching
          ? h('button', {
              className: 'sm-search__clear',
              type: 'button',
              'aria-label': '清除搜索',
              title: '清除搜索',
              onClick: () => {
                setQuery('')
                setSearchCount(ARCHIVE_PAGE_SIZE)
                if (searchInputRef.current) searchInputRef.current.focus()
              },
            }, h(ClearIcon, null))
          : null,
        h('button', {
          className: 'sm-search__go',
          type: 'button',
          'aria-label': '聚焦搜索框',
          title: '聚焦搜索框',
          onClick: () => { if (searchInputRef.current) searchInputRef.current.focus() },
        }, h(SearchIcon, null)),
      )

  // 面板结构按 L1 设置分区骨架:18px 分区标题 + 13px 说明 → 搜索行 → 计数行 → 列表
  const headCount = rows.length === 0
    ? null
    : searching
      ? h('span', { className: 'sm-meta__count' }, matchedRows.length + ' 条匹配')
      : h('span', { className: 'sm-meta__count', title: sizeSummaryTitle },
          '共 ' + rows.length + ' 条',
          sizeSummary.pending === 0 && sizeSummary.known > 0 ? ' · ' + fmtSize(sizeSummary.totalBytes) : null,
          sizeSummary.pending === 0 && sizeSummary.missing > 0
            ? h('span', { key: 'missing', className: 'sm-meta__missing' }, ' · 缺失 ' + sizeSummary.missing + ' 条')
            : null,
          sizeSummary.pending === 0 && sizeSummary.unsupported > 0
            ? h('span', { key: 'unsupported' }, ' · ' + sizeSummary.unsupported + ' 条不可得')
            : null)

  // 主列表(最近归档):固定首页不翻页,尾部「按工作区浏览」入口跳转二级视图看全部。
  // 按需构建:最近视图不做分组投影,防大集合在每次状态更新时重渲染放大
  const recentTray = () => {
    const page = pageArchiveRows(rows, ARCHIVE_PAGE_SIZE)
    return h('div', { className: 'sm-tray' },
      [...page.visible.map(renderArchiveRow),
        page.remaining > 0
          ? h('button', { key: 'more', className: 'sm-more', onClick: () => setView('library') }, '按工作区浏览')
          : null],
    )
  }

  // 工作区分组浏览:分组默认收起,展开即见组内首页,组内沿用同一分页机制
  const groupTray = () => h('div', { className: 'sm-tray' },
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

  // 搜索命中:平铺 + 分页,与浏览视图无关;展开文案不走工作区语义
  const searchTray = matchedRows.length === 0
    ? h('div', { className: 'sm-empty' }, '没有匹配的归档会话')
    : h('div', { className: 'sm-tray' },
        [...searchPage.visible.map(renderArchiveRow),
          searchPage.remaining > 0
            ? h('button', {
                key: 'more',
                className: 'sm-more',
                title: SEARCH_MORE_BUTTON_TITLE,
                onClick: () => setSearchCount((count) => count + ARCHIVE_PAGE_SIZE),
              }, '展开更多(剩 ' + searchPage.remaining + ' 条)')
            : null])

  // 归档区域分派:空归档 / 搜索命中 / 工作区分组 / 主列表首页
  const archiveRegion = h('div', { className: 'sm-card' },
    rows.length === 0
      ? h('div', { className: 'sm-tray' }, archiveEmptyState(view === 'recent' ? '会话归档后集中显示在这里' : undefined))
      : searching
        ? searchTray
        : view === 'recent' ? recentTray() : groupTray())

  // 次级信息行:左侧计数,右侧视图切换(进入分组 / 取消分组),同一位置互为反操作
  const viewToggle = rows.length === 0 || searching
    ? null
    : view === 'recent'
      ? h('button', { className: 'sm-btn', key: 'to-library', onClick: () => setView('library') }, '按工作区浏览 ›')
      : h('button', { className: 'sm-btn', key: 'to-recent', onClick: () => setView('recent') }, '取消按工作区')
  const metaRow = rows.length === 0
    ? null
    : h('div', { className: 'sm-meta' }, headCount, h('span', { className: 'sm-spacer' }), viewToggle)

  return h('div', { className: 'sm-panel' },
    h('div', { className: 'sm-toolbar' },
      h('div', { className: 'sm-heading' },
        h('div', { className: 'sm-title' }, '会话归档'),
        h('div', { className: 'sm-desc' }, '恢复放回会话列表;删除移入系统回收站(无回收站环境移入插件回收区),可经「已删除」区找回。'),
      ),
      searchField,
      metaRow,
      periodic && periodic.running === false
        ? h('div', { className: 'sm-desc' },
            '周期评估未运行(' + (periodic.reason || '宿主定时服务不可用') + ');自动归档仍在新会话创建与启动时生效。')
        : null,
    ),
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
const ARCHIVE_OVERVIEW_TITLE = '超过阈值天数未活跃的会话自动移入归档;触发时机为新会话创建、插件启动与周期检查;归档会话在本面板管理,可恢复或删除;恢复后 10 分钟内暂停自动归档,期间发言即恢复正常活跃计时。'
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

// 面板状态:数值项取字符串供受控输入
const configStateOf = (archive) => ({
  days: String(archive.days),
  intervalHours: String(archive.intervalHours),
})

function AutoArchiveConfig() {
  const [state, setState] = useState(null)
  // 已提交值快照:非法输入与保存失败的回滚基准,与编辑中的显示值分离
  const committedRef = React.useRef(null)
  useEffect(() => {
    void refresh()
  }, [])
  function refresh() {
    return api(AUTO_ARCHIVE_URL)
      .then((archive) => {
        if (!archive) return
        const next = configStateOf(archive)
        committedRef.current = next
        setState(next)
      })
      .catch((error) => { console.warn('[session-manager] 面板配置回读失败', error) })
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
            const rows = Object.keys(byId)
              .filter((id) => byId[id].origin !== 'subagent')
              .map((id) => ({ id, title: byId[id].displayTitle }))
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
          // 归档集合按 phase 门取权威值:未就绪帧不让面板按「空集」渲染(沿用上次权威集合)
          const lastReadyIdsRef = React.useRef(undefined)
          const archived = resolveArchivedIds(lastReadyIdsRef.current, workspaceState)
          if (archived.phase === 'ready') lastReadyIdsRef.current = archived.ids
          return React.createElement(SessionManagerApp, {
            rows: projectRows(listState, archived.ids, workspaceState),
            listState,
            archiveKnown: archived.phase !== 'unknown',
          })
        }
      },
    }
  },
})
