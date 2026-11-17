(() => {
// 设置页「穿透隧道」分区: 已开放列表 + 本机端口发现 + 创建/编辑弹窗。
// 无构建: createElement + 一次性样式注入; IIFE 书挡, 顶层零词法声明。

/* LOGIC-BEGIN */
const API_PREFIX = '/api/tunnel'
const SECTION_ID = 'tunnel'
const SECTION_LABEL = '穿透隧道'
const SECTION_ORDER = 47
const COPY_FLASH_MS = 1200
const MENU_GAP = 6
const MENU_MARGIN = 8
const REQUEST_TIMEOUT_MS = 15 * 1000
const PROBE_DEBOUNCE_MS = 350
const PORT_MIN = 1
const PORT_MAX = 65535
const PORT_LIMIT = 8
const PATH_PREFIX = '/p/'
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAME_HAS_LETTER_RE = /[a-z]/
const ENTRY_PATH = 'path'
const ENTRY_SUBDOMAIN = 'subdomain'
const ENTRY_LABELS = { path: '路径', subdomain: '子域名' }
const EMPTY_ROW = { name: '', targetPort: '', entry: ENTRY_PATH }
const LOCAL_HOST_RE = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])$/i
const LOOPBACK_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i

function accessUrlOf(row, location) {
  if (row.entry !== ENTRY_SUBDOMAIN) return location.origin + PATH_PREFIX + row.name + '/'
  const port = location.port === '' ? '' : ':' + location.port
  const base = LOCAL_HOST_RE.test(location.hostname) ? 'localhost' : location.hostname
  return location.protocol + '//' + row.name + '.' + base + port + '/'
}

function accessLocalOnly(row, location) {
  return row.entry === ENTRY_SUBDOMAIN && LOCAL_HOST_RE.test(location.hostname)
}

function entryLabelOf(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  const at = host.indexOf('.')
  return at === -1 ? '' : host.slice(0, at)
}

function isEntryLabelConflict(name, hostname) {
  const label = entryLabelOf(hostname)
  return label !== '' && name === label
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOST_RE.test(String(hostname ?? ''))
}

// 本机访问优先子域名(应用零改造); 远程 IP 只能路径入口; 真域名优先子域名。
function defaultEntryFor(location) {
  const hostname = String(location?.hostname ?? '')
  if (isLoopbackHost(hostname)) return ENTRY_SUBDOMAIN
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) return ENTRY_PATH
  return ENTRY_SUBDOMAIN
}

function entryHintOf(entry, location) {
  const hostname = String(location?.hostname ?? '')
  if (entry === ENTRY_SUBDOMAIN) {
    return isLoopbackHost(hostname)
      ? '仅本机可访问; 目标应用无需改 base, 手机/其他设备请改用路径入口'
      : '需 *.域名 泛解析; 目标应用按根路径运行, 无需改 base'
  }
  return isLoopbackHost(hostname)
    ? '同源 /p/<名>/ 子路径; 目标应用需支持 base, 否则可能白屏'
    : '手机/其他设备可访问; 目标应用需支持子路径 base, 否则可能白屏'
}

function relativeTime(now, iso) {
  if (typeof iso !== 'string' || iso === '') return '—'
  const value = new Date(iso).getTime()
  if (!Number.isFinite(value)) return '—'
  const seconds = Math.max(0, Math.floor((now - value) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return seconds + ' 秒前'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  return Math.floor(hours / 24) + ' 天前'
}

function statusOf(row) {
  if (row?.status !== undefined) return row.status
  if (row?.enabled === false) return 'disabled'
  if (row?.error !== undefined) return 'route_error'
  if (row?.health?.state === 'online') return 'online'
  if (row?.health?.state === 'offline') return 'offline'
  return 'unknown'
}

const STATUS_TEXT = {
  online: '在监听',
  offline: '目标未在监听',
  disabled: '已停用',
  route_error: '无法开放',
  unknown: '未检测',
}
const STATUS_TONE = { online: 'ok', offline: 'warn', disabled: 'dim', route_error: 'danger', unknown: 'dim' }
const statusTextOf = (status) => STATUS_TEXT[status] ?? STATUS_TEXT.unknown
const statusToneOf = (status) => STATUS_TONE[status] ?? STATUS_TONE.unknown

function statsTextOf(stats, now) {
  if (stats === undefined || stats === null) return '本次运行暂无访问'
  const count = Number.isInteger(stats.requests) ? stats.requests : 0
  if (count === 0) return '本次运行暂无访问'
  const last = stats.lastAccessAt === null ? '' : ' · ' + relativeTime(now, stats.lastAccessAt)
  return '本次运行 ' + count + ' 次' + last
}

function tunnelRowVM(row, location, now) {
  const status = statusOf(row)
  return {
    url: accessUrlOf(row, location),
    status,
    statusText: statusTextOf(status),
    statusTone: statusToneOf(status),
    statsText: statsTextOf(row.stats, now),
    localOnly: accessLocalOnly(row, location),
  }
}

// 端口视图: 默认只显示候选, 搜索端口/进程/绑定地址, 容器转发器排到最后。
function portView(items, options = {}) {
  const query = String(options.query ?? '').trim().toLowerCase()
  const showAll = options.showAll === true
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : PORT_LIMIT
  const matches = (item) => {
    if (!showAll && item.dev !== true) return false
    if (query === '') return true
    return String(item.port).includes(query)
      || String(item.process ?? '').toLowerCase().includes(query)
      || String(item.bind ?? '').toLowerCase().includes(query)
  }
  const rank = (item) => {
    const process = String(item.process ?? '').toLowerCase()
    if (/wslrelay|docker|vmmem/.test(process)) return 2
    return item.dev === true ? 0 : 1
  }
  const sorted = (Array.isArray(items) ? items : []).filter(matches)
    .sort((left, right) => rank(left) - rank(right) || left.port - right.port)
  return { visible: sorted.slice(0, limit), rest: sorted.slice(limit), total: sorted.length }
}

function tunnelBodyOf(mode, draft, name) {
  const body = { targetPort: Number(draft.targetPort), entry: draft.entry }
  if (name !== '') body.name = name
  return body
}

function suggestName(port, processName) {
  const base = String(processName ?? '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const safe = NAME_HAS_LETTER_RE.test(base) ? base : 'app'
  const suffix = '-' + port
  const clipped = safe.slice(0, 32 - suffix.length).replace(/-+$/g, '') || 'app'
  return clipped + suffix
}

function formatCreatedAtFull(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString()
}

function copyViaSelection(document, text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  document.body.removeChild(area)
  return copied
}

async function copyText(text, document) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* 降级到选区复制 */ }
  }
  return copyViaSelection(document, text)
}

function createRefreshGate(readVisible, run) {
  let pending = false
  return {
    request() {
      if (!readVisible()) {
        pending = true
        return false
      }
      run()
      return true
    },
    flush() {
      if (pending && readVisible()) {
        pending = false
        run()
        return true
      }
      return false
    },
    get pending() { return pending },
  }
}

function isPageVisible(document) {
  return document === undefined || document.visibilityState !== 'hidden'
}

// 底部状态条: 停用隧道不算开放; 开放时长按分钟/小时/天收敛, 超阈值标提醒。
const STALE_OPEN_MS = 24 * 60 * 60 * 1000
const STALE_OPEN_HOURS = STALE_OPEN_MS / (60 * 60 * 1000)
const AGE_JUST_OPENED = '不到 1 分钟'

function liveTunnels(rows) {
  // enabled 是用户意图, active 是运行期路由是否真正注册; 恢复失败的行不算开放。
  return (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === 'object' && row.enabled !== false && row.active !== false)
}

function openAgeOf(now, iso) {
  if (typeof iso !== 'string' || iso === '') return -1
  const value = new Date(iso).getTime()
  return Number.isFinite(value) ? Math.max(0, now - value) : -1
}

function openAgeText(now, iso) {
  const age = openAgeOf(now, iso)
  if (age < 0) return ''
  if (age < 60 * 1000) return AGE_JUST_OPENED
  const minutes = Math.floor(age / (60 * 1000))
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时'
  return Math.floor(hours / 24) + ' 天'
}

function openAgePhrase(ageText) {
  if (ageText === '') return ''
  if (ageText === AGE_JUST_OPENED) return '已开放' + AGE_JUST_OPENED
  return '已开放 ' + ageText
}

function statusBarSummary(rows, now) {
  const list = liveTunnels(rows)
  if (list.length === 0) return null
  // 单条给细节, 多条只报数量: 单行不承载列表。
  if (list.length === 1) {
    const row = list[0]
    const ageText = openAgeText(now, row.createdAt)
    return {
      count: 1,
      headline: '隧道开放中',
      detail: row.name + (ageText === '' ? '' : ' · ' + openAgePhrase(ageText)),
      stale: openAgeOf(now, row.createdAt) >= STALE_OPEN_MS,
    }
  }
  const stale = list.some((row) => openAgeOf(now, row.createdAt) >= STALE_OPEN_MS)
  return {
    count: list.length,
    headline: '隧道 ' + list.length + ' 条运行中',
    detail: stale ? '有隧道开放超过 ' + STALE_OPEN_HOURS + ' 小时' : '',
    stale,
  }
}

function statusBarRowVM(row, now, location) {
  const ageText = openAgeText(now, row.createdAt)
  return {
    url: accessUrlOf(row, location),
    openText: openAgePhrase(ageText),
    stale: openAgeOf(now, row.createdAt) >= STALE_OPEN_MS,
  }
}
/* LOGIC-END */

/* SBUILD-BEGIN */
const STYLE_ID = 'dsh-tunnel-style'
const CLOCK_TICK_MS = 60 * 1000
const CSS = `
/* 菜单 portal 到 body, 脱离设置分区与状态条, 必须自带 token */
.tu-set,.tu-bottom,.tu-menu{
  --tu-bg:var(--dsw-alias-bg-base);
  --tu-bg-sub:var(--dsw-alias-bg-layer-2);
  --tu-text:var(--dsw-alias-label-primary);
  --tu-text-sub:var(--dsw-alias-label-secondary);
  --tu-text-dim:var(--dsw-alias-label-tertiary);
  --tu-border:var(--dsw-alias-border-l4);
  --tu-border-2:var(--dsw-alias-border-l2);
  --tu-hover:var(--dsw-alias-bg-hover);
  --tu-ok:var(--dsw-alias-state-success-primary);
  --tu-warn:var(--dsw-alias-state-warn-primary);
  --tu-danger:var(--dsw-alias-state-error-primary);
  --tu-business:var(--dsw-alias-state-business-primary);
  --tu-radius:8px;
  --tu-space-1:4px;
  --tu-space-2:8px;
  --tu-space-3:12px;
  --tu-space-4:16px;
  --tu-space-5:24px;
}
.tu-set{max-width:560px;display:flex;flex-direction:column;gap:var(--tu-space-4);font-size:14px;line-height:22px;color:var(--tu-text);container-type:inline-size;container-name:tu-set}
.tu-set--embedded{max-width:none}

.tu-set-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--tu-space-3)}
.tu-set-head__title{margin:0;font-size:18px;line-height:26px;font-weight:600}
.tu-set-head__desc{margin:var(--tu-space-1) 0 0;color:var(--tu-text-sub);font-size:13px;line-height:20px}
.tu-set-head__actions{display:flex;align-items:center;gap:var(--tu-space-2);flex:0 0 auto}
.tu-card{background:var(--tu-bg-sub);border:.5px solid var(--tu-border);border-radius:var(--tu-radius);overflow:visible}
.tu-card__head{display:flex;align-items:center;gap:var(--tu-space-2);min-height:44px;padding:0 var(--tu-space-4);border-bottom:.5px solid var(--tu-border)}
.tu-card__title{margin:0;font-size:14px;font-weight:600;white-space:nowrap}
.tu-card__meta{margin-left:auto;color:var(--tu-text-dim);font-size:12px;white-space:nowrap}
.tu-card__actions{display:flex;align-items:center;gap:var(--tu-space-2)}
.tu-list{display:flex;flex-direction:column}
.tu-row{padding:var(--tu-space-3) var(--tu-space-4);border-bottom:.5px solid var(--tu-border);position:relative}
.tu-row:last-child{border-bottom:0}
.tu-row:hover{background:var(--tu-hover)}
.tu-row__head{display:flex;align-items:center;gap:var(--tu-space-2);min-width:0}
.tu-row__name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tu-row__port{color:var(--tu-text-dim);font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}
.tu-row__actions{margin-left:auto;display:flex;align-items:center;gap:var(--tu-space-1);flex:0 0 auto}
.tu-row__url{display:block;margin-top:var(--tu-space-1);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;color:var(--tu-business);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tu-row__url:hover{text-decoration:underline}
.tu-row__url--disabled{color:var(--tu-text-dim);cursor:not-allowed}
.tu-row__url--disabled:hover{text-decoration:none}
.tu-row__meta{display:flex;align-items:center;gap:var(--tu-space-1);margin-top:2px;color:var(--tu-text-dim);font-size:12px;line-height:18px;flex-wrap:wrap}
.tu-row__error{margin-top:2px;color:var(--tu-danger);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.tu-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--tu-text-dim)}
.tu-dot--ok{background:var(--tu-ok)}
.tu-dot--warn{background:var(--tu-warn)}
.tu-dot--danger{background:var(--tu-danger)}
.tu-badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;background:var(--tu-bg);border:.5px solid var(--tu-border-2);color:var(--tu-text-sub);font-size:11px;line-height:18px;white-space:nowrap}
.tu-badge--ok{color:var(--tu-ok);border-color:color-mix(in srgb, var(--tu-ok) 35%, transparent)}
.tu-badge--warn{color:var(--tu-warn);border-color:color-mix(in srgb, var(--tu-warn) 35%, transparent)}
.tu-badge--danger{color:var(--tu-danger);border-color:color-mix(in srgb, var(--tu-danger) 35%, transparent)}
.tu-button{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 10px;border:.5px solid var(--tu-border-2);border-radius:6px;background:var(--tu-bg);color:var(--tu-text);font:inherit;font-size:12px;cursor:pointer;text-decoration:none;white-space:nowrap}
.tu-button:hover{background:var(--tu-hover)}
.tu-button:focus-visible,.tu-icon-btn:focus-visible,.tu-switch input[type="checkbox"]:focus-visible + .tu-switch__track{outline:2px solid var(--tu-business);outline-offset:1px}
.tu-button--primary{background:var(--tu-business);border-color:var(--tu-business);color:#fff}
.tu-button--primary:hover{filter:brightness(.95);background:var(--tu-business)}
.tu-button--sm{height:28px;padding:0 8px}
.tu-button--ghost{border-color:transparent;background:transparent;color:var(--tu-text-sub)}
.tu-button--ghost:hover{background:var(--tu-hover);color:var(--tu-text)}
.tu-button--danger{color:var(--tu-danger);border-color:color-mix(in srgb, var(--tu-danger) 35%, transparent)}
.tu-button--danger:hover{background:color-mix(in srgb, var(--tu-danger) 10%, transparent)}
.tu-button:disabled{opacity:.45;cursor:not-allowed}
.tu-icon-btn{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--tu-text-sub);font:inherit;font-size:18px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.tu-icon-btn:hover{background:var(--tu-hover);color:var(--tu-text)}
.tu-menu{position:absolute;right:var(--tu-space-4);top:40px;z-index:5;min-width:150px;padding:var(--tu-space-1);background:var(--tu-bg);border:.5px solid var(--tu-border-2);border-radius:6px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.12))}
.tu-menu--floating{position:fixed;right:auto;top:auto;z-index:1200}
.tu-menu__item{display:block;width:100%;padding:7px 10px;border:0;border-radius:4px;background:transparent;color:var(--tu-text);font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap}
.tu-menu__item:hover{background:var(--tu-hover)}
.tu-menu__item--danger{color:var(--tu-danger)}
.tu-menu__item--armed{background:var(--tu-danger);color:#fff}
.tu-menu__item--armed:hover{background:var(--tu-danger);color:#fff}
.tu-empty{padding:var(--tu-space-5) var(--tu-space-4);color:var(--tu-text-dim);font-size:13px;text-align:center}
.tu-empty__actions{margin-top:var(--tu-space-3)}
.tu-notice{display:flex;gap:var(--tu-space-2);padding:10px 12px;border-left:2px solid var(--tu-warn);background:color-mix(in srgb, var(--tu-warn) 8%, transparent);color:var(--tu-text);font-size:13px;line-height:20px;border-radius:4px}
.tu-notice--danger{border-left-color:var(--tu-danger);background:color-mix(in srgb, var(--tu-danger) 8%, transparent)}
.tu-notice--muted{border-left-color:var(--tu-border-2);background:var(--tu-bg-sub);color:var(--tu-text-sub)}
.tu-port{display:flex;align-items:center;gap:var(--tu-space-2);padding:9px var(--tu-space-4);border-bottom:.5px solid var(--tu-border);min-width:0}
.tu-port:last-child{border-bottom:0}
.tu-port__port{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;font-variant-numeric:tabular-nums;color:var(--tu-text);min-width:52px}
.tu-port__proc{color:var(--tu-text-sub);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.tu-port__bind{color:var(--tu-text-dim);font-size:12px;white-space:nowrap}
.tu-port__actions{margin-left:auto;display:flex;align-items:center;gap:var(--tu-space-1)}
.tu-card__filter{display:flex;align-items:center;gap:var(--tu-space-2);padding:var(--tu-space-2) var(--tu-space-4);border-bottom:.5px solid var(--tu-border)}
.tu-input{height:30px;min-width:0;padding:0 8px;border:.5px solid var(--tu-border-2);border-radius:6px;background:var(--tu-bg);color:var(--tu-text);font:inherit;font-size:13px;box-sizing:border-box}
.tu-input:focus{outline:2px solid var(--tu-business);outline-offset:1px}
.tu-input--search{flex:1}
.tu-card__more{padding:var(--tu-space-2) var(--tu-space-4);border-top:.5px solid var(--tu-border);text-align:center}
.tu-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;color:var(--tu-text-sub);font-size:12px}
.tu-switch input[type="checkbox"]{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.tu-switch__track{width:28px;height:16px;border-radius:8px;background:var(--tu-border-2);position:relative;transition:background .15s}
.tu-switch__thumb{position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s}
.tu-switch input[type="checkbox"]:checked + .tu-switch__track{background:var(--tu-business)}
.tu-switch input[type="checkbox"]:checked + .tu-switch__track .tu-switch__thumb{transform:translateX(12px)}
.tu-switch input[type="checkbox"]:disabled + .tu-switch__track{opacity:.45}
.tu-switch:not(:has(input[type="checkbox"]:disabled)):hover .tu-switch__track{filter:brightness(.96)}
.tu-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--tu-space-3)}
.tu-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.tu-field--wide{grid-column:1 / -1}
.tu-field__label{font-size:13px;color:var(--tu-text)}
.tu-hint{color:var(--tu-text-dim);font-size:12px;line-height:18px}
.tu-error{color:var(--tu-danger);font-size:12px;line-height:18px}
.tu-ok{color:var(--tu-ok);font-size:12px;line-height:18px}
.tu-pill-group{display:flex;gap:var(--tu-space-2);flex-wrap:wrap}
.tu-pill{height:30px;padding:0 10px;border:.5px solid var(--tu-border-2);border-radius:6px;background:var(--tu-bg);color:var(--tu-text-sub);font:inherit;font-size:12px;cursor:pointer}
.tu-pill--active{border-color:var(--tu-business);background:color-mix(in srgb, var(--tu-business) 10%, transparent);color:var(--tu-text)}
/* 与宿主模态层同级(1100), 高于设置面板(1000); 同层按 DOM 顺序, 状态条弹窗需在宿主遮罩之上 */
.tu-modal{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);padding:var(--tu-space-4)}
.tu-modal__box{width:min(440px,100%);max-height:90vh;overflow:auto;background:var(--tu-bg);border:.5px solid var(--tu-border-2);border-radius:var(--tu-radius);box-shadow:0 16px 48px rgba(0,0,0,.2)}
/* 宽于设置分区, 容纳列表行 */
.tu-modal__box--wide{width:min(760px,100%)}
.tu-modal__head{display:flex;align-items:center;justify-content:space-between;padding:var(--tu-space-3) var(--tu-space-4);border-bottom:.5px solid var(--tu-border)}
.tu-modal__title{margin:0;font-size:15px;font-weight:600}
.tu-modal__body{padding:var(--tu-space-4);display:flex;flex-direction:column;gap:var(--tu-space-3)}
.tu-modal__foot{display:flex;justify-content:flex-end;gap:var(--tu-space-2);padding:var(--tu-space-3) var(--tu-space-4);border-top:.5px solid var(--tu-border)}
.tu-skeleton{padding:var(--tu-space-4)}
.tu-skeleton__line{height:12px;margin-bottom:10px;border-radius:4px;background:var(--tu-border)}
.tu-skeleton__line:nth-child(2){width:70%}
.tu-skeleton__line:nth-child(3){width:45%}
@container tu-set (max-width:520px){
  .tu-grid{grid-template-columns:1fr}
  .tu-row__head{flex-wrap:wrap}
  .tu-row__actions{margin-left:0;width:100%;justify-content:flex-end}
  .tu-port__proc{max-width:90px}
}
@container tu-set (max-width:380px){
  .tu-card--ports .tu-card__head{flex-wrap:wrap;row-gap:6px}
  .tu-card--ports .tu-card__actions{margin-left:0;width:100%;justify-content:flex-end}
}
/* 底部状态条与设置分区共享 token; 无隧道时组件返回 null, 不占宿主高度 */
.tu-bottom{background:var(--tu-bg);border-top:.5px solid var(--tu-border-2);color:var(--tu-text);font-size:12px;line-height:18px}
.tu-bottom__open{display:flex;align-items:center;gap:var(--tu-space-2);width:100%;height:28px;padding:0 var(--tu-space-3);border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.tu-bottom__open:hover{background:var(--tu-hover)}
.tu-bottom__open:focus-visible{outline:2px solid var(--tu-business);outline-offset:-2px}
.tu-bottom__icon{width:16px;height:16px;flex:0 0 auto;color:var(--tu-text-sub)}
.tu-bottom__head{font-weight:600;white-space:nowrap}
.tu-bottom__detail{color:var(--tu-text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tu-bottom__detail--stale{color:var(--tu-warn)}
.tu-bottom__spacer{flex:1 1 auto}
.tu-bottom__more{display:inline-flex;align-items:center;gap:var(--tu-space-1);color:var(--tu-text-sub);white-space:nowrap;flex:0 0 auto}
`
/* SBUILD-END */

// 空模块兜底:react 缺席即整面板禁用(宿主必有 react, 防御性)
function noopFactory() {
  return { inject: [], apply() {} }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-tunnel', factory })

  const NAV_ICON = { '穿透隧道': 'globe', 'dsh-tunnel': 'globe' }
  if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
  else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
  else window.__navicIconQueue = [NAV_ICON]

  function factory(require) {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      console.error('[dsh-tunnel] 宿主 React 模块加载失败', error)
      return noopFactory()
    }
    const tools = require('@mzzsfy/dsh-common-tools/client')
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React
    const h = (type, props, ...children) => React.createElement(type, props || null, ...children)
    // 宿主模块表不保证提供 react-dom 主入口: 缺失时菜单退回原地渲染(仍可用, 但可能被滚动容器裁剪)
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    function ensureStyle(document) {
      let style = document.getElementById(STYLE_ID)
      if (style !== null) {
        if (style.textContent !== CSS) style.textContent = CSS
        style.setAttribute('data-plugin', '@mzzsfy/dsh-tunnel')
        return
      }
      style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', '@mzzsfy/dsh-tunnel')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function request(method, endpoint, body) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const init = { method, headers: {}, signal: controller.signal }
        if (method !== 'GET' && method !== 'HEAD') {
          init.headers['content-type'] = 'application/json'
          if (body !== undefined) init.body = JSON.stringify(body)
        }
        const response = await fetch(API_PREFIX + endpoint, init)
        let data = null
        try { data = await response.json() } catch { data = null }
        if (!response.ok) return { ok: false, error: data?.error ?? '请求失败(' + response.status + ')' }
        return { ok: true, data: data ?? {} }
      } catch (error) {
        return { ok: false, error: error?.name === 'AbortError' ? '请求超时' : '网络请求失败' }
      } finally {
        clearTimeout(timer)
      }
    }

    function switchToggle(props) {
      return h('label', { className: 'tu-switch' },
        h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange, 'aria-label': props.label }),
        h('span', { className: 'tu-switch__track' }, h('span', { className: 'tu-switch__thumb' })),
        props.label ? h('span', null, props.label) : null)
    }

    function Modal({ title, onClose, children, wide = false }) {
      const boxRef = useRef(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      useEffect(() => {
        const previous = document.activeElement
        const box = boxRef.current
        // 嵌套弹窗只让最上层响应 Esc/Tab: 后挂载的 box 在 DOM 末尾。
        const topmost = () => {
          if (box === null) return false
          const boxes = document.querySelectorAll('.tu-modal__box')
          return boxes.length <= 1 || boxes[boxes.length - 1] === box
        }
        const focusable = () => Array.from(box?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
        const preferred = box?.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
        if (preferred) preferred.focus()
        else focusable()[0]?.focus()
        const onKey = (event) => {
          if (!topmost()) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopImmediatePropagation()
            event.stopPropagation()
            closeRef.current()
            return
          }
          if (event.key !== 'Tab' || box === null) return
          const items = focusable()
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          previous?.focus?.()
        }
      }, [])
      return h('div', { className: 'tu-modal', onMouseDown: (event) => { if (event.target === event.currentTarget) closeRef.current() } },
        h('div', { ref: boxRef, className: 'tu-modal__box' + (wide ? ' tu-modal__box--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
          h('div', { className: 'tu-modal__head' },
            h('h3', { className: 'tu-modal__title' }, title),
            h('button', { type: 'button', className: 'tu-icon-btn', 'aria-label': '关闭', onClick: () => closeRef.current() }, '×')),
          children))
    }

    function PillGroup({ options, value, onChange }) {
      return h('div', { className: 'tu-pill-group', role: 'radiogroup' },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          role: 'radio',
          'aria-checked': value === option.value,
          className: 'tu-pill' + (value === option.value ? ' tu-pill--active' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    function useTunnelData(bus) {
      const [rows, setRows] = useState(null)
      const [lanOrigin, setLanOrigin] = useState('')
      const [error, setError] = useState('')
      const [probing, setProbing] = useState(false)
      const aliveRef = useRef(true)
      const gateRef = useRef(null)
      const startedRef = useRef(false)
      const load = useCallback(async () => {
        setProbing(true)
        const [listOutcome, statusOutcome] = await Promise.all([
          request('GET', '/tunnels?probe=1'),
          request('GET', '/status'),
        ])
        if (!aliveRef.current) return
        setProbing(false)
        if (listOutcome.ok) {
          setRows(listOutcome.data.items)
          setError('')
        } else setError(listOutcome.error)
        if (statusOutcome.ok && typeof statusOutcome.data.lanOrigin === 'string') setLanOrigin(statusOutcome.data.lanOrigin)
      }, [])
      const reload = useCallback(() => gateRef.current?.request(), [])
      useEffect(() => {
        aliveRef.current = true
        startedRef.current = false
        const snapshot = tools.createSnapshotRefresh(load)
        const gate = createRefreshGate(() => isPageVisible(document), snapshot.refresh)
        gateRef.current = gate
        const unsubscribe = bus.subscribe(() => gate.request(), {
          onReset: () => { startedRef.current = true; gate.request() },
        })
        const onVisibility = () => gate.flush()
        document.addEventListener('visibilitychange', onVisibility)
        if (!startedRef.current) gate.request()
        return () => {
          aliveRef.current = false
          unsubscribe()
          document.removeEventListener('visibilitychange', onVisibility)
          snapshot.dispose?.()
          gateRef.current = null
        }
      }, [bus, load])
      return { rows, lanOrigin, error, probing, reload }
    }

    function SetHead({ onAdd, embedded }) {
      return h('header', { className: 'tu-set-head' },
        h('div', null,
          embedded ? null : h('h2', { className: 'tu-set-head__title' }, SECTION_LABEL),
          h('p', { className: 'tu-set-head__desc' }, embedded ? '管理已开放隧道、本机端口与访问地址。' : '把本机正在跑的服务临时变成一条链接, 给浏览器、手机或其他设备用。')),
        h('div', { className: 'tu-set-head__actions' },
          h('button', { type: 'button', className: 'tu-button tu-button--primary', onClick: onAdd }, '手动添加')))
    }

    function Notice({ tone = 'warn', children }) {
      return h('div', { className: 'tu-notice' + (tone === 'danger' ? ' tu-notice--danger' : tone === 'muted' ? ' tu-notice--muted' : ''), role: tone === 'danger' ? 'alert' : undefined }, children)
    }

    function copyWithFlash(text, onDone) {
      copyText(text, document).then((ok) => {
        if (ok) onDone?.('已复制')
      })
    }

    function TunnelRow({ row, now, lanOrigin, onEdit, onToggle, onRemove }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const [menuAnchor, setMenuAnchor] = useState(null)
      const [menuPos, setMenuPos] = useState(null)
      const [armed, setArmed] = useState(false)
      const [flash, setFlash] = useState('')
      const rootRef = useRef(null)
      const menuRef = useRef(null)
      useEffect(() => {
        if (!menuOpen) return undefined
        const close = (event) => {
          const target = event.target
          if (rootRef.current !== null && rootRef.current.contains?.(target)) return
          if (menuRef.current !== null && menuRef.current.contains?.(target)) return
          setMenuOpen(false)
          setArmed(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') { setMenuOpen(false); setArmed(false) } }
        // 菜单是浮层快照: 滚动/缩放后锚点失效, 直接收起而不是跟随
        const onViewport = () => { setMenuOpen(false); setArmed(false) }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        window.addEventListener('scroll', onViewport, true)
        window.addEventListener('resize', onViewport)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('scroll', onViewport, true)
          window.removeEventListener('resize', onViewport)
        }
      }, [menuOpen])
      // 菜单按触发按钮实测高度摆位: 下方放不下就翻到上方, 两侧都放不下取下方并夹进视口
      const vm = tunnelRowVM(row, window.location, now)
      const url = vm.url
      const urlDisabled = row.enabled === false || vm.status === 'route_error'
      const tone = vm.statusTone
      const lanUrl = row.entry === ENTRY_PATH && lanOrigin !== '' && isLoopbackHost(window.location.hostname)
        ? lanOrigin + PATH_PREFIX + row.name + '/'
        : ''
      const copy = (text) => copyWithFlash(text, (text) => {
        setFlash(text)
        setTimeout(() => setFlash(''), COPY_FLASH_MS)
      })
      const closeMenu = () => { setMenuOpen(false); setArmed(false) }
      const floating = createPortal !== null
      // 菜单项数随局域网地址存在与否变化, 高度须在每次打开/项数变化后重测
      useLayoutEffect(() => {
        if (!floating || !menuOpen || menuAnchor === null || menuRef.current === null) return
        const height = menuRef.current.offsetHeight
        const below = menuAnchor.bottom + MENU_GAP
        const above = menuAnchor.top - MENU_GAP - height
        const fitsBelow = below + height + MENU_MARGIN <= window.innerHeight
        const top = fitsBelow || above < MENU_MARGIN ? below : above
        setMenuPos({ right: menuAnchor.right, top: Math.max(MENU_MARGIN, top) })
      }, [floating, menuOpen, menuAnchor, armed, lanUrl])
      const toggleMenu = (event) => {
        if (menuOpen) { closeMenu(); return }
        const rect = event.currentTarget.getBoundingClientRect()
        setMenuAnchor({
          right: Math.max(MENU_MARGIN, window.innerWidth - rect.right),
          top: rect.top,
          bottom: rect.bottom,
        })
        setMenuPos(null)
        setMenuOpen(true)
      }
      const menu = menuOpen ? h('div', {
        ref: menuRef,
        className: 'tu-menu' + (floating ? ' tu-menu--floating' : ''),
        role: 'menu',
        style: floating
          ? (menuPos === null ? { visibility: 'hidden' } : { right: menuPos.right, top: menuPos.top })
          : undefined,
      },
        h('button', { type: 'button', className: 'tu-menu__item', role: 'menuitem', onClick: () => { copy(url); closeMenu() } }, '复制地址'),
        lanUrl !== '' ? h('button', { type: 'button', className: 'tu-menu__item', role: 'menuitem', onClick: () => { copy(lanUrl); closeMenu() } }, '复制局域网地址') : null,
        h('button', { type: 'button', className: 'tu-menu__item', role: 'menuitem', onClick: () => { onEdit(row); closeMenu() } }, '编辑'),
        h('button', { type: 'button', className: 'tu-menu__item', role: 'menuitem', onClick: () => { onToggle(row); closeMenu() } }, row.enabled === false ? '启用' : '停用'),
        h('button', {
          type: 'button',
          className: 'tu-menu__item tu-menu__item--danger' + (armed ? ' tu-menu__item--armed' : ''),
          role: 'menuitem',
          onClick: () => { if (!armed) { setArmed(true); return } onRemove(row); closeMenu() },
        }, armed ? '确认删除' : '删除')) : null
      return h('div', { className: 'tu-row', ref: rootRef },
        h('div', { className: 'tu-row__head' },
          h('span', { className: 'tu-dot tu-dot--' + tone, 'aria-hidden': 'true' }),
          h('span', { className: 'tu-row__name', title: row.name }, row.name),
          h('span', { className: 'tu-badge' }, ENTRY_LABELS[row.entry] ?? row.entry),
          h('span', { className: 'tu-row__port' }, ':' + row.targetPort),
          h('div', { className: 'tu-row__actions' },
            urlDisabled
              ? h('button', { type: 'button', className: 'tu-button tu-button--sm', disabled: true, title: vm.statusText }, '打开')
              : h('a', { className: 'tu-button tu-button--sm tu-button--primary', href: url, target: '_blank', rel: 'noreferrer' }, '打开'),
            h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--ghost', onClick: () => copy(url) }, flash || '复制'),
            h('button', { type: 'button', className: 'tu-icon-btn', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, 'aria-label': '更多操作', onClick: toggleMenu }, '⋯'),
            // 浮层菜单必须挂在 body: 设置面板内容区是 overflow:auto, 原地绝对定位会被裁剪/遮挡
            menu !== null && createPortal !== null && typeof document !== 'undefined' && document.body
              ? createPortal(menu, document.body)
              : menu)),
        urlDisabled
          ? h('span', { className: 'tu-row__url tu-row__url--disabled', title: url }, url)
          : h('a', { className: 'tu-row__url', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
        h('div', { className: 'tu-row__meta' },
          h('span', null, vm.statusText),
          h('span', null, '·'),
          h('span', null, vm.statsText),
          vm.localOnly ? h('span', { className: 'tu-badge' }, '仅本机') : null),
        row.error !== undefined ? h('div', { className: 'tu-row__error', role: 'alert' }, row.error) : null)
    }

    function EmptyTunnel({ onAdd }) {
      return h('div', { className: 'tu-empty' },
        h('div', null, '还没有开放任何端口。从下方本机服务选择一个, 或手动添加。'),
        h('div', { className: 'tu-empty__actions' },
          h('button', { type: 'button', className: 'tu-button', onClick: onAdd }, '手动添加隧道')))
    }

    function TunnelCard({ rows, now, lanOrigin, error, probing, reload, onAdd, onEdit, onToggle, onRemove }) {
      const list = rows ?? []
      const online = list.filter((row) => statusOf(row) === 'online').length
      return h('section', { className: 'tu-card', 'aria-label': '已开放隧道' },
        h('div', { className: 'tu-card__head' },
          h('h3', { className: 'tu-card__title' }, '已开放隧道'),
          h('span', { className: 'tu-card__meta' }, list.length + ' 条' + (list.length > 0 ? ' · ' + online + ' 个在监听' : '')),
          h('div', { className: 'tu-card__actions' },
            h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--ghost', disabled: probing, onClick: reload }, probing ? '检测中…' : '刷新'))),
        error !== '' ? h('div', { style: { padding: '12px 16px 0' } }, h(Notice, { tone: 'danger' }, error)) : null,
        rows === null ? h('div', { className: 'tu-skeleton' },
          h('div', { className: 'tu-skeleton__line' }),
          h('div', { className: 'tu-skeleton__line' }),
          h('div', { className: 'tu-skeleton__line' }))
          : list.length === 0 ? h(EmptyTunnel, { onAdd })
            : h('div', { className: 'tu-list' }, list.map((row) => h(TunnelRow, {
              key: row.name,
              row,
              now,
              lanOrigin,
              onEdit,
              onToggle,
              onRemove,
            }))))
    }

    function PortRow({ item, onOpen }) {
      return h('div', { className: 'tu-port' },
        h('span', { className: 'tu-port__port' }, ':' + item.port),
        h('span', { className: 'tu-port__proc', title: item.process ?? '' }, item.process ?? '未知进程'),
        h('span', { className: 'tu-port__bind' }, item.bind ?? ''),
        h('div', { className: 'tu-port__actions' },
          item.tunnelNames?.length > 0
            ? h('span', { className: 'tu-badge tu-badge--ok', title: item.tunnelNames.join(', ') }, '已开放')
            : h('button', { type: 'button', className: 'tu-button tu-button--sm', onClick: () => onOpen(item) }, '开放')))
    }

    function PortsCard({ onOpen, refreshKey }) {
      const [expanded, setExpanded] = useState(false)
      const [ports, setPorts] = useState(null)
      const [supported, setSupported] = useState(true)
      const [reason, setReason] = useState('')
      const [scannedAt, setScannedAt] = useState('')
      const [query, setQuery] = useState('')
      const [showAll, setShowAll] = useState(false)
      const [limit, setLimit] = useState(PORT_LIMIT)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const aliveRef = useRef(true)
      const loadSeqRef = useRef(0)
      useEffect(() => () => { aliveRef.current = false }, [])
      const load = useCallback(async (refresh = false) => {
        const seq = ++loadSeqRef.current
        setBusy(true)
        const outcome = await request('GET', '/ports?all=' + (showAll ? '1' : '0') + (refresh ? '&refresh=1' : ''))
        if (!aliveRef.current || seq !== loadSeqRef.current) return
        setBusy(false)
        if (!outcome.ok) { setError(outcome.error); return }
        setError('')
        setSupported(outcome.data.supported !== false)
        setReason(outcome.data.reason ?? '')
        setScannedAt(outcome.data.scannedAt ?? '')
        setPorts(Array.isArray(outcome.data.items) ? outcome.data.items : [])
      }, [showAll])
      useEffect(() => { if (expanded) load() }, [expanded, load]) // 展开与范围变化都按当前筛选重扫
      useEffect(() => { if (expanded && ports !== null) load(true) }, [refreshKey]) // 隧道增删改后同步“已开放”标记
      const view = portView(ports ?? [], { query, showAll, limit })
      return h('section', { className: 'tu-card tu-card--ports', 'aria-label': '本机服务' },
        h('div', { className: 'tu-card__head' },
          h('button', {
            type: 'button',
            className: 'tu-button tu-button--ghost tu-button--sm',
            'aria-expanded': expanded,
            'aria-label': expanded ? '收起本机服务' : '展开本机服务',
            onClick: () => setExpanded(!expanded),
          }, expanded ? '▾' : '▸'),
          h('h3', { className: 'tu-card__title' }, '本机服务'),
          h('span', { className: 'tu-card__meta' }, ports === null ? '展开后扫描' : view.total + ' 个端口'),
          h('div', { className: 'tu-card__actions' },
            h(switchToggle, { checked: showAll, onChange: (event) => setShowAll(event.target.checked), label: '显示全部' }),
            h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--ghost', disabled: busy, onClick: () => load(true) }, busy ? '扫描中…' : '重新扫描'))),
        expanded ? h('div', null,
          error !== '' ? h('div', { style: { padding: '8px 16px' } }, h(Notice, { tone: 'danger' }, error)) : null,
          supported === false ? h('div', { style: { padding: '8px 16px' } }, h(Notice, { tone: 'muted' }, reason || '当前平台无法自动发现, 请手动添加。')) : null,
          h('div', { className: 'tu-card__filter' },
            h('input', { type: 'search', className: 'tu-input tu-input--search', placeholder: '过滤端口 / 进程 / 地址', 'aria-label': '过滤端口', value: query, onChange: (event) => setQuery(event.target.value) }),
            h('span', { className: 'tu-card__meta' }, scannedAt === '' ? '' : '扫描于 ' + new Date(scannedAt).toLocaleTimeString())),
          ports === null ? h('div', { className: 'tu-skeleton' }, h('div', { className: 'tu-skeleton__line' }), h('div', { className: 'tu-skeleton__line' }))
            : view.visible.length === 0 ? h('div', { className: 'tu-empty' }, '没有匹配的端口。')
              : h('div', { className: 'tu-list' }, view.visible.map((item) => h(PortRow, { key: item.port, item, onOpen }))),
          view.rest.length > 0 ? h('div', { className: 'tu-card__more' },
            h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--ghost', onClick: () => setLimit(50) }, '展开其余 ' + view.rest.length + ' 个')) : null)
          : null)
    }

    function TunnelDialog({ mode, row, portItem, onClose, onSaved }) {
      const initial = row ?? { name: '', targetPort: portItem?.port ?? '', entry: defaultEntryFor(window.location) }
      const [draft, setDraft] = useState(initial)
      const [nameTouched, setNameTouched] = useState(mode === 'edit')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [probe, setProbe] = useState(null)
      const selectedProcess = portItem?.process ?? null
      const patch = (part) => setDraft((prev) => ({ ...prev, ...part }))
      useEffect(() => {
        if (mode !== 'create' || nameTouched) return
        const port = Number(draft.targetPort)
        if (!Number.isInteger(port)) return
        setDraft((prev) => ({ ...prev, name: suggestName(port, selectedProcess) }))
      }, [draft.targetPort, mode, nameTouched, selectedProcess])
      useEffect(() => {
        const port = Number(draft.targetPort)
        if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) { setProbe(null); return undefined }
        let alive = true
        const timer = setTimeout(async () => {
          const outcome = await request('GET', '/probe?port=' + port)
          if (!alive || !outcome.ok) return
          setProbe(outcome.data)
        }, PROBE_DEBOUNCE_MS)
        return () => { alive = false; clearTimeout(timer) }
      }, [draft.targetPort])
      const trimmedName = draft.name.trim()
      const nameValid = NAME_RE.test(trimmedName) && NAME_HAS_LETTER_RE.test(trimmedName)
      // 创建允许留空(自动命名), 改名必须给出合法名
      const nameOk = mode === 'edit' ? nameValid : trimmedName === '' || nameValid
      const portValue = Number(draft.targetPort)
      const portOk = Number.isInteger(portValue) && portValue >= PORT_MIN && portValue <= PORT_MAX
      const entryConflict = draft.entry === ENTRY_SUBDOMAIN && trimmedName !== '' && isEntryLabelConflict(trimmedName, window.location.hostname)
      const submit = async () => {
        setBusy(true)
        setError('')
        const body = tunnelBodyOf(mode, draft, trimmedName)
        const outcome = mode === 'create'
          ? await request('POST', '/tunnels', body)
          : await request('PATCH', '/tunnels/' + encodeURIComponent(row.name), body)
        setBusy(false)
        if (!outcome.ok) { setError(outcome.error); return }
        onSaved()
      }
      return h(Modal, { title: mode === 'create' ? '添加隧道' : '编辑隧道', onClose },
        h('div', { className: 'tu-modal__body' },
          h('div', { className: 'tu-field' },
            h('label', { className: 'tu-field__label', htmlFor: 'tu-tunnel-port' }, '目标端口'),
            h('input', { id: 'tu-tunnel-port', type: 'number', className: 'tu-input', value: draft.targetPort, placeholder: PORT_MIN + '..' + PORT_MAX, onChange: (event) => patch({ targetPort: event.target.value }) }),
            probe === null ? h('span', { className: 'tu-hint' }, '本机应用监听端口') : h('span', { className: probe.listening ? 'tu-ok' : 'tu-hint' }, probe.listening ? '端口在监听' : '端口未在监听, 可稍后启动')),
          h('div', { className: 'tu-field' },
            h('label', { className: 'tu-field__label', htmlFor: 'tu-tunnel-name' }, '隧道名'),
            h('input', { id: 'tu-tunnel-name', type: 'text', className: 'tu-input', value: draft.name, placeholder: '留空自动生成 app-<端口>', onChange: (event) => { setNameTouched(true); patch({ name: event.target.value }) } }),
            h('span', { className: 'tu-hint' }, mode === 'edit' ? '名称即访问地址, 改动后旧地址失效' : '小写字母/数字/连字符, 留空自动生成')),
          h('div', { className: 'tu-field tu-field--wide' },
            h('span', { className: 'tu-field__label' }, '入口形态'),
            h(PillGroup, {
              options: [{ label: '路径 /p/<名>', value: ENTRY_PATH }, { label: '子域名 <名>.*', value: ENTRY_SUBDOMAIN }],
              value: draft.entry,
              onChange: (entry) => patch({ entry }),
            }),
            h('span', { className: 'tu-hint' }, entryHintOf(draft.entry, window.location))),
          mode === 'edit' ? h('span', { className: 'tu-hint' }, '修改目标端口或入口会短暂断开当前连接; 入口变化会改变访问地址。') : null,
          error !== '' ? h('div', { className: 'tu-error', role: 'alert' }, error) : null,
          entryConflict ? h('div', { className: 'tu-error' }, '隧道名与当前访问地址首标签冲突(' + entryLabelOf(window.location.hostname) + '): 保存后该地址会进入隧道而不是设置页; 换名, 或改用其它地址打开设置页后再建') : null),
        h('div', { className: 'tu-modal__foot' },
          h('button', { type: 'button', className: 'tu-button', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'tu-button tu-button--primary', disabled: busy || !nameOk || !portOk || entryConflict, onClick: submit }, busy ? '提交中…' : (mode === 'create' ? '创建' : '保存'))))
    }

    // 底部状态条数据: 与设置分区同一 REST, 只跟随总线与可见性刷新, 不周期轮询。
    function useTunnelFeed(bus) {
      const [rows, setRows] = useState(null)
      const aliveRef = useRef(true)
      const startedRef = useRef(false)
      const load = useCallback(async () => {
        const outcome = await request('GET', '/tunnels')
        if (!aliveRef.current || !outcome.ok) return
        setRows(outcome.data.items)
      }, [])
      useEffect(() => {
        aliveRef.current = true
        startedRef.current = false
        const snapshot = tools.createSnapshotRefresh(load)
        const gate = createRefreshGate(() => isPageVisible(document), snapshot.refresh)
        const unsubscribe = bus.subscribe(() => gate.request(), {
          onReset: () => { startedRef.current = true; gate.request() },
        })
        const onVisibility = () => gate.flush()
        document.addEventListener('visibilitychange', onVisibility)
        if (!startedRef.current) gate.request()
        return () => {
          aliveRef.current = false
          unsubscribe()
          document.removeEventListener('visibilitychange', onVisibility)
          snapshot.dispose?.()
        }
      }, [bus, load])
      return { rows }
    }

    function TunnelStatusBar({ bus }) {
      const { rows } = useTunnelFeed(bus)
      const [open, setOpen] = useState(false)
      const [now, setNow] = useState(() => Date.now())
      const summary = statusBarSummary(rows, now)
      const hasSummary = summary !== null
      // 只驱动本地时长重算, 不发请求; 页面恢复可见时立即校准。
      useEffect(() => {
        if (!hasSummary) return undefined
        let timer = null
        const tick = () => {
          setNow(Date.now())
          timer = setTimeout(tick, CLOCK_TICK_MS)
        }
        timer = setTimeout(tick, CLOCK_TICK_MS)
        const onVisibility = () => { if (isPageVisible(document)) setNow(Date.now()) }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [hasSummary])
      const location = window.location
      const icon = h('svg', { className: 'tu-bottom__icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6.3 }),
        h('path', { d: 'M1.7 8h12.6M8 1.7c1.8 1.8 2.7 3.9 2.7 6.3S9.8 12.5 8 14.3C6.2 12.5 5.3 10.4 5.3 8S6.2 3.5 8 1.7z' }))
      if (summary === null && !open) return null
      // 单行展示: 悬停 title 给全部地址与时长, 点击打开内嵌管理弹窗。
      const title = summary === null ? '' : liveTunnels(rows).map((row) => {
        const vm = statusBarRowVM(row, now, location)
        return row.name + '  ' + vm.url + (vm.openText === '' ? '' : '  ' + vm.openText)
      }).join('\n')
      return h('div', { className: 'tu-bottom' },
        summary === null ? null : h('button', { type: 'button', className: 'tu-bottom__open', title: title === '' ? undefined : title, 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(true) },
          icon,
          h('span', { className: 'tu-bottom__head' }, summary.headline),
          summary.detail === '' ? null : h('span', { className: 'tu-bottom__detail' + (summary.stale ? ' tu-bottom__detail--stale' : '') }, summary.detail),
          h('span', { className: 'tu-bottom__spacer' }),
          h('span', { className: 'tu-bottom__more' }, '详情', h('span', { 'aria-hidden': 'true' }, '›'))),
        open ? h(Modal, { title: SECTION_LABEL, wide: true, onClose: () => setOpen(false) },
          h('div', { className: 'tu-modal__body' }, h(TunnelSettingsApp, { bus, embedded: true }))) : null)
    }

    function TunnelSettingsApp({ bus, embedded = false }) {
      const data = useTunnelData(bus)
      const [dialog, setDialog] = useState(null)
      const [portsVersion, setPortsVersion] = useState(0)
      const [actionError, setActionError] = useState('')
      const now = Date.now()
      const afterChange = () => {
        setActionError('')
        setPortsVersion((value) => value + 1)
        data.reload()
      }
      const update = async (row, patch) => {
        const outcome = await request('PATCH', '/tunnels/' + encodeURIComponent(row.name), patch)
        if (outcome.ok) afterChange()
        else setActionError(outcome.error)
      }
      const remove = async (row) => {
        const outcome = await request('DELETE', '/tunnels/' + encodeURIComponent(row.name))
        if (outcome.ok) afterChange()
        else setActionError(outcome.error)
      }
      return h('section', { className: 'tu-set' + (embedded ? ' tu-set--embedded' : '') },
        h(SetHead, { onAdd: () => setDialog({ mode: 'create' }), embedded }),
        h(TunnelCard, {
          rows: data.rows,
          now,
          lanOrigin: data.lanOrigin,
          error: data.error || actionError,
          probing: data.probing,
          reload: data.reload,
          onAdd: () => setDialog({ mode: 'create' }),
          onEdit: (row) => setDialog({ mode: 'edit', row }),
          onToggle: (row) => update(row, { enabled: row.enabled === false }),
          onRemove: remove,
        }),
        h(PortsCard, { onOpen: (item) => setDialog({ mode: 'create', portItem: item }), refreshKey: portsVersion }),
        dialog === null ? null : h(TunnelDialog, {
          mode: dialog.mode,
          row: dialog.row,
          portItem: dialog.portItem,
          onClose: () => setDialog(null),
          onSaved: () => { setDialog(null); afterChange() },
        }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const bus = tools.setupCommonTools(ctx)
        ensureStyle(document)
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: SECTION_LABEL },
          () => h(TunnelSettingsApp, { bus }),
        ))
        // 全局底部条: 有启用隧道才渲染, 空态不占高度; 旧宿主无此槽则不注册(干净禁用)
        ctx.slots.inject('shell.bottom', () => ctx.slots.register(
          { name: 'shell.bottom' },
          () => h(TunnelStatusBar, { bus }),
        ))
      },
    }
  }
}
})()
