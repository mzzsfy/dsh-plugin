(() => {
// 隧道看板 client 半区:隧道列表/添加/删除 + 设置页插件卡片(侧边栏注入开关)。
// 无构建:createElement + 一次性样式注入;IIFE 书挡,顶层零词法声明(经典 script 全局词法环境跨 bundle 共享)。
// 开关一律 tu-switch(规约 switch 形态);全局面板与 better-sidebar tab 形态仲裁与 cron-board 同构。

/* LOGIC-BEGIN */
const API_PREFIX = '/api/tunnel'
const PANEL_ID = 'tunnel'
const PANEL_LABEL = '穿透隧道'
const TAB_ID = 'tunnel:board'
const TAB_ORDER = 47
const COPY_FLASH_MS = 1200
const REQUEST_TIMEOUT_MS = 15 * 1000
const PORT_MIN = 1
const PORT_MAX = 65535
const PATH_PREFIX = '/p/'
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAME_HAS_LETTER_RE = /[a-z]/
const ENTRY_PATH = 'path'
const ENTRY_SUBDOMAIN = 'subdomain'
const MODE_PANEL = 'panel'
const MODE_TAB = 'tab'
const ENTRY_LABELS = { path: '路径', subdomain: '子域名' }
const EMPTY_ROW = { name: '', targetPort: '', entry: ENTRY_PATH }
const LOCAL_HOST_RE = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])$/i

// 访问地址派生: 路径模式走同源前缀; 子域名模式在 IP/localhost 入口下只能退回
// <name>.localhost(仅本机可解析, 浏览器/系统普遍支持 *.localhost 回环)
function accessUrlOf(row, location) {
  if (row.entry !== ENTRY_SUBDOMAIN) return location.origin + PATH_PREFIX + row.name + '/'
  const port = location.port === '' ? '' : ':' + location.port
  const base = LOCAL_HOST_RE.test(location.hostname) ? 'localhost' : location.hostname
  return location.protocol + '//' + row.name + '.' + base + port + '/'
}

// 子域名入口在纯 IP 访问下只对本机生效, 需要显式提示
function accessLocalOnly(row, location) {
  return row.entry === ENTRY_SUBDOMAIN && LOCAL_HOST_RE.test(location.hostname)
}

function formatCreatedAt(iso) {
  if (typeof iso !== 'string' || iso === '') return '-'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '-'
  const pad = (value) => String(value).padStart(2, '0')
  return pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()) + ' ' + pad(parsed.getHours()) + ':' + pad(parsed.getMinutes())
}

function formatCreatedAtFull(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString()
}

// 剪贴板降级: 非安全上下文(内网 http)无 navigator.clipboard, 退回 execCommand
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

// 可见性门控: 页面/容器不可见期间的刷新请求只记脏, 恢复可见补拉一次
// (后台 tab 不再随每次 publish 打请求; readVisible 由调用方注入, 纯逻辑可测)
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
    // 可见性恢复时补拉; 无脏标记或仍不可见即不动, 幂等
    flush() {
      if (!pending || !readVisible()) return false
      pending = false
      run()
      return true
    },
    get pending() { return pending },
  }
}

function isPageVisible(document) {
  return document?.visibilityState !== 'hidden'
}
/* LOGIC-END */

/* SBUILD-BEGIN */
const STYLE = `
/* 组件令牌层(形制对齐 dsh-im / cron-board):宿主 dsw-alias 定义在 body 作用域, tu- 令牌必须在 body 声明才能解析到主题值;
   直接引用宿主语义别名, 禁止字面 fallback(暗色主题漏色, 规范见 DEVELOPMENT/plugin-ui-design.md) */
body{
--tu-bg:var(--dsw-alias-bg-layer-1);
--tu-bg-sub:var(--dsw-alias-bg-layer-2);
--tu-bg-muted:var(--dsw-alias-bg-module-platform);
--tu-card:var(--dsw-alias-bg-layer-1);
--tu-card-border:var(--dsw-alias-border-l2);
--tu-border:var(--dsw-alias-border-l2);
--tu-border-strong:var(--dsw-alias-border-l3);
--tu-text:var(--dsw-alias-label-primary);
--tu-text-sub:var(--dsw-alias-label-secondary);
--tu-text-dim:var(--dsw-alias-label-tertiary);
--tu-accent:var(--dsw-alias-brand-primary);
--tu-accent-deep:var(--dsw-alias-button-primary-hover);
--tu-accent-wash:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
--tu-danger:var(--dsw-alias-state-error-primary);
--tu-warn:var(--dsw-alias-state-warn-primary);
--tu-hover:var(--dsw-alias-interactive-bg-hover);
--tu-hover-danger:var(--dsw-alias-interactive-bg-hover-danger);
--tu-mask:var(--dsw-alias-bg-mask-1);
--tu-radius-sm:var(--dsw-radius-sm);--tu-radius-md:var(--dsw-radius-md);--tu-radius-lg:var(--dsw-radius-lg);
--tu-space-1:4px;--tu-space-2:6px;--tu-space-3:8px;--tu-space-4:12px;--tu-space-5:16px;--tu-space-6:24px;
--tu-font-sm:12px;--tu-font-md:13px;--tu-font-base:14px;--tu-font-title:16px;--tu-font-page:20px;
--tu-control-h:32px;
}
.tu-panel{display:flex;flex-direction:column;gap:var(--tu-space-5);min-width:0;max-width:1080px;margin:0 auto;width:100%;color:var(--tu-text);font-size:var(--tu-font-md);line-height:20px;container-type:inline-size}
.tu-main{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:var(--tu-space-6);background:var(--tu-bg)}
.tu-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.tu-page-title{font-size:var(--tu-font-page);font-weight:500;line-height:28px;margin:0}
.tu-page-desc{margin:4px 0 0;font-size:var(--tu-font-md);line-height:20px;color:var(--tu-text-sub)}
.tu-page-actions{display:flex;align-items:center;gap:8px}
.tu-toolbar{display:flex;align-items:center;gap:var(--tu-space-3);flex-wrap:wrap;min-height:32px;padding-bottom:12px;border-bottom:.5px solid var(--tu-border)}
.tu-spacer{flex:1}
.tu-button{min-height:var(--tu-control-h);display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--tu-border-strong);border-radius:var(--tu-radius-sm);padding:0 14px;font:inherit;font-size:var(--tu-font-md);font-weight:500;background:transparent;color:var(--tu-text);cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.tu-button:hover:not(:disabled){border-color:var(--tu-border-strong);background:var(--tu-hover)}
.tu-button:disabled{cursor:not-allowed;opacity:.5}
.tu-button--primary{background:var(--tu-accent);border-color:var(--tu-accent);color:var(--dsw-alias-bg-base)}
.tu-button--primary:hover:not(:disabled){background:var(--tu-accent-deep);border-color:var(--tu-accent-deep)}
.tu-button--danger{color:var(--tu-danger);border-color:transparent}
.tu-button--danger:hover:not(:disabled){border-color:transparent;background:var(--tu-hover-danger);color:var(--tu-danger)}
.tu-button--sm{min-height:28px;padding:0 10px;font-size:var(--tu-font-sm);white-space:nowrap}
.tu-button--ghost{border-color:transparent;color:var(--tu-text-sub)}
.tu-button--ghost:hover:not(:disabled){color:var(--tu-text);background:var(--tu-hover)}
.tu-button:focus-visible,.tu-icon:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.tu-meta{font-size:var(--tu-font-sm);color:var(--tu-text-sub)}
.tu-rows{display:flex;flex-direction:column;border:.5px solid var(--tu-border);border-radius:var(--tu-radius-md);overflow-x:auto;overflow-y:hidden;background:var(--tu-bg)}
.tu-rows-head{display:grid;grid-template-columns:minmax(140px,1.2fr) minmax(160px,1.6fr) 64px 120px 188px;gap:12px;align-items:center;padding:10px 16px;border-bottom:.5px solid var(--tu-border);font-size:var(--tu-font-sm);color:var(--tu-text-dim);background:var(--tu-bg-sub);min-width:720px}
.tu-row{display:grid;grid-template-columns:minmax(140px,1.2fr) minmax(160px,1.6fr) 64px 120px 188px;gap:12px;align-items:center;padding:10px 16px;border-bottom:.5px solid var(--tu-border);transition:background .15s;min-width:720px}
.tu-row:last-child{border-bottom:none}
.tu-row:hover{background:var(--tu-hover)}
.tu-row__main{display:flex;align-items:center;gap:8px;min-width:0}
.tu-name{font-size:var(--tu-font-base);font-weight:500;color:var(--tu-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tu-badge{min-height:20px;display:inline-flex;align-items:center;padding:0 8px;border-radius:999px;color:var(--tu-text-sub);background:var(--tu-bg-muted);font-size:11px;white-space:nowrap;flex:none}
.tu-badge--warn{color:var(--tu-warn);background:color-mix(in srgb,var(--tu-warn) 10%,transparent)}
.tu-code{font-family:var(--ds-font-family-code);font-size:var(--tu-font-sm);color:var(--tu-text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tu-link{border:none;background:transparent;padding:0;font:inherit;cursor:pointer;color:var(--tu-accent);text-decoration:underline;text-underline-offset:3px}
.tu-link:hover{color:var(--tu-accent-deep)}
.tu-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-left:auto;opacity:.8}
.tu-row:hover .tu-actions,.tu-row:focus-within .tu-actions{opacity:1}
.tu-icon{min-height:28px;border:none;background:transparent;color:var(--tu-text-sub);cursor:pointer;font-size:var(--tu-font-sm);padding:0 8px;border-radius:var(--tu-radius-sm);transition:background .15s,color .15s}
.tu-icon:hover{background:var(--tu-hover);color:var(--tu-text)}
.tu-empty{display:flex;flex-direction:column;align-items:center;gap:12px;font-size:var(--tu-font-base);color:var(--tu-text-sub);padding:48px 0;text-align:center}
.tu-error{font-size:var(--tu-font-sm);color:var(--tu-text);background:var(--tu-bg-sub);border:1px solid color-mix(in srgb,var(--tu-danger) 40%,transparent);border-left:3px solid var(--tu-danger);border-radius:var(--tu-radius-sm);padding:8px 12px}
.tu-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;gap:var(--tu-space-2)}
.tu-switch input[type="checkbox"] { position:absolute;opacity:0;width:1px;height:1px }
.tu-switch__track{width:34px;height:19px;border-radius:999px;background:var(--tu-bg-muted);position:relative;transition:background .15s;flex:none}
.tu-switch__thumb{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent)}
.tu-switch input[type="checkbox"]:checked + .tu-switch__track{background:var(--tu-accent)}
.tu-switch input[type="checkbox"]:checked + .tu-switch__track .tu-switch__thumb{left:18px}
.tu-switch input[type="checkbox"]:focus-visible + .tu-switch__track{outline:2px solid color-mix(in srgb, var(--tu-accent) 70%, var(--dsw-alias-bg-base));outline-offset:1px}
.tu-switch input[type="checkbox"]:disabled + .tu-switch__track{opacity:.4;cursor:not-allowed}
.tu-switch:not(:has(input[type="checkbox"]:disabled)):hover .tu-switch__track{background:var(--tu-accent-deep);opacity:.85}
.tu-switch input[type="checkbox"]:checked:not(:disabled) + .tu-switch__track:hover{background:var(--tu-accent-deep)}
/* 设置>插件页卡片(tu-pc):镜像官方 PluginCard 形制, 数值与令牌直取官方 CSS Module;
   官方壳未导出, slot 契约声明卡片外观归插件自持, 同页同 dsw-alias 令牌即同观感(含深色主题) */
.tu-pc{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.tu-pc:hover{border-color:var(--dsw-alias-label-dimmed)}
.tu-pc--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.tu-pc__head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.tu-pc__head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.tu-pc__text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.tu-pc__name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.tu-pc__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.tu-pc__chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;transition:transform .16s}
.tu-pc--open .tu-pc__chevron{transform:rotate(180deg)}
.tu-pc__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.tu-pc__row{gap:6px;padding:12px 0;display:grid}
.tu-pc__rowLine{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}
.tu-pc__rowLabel{flex:1;min-width:0}
.tu-pc__hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.tu-modal-mask{position:fixed;inset:0;background:var(--tu-mask);display:flex;align-items:center;justify-content:center;z-index:60;animation:tu-fade-in .16s ease-out}
.tu-modal{background:var(--tu-bg);color:var(--tu-text);border-radius:var(--tu-radius-lg);padding:var(--tu-space-6);max-width:520px;width:min(520px,94vw);max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:14px;box-shadow:var(--dsw-shadow-lv3);animation:tu-pop-in .2s ease-out}
@keyframes tu-fade-in{from{opacity:0}to{opacity:1}}
@keyframes tu-pop-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.tu-modal-mask,.tu-modal{animation:none}.tu-row,.tu-button,.tu-icon,.tu-switch__track,.tu-pc,.tu-pc__chevron{transition:none}}
.tu-modal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--tu-space-3);padding-bottom:var(--tu-space-3);border-bottom:.5px solid var(--tu-border)}
.tu-modal-title{font-size:16px;font-weight:600;line-height:24px}
.tu-modal-body{display:flex;flex-direction:column;gap:var(--tu-space-4)}
.tu-seg{display:inline-flex;gap:2px;background:var(--tu-bg-muted);border-radius:var(--tu-radius-sm);padding:2px;width:fit-content}
.tu-seg__opt{border:none;background:transparent;border-radius:calc(var(--tu-radius-sm) - 2px);padding:0 12px;height:28px;font:inherit;font-size:var(--tu-font-md);font-weight:500;color:var(--tu-text-sub);cursor:pointer;line-height:20px;white-space:nowrap;transition:background .15s,color .15s}
.tu-seg__opt:hover{color:var(--tu-text)}
.tu-seg__opt--on{background:var(--tu-accent);color:var(--dsw-alias-bg-base);font-weight:600}
.tu-seg__opt--on:hover{color:var(--dsw-alias-bg-base)}
.tu-seg__opt:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tu-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--tu-space-4)}
.tu-field{display:flex;flex-direction:column;gap:6px;font-size:var(--tu-font-sm);min-width:0;color:var(--tu-text-sub)}
.tu-field--wide{grid-column:1 / -1}
.tu-field input[type="text"],.tu-field input[type="number"]{min-height:36px;border:1px solid var(--tu-border-strong);border-radius:var(--tu-radius-sm);padding:0 10px;font:inherit;font-size:var(--tu-font-base);background:var(--tu-bg);color:var(--tu-text);min-width:0;transition:border-color .15s,box-shadow .15s}
.tu-field input:focus{outline:none;border-color:var(--tu-accent);box-shadow:0 0 0 2px var(--tu-accent-wash)}
.tu-hint{font-size:var(--tu-font-sm);line-height:18px;color:var(--tu-text-dim)}
@media (max-width: 560px){
.tu-grid{grid-template-columns:1fr}
.tu-modal{max-height:92vh}
.tu-main{padding:var(--tu-space-4)}
}
`
/* SBUILD-END */

// 空模块兜底:react 缺席即整面板禁用(宿主必有 react, 防御性)
function noopFactory() {
  return { inject: [], apply() {} }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-tunnel', factory })

  // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;插件未就绪时入队, 由其启动时排空
  const NAV_ICON = { 'dsh-tunnel': 'globe' }
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
    const { useState, useEffect, useRef, useCallback } = React
    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children)

    // 数据请求:统一 envelope, error 透传中文业务文案
    async function request(method, endpoint, body) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let response
      try {
        response = await fetch(API_PREFIX + endpoint, {
          method,
          signal: controller.signal,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, error: controller.signal.aborted ? '请求超时' : String(error && error.message || error) }
      } finally {
        clearTimeout(timer)
      }
      let json = null
      try { json = await response.json() } catch { json = null }
      if (!response.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + response.status + ')' }
      return { ok: true, data: json }
    }

    function ensureStyle(document) {
      const existing = document.querySelector('style[data-plugin="@mzzsfy/dsh-tunnel"]')
      if (existing) return
      const style = document.createElement('style')
      style.id = 'dsh-tunnel-style'
      // 官方契约:插件自注样式必须自带 data-plugin, 否则任意后续插件材质化时
      // claimStyles 会把它归属给该插件, 其 HMR 重建即整批误删本插件样式
      style.setAttribute('data-plugin', '@mzzsfy/dsh-tunnel')
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    // 规约 switch:input 锚定状态选择器, 视觉由 track+thumb 呈现
    function switchToggle(props) {
      return h('label', { className: 'tu-switch' },
        h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange,
          'aria-label': props.ariaLabel }),
        h('span', { className: 'tu-switch__track' }, h('span', { className: 'tu-switch__thumb' })),
        props.label ? h('span', { className: 'tu-meta' }, props.label) : null)
    }

    function Modal({ title, onClose, children }) {
      const bodyRef = useRef(null)
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        const first = bodyRef.current && bodyRef.current.querySelector('input, textarea')
        if (first) first.focus()
        return () => document.removeEventListener('keydown', onKey)
      }, [])
      return h('div', { className: 'tu-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'tu-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'tu-modal-head' },
            h('span', { className: 'tu-modal-title' }, title),
            h('button', { className: 'tu-icon', 'aria-label': '关闭', onClick: onClose }, '✕')),
          h('div', { className: 'tu-modal-body', ref: bodyRef }, children)))
    }

    function PillGroup({ options, value, onChange }) {
      return h('div', { className: 'tu-seg' },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          className: 'tu-seg__opt' + (option.value === value ? ' tu-seg__opt--on' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    // —— 隧道列表面板 ——
    function TunnelRow({ row, onRemove, busy }) {
      const [copied, setCopied] = useState(false)
      const url = accessUrlOf(row, window.location)
      const localOnly = accessLocalOnly(row, window.location)
      const copy = async () => {
        if (await copyText(url, document)) {
          setCopied(true)
          setTimeout(() => setCopied(false), COPY_FLASH_MS)
        }
      }
      return h('div', { className: 'tu-row' },
        h('span', { className: 'tu-row__main' },
          h('span', { className: 'tu-name' }, row.name),
          h('span', { className: 'tu-badge' }, ENTRY_LABELS[row.entry] ?? row.entry),
          row.active === false ? h('span', { className: 'tu-badge tu-badge--warn', title: row.error ?? '' }, '未激活') : null,
          localOnly ? h('span', { className: 'tu-badge tu-badge--warn', title: '子域名入口在 IP 访问下仅本机可解析' }, '仅本机') : null,
        ),
        h('span', { className: 'tu-code', title: url }, row.entry === ENTRY_SUBDOMAIN ? row.name + '.*' : PATH_PREFIX + row.name),
        h('span', { className: 'tu-code' }, ':' + row.targetPort),
        h('span', { className: 'tu-meta', title: formatCreatedAtFull(row.createdAt) }, formatCreatedAt(row.createdAt)),
        h('span', { className: 'tu-actions' },
          h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--ghost', title: '点击复制 ' + url, 'aria-label': '复制 ' + row.name + ' 的访问地址', onClick: copy },
            copied ? '已复制' : '复制地址'),
          h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--danger', 'aria-label': '删除隧道 ' + row.name,
            disabled: busy, onClick: () => onRemove(row) }, '删除')))
    }

    function AddTunnelModal({ onClose, onAdded }) {
      const [draft, setDraft] = useState(EMPTY_ROW)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const patch = (part) => setDraft((prev) => ({ ...prev, ...part }))
      const submit = async () => {
        setBusy(true)
        setError('')
        const body = { name: draft.name.trim(), targetPort: Number(draft.targetPort), entry: draft.entry }
        const outcome = await request('POST', '/tunnels', body)
        setBusy(false)
        if (!outcome.ok) { setError(outcome.error); return }
        onAdded()
      }
      const trimmedName = draft.name.trim()
      const nameOk = NAME_RE.test(trimmedName) && NAME_HAS_LETTER_RE.test(trimmedName)
      const portValue = Number(draft.targetPort)
      const portOk = Number.isInteger(portValue) && portValue >= PORT_MIN && portValue <= PORT_MAX
      return h(Modal, { title: '添加隧道', onClose },
        h('div', { className: 'tu-grid' },
          h('div', { className: 'tu-field' },
            h('span', null, '隧道名'),
            h('input', { type: 'text', value: draft.name, placeholder: '小写字母/数字/连字符, ≤32 位',
              onChange: (event) => patch({ name: event.target.value }) }),
            h('span', { className: 'tu-hint' }, '至少含一个字母(纯数字会与纯 IP 访问的首段冲突); 并避开 dsh 入口域名首标签(如 dsh)')),
          h('div', { className: 'tu-field' },
            h('span', null, '目标端口'),
            h('input', { type: 'number', value: draft.targetPort, placeholder: PORT_MIN + '..' + PORT_MAX,
              onChange: (event) => patch({ targetPort: event.target.value }) }),
            h('span', { className: 'tu-hint' }, '本机应用监听端口')),
          h('div', { className: 'tu-field tu-field--wide' },
            h('span', null, '入口形态'),
            h(PillGroup, {
              options: [{ label: ENTRY_LABELS.path + ' (/p/<名>)', value: ENTRY_PATH },
                { label: ENTRY_LABELS.subdomain + ' (<名>.*)', value: ENTRY_SUBDOMAIN }],
              value: draft.entry,
              onChange: (entry) => patch({ entry }),
            }),
            h('span', { className: 'tu-hint' }, draft.entry === ENTRY_SUBDOMAIN
              ? '全路径透传, WebSocket 任意路径可用, 需泛解析域名或 <名>.localhost 访问'
              : '子路径部署, 目标应用需支持 base 参数(vite --base / jupyter base_url 等); WebSocket 同样可用。与 dsh 同源, cookie 敏感的应用优先用子域名'))),
        error ? h('div', { className: 'tu-error' }, error) : null,
        h('div', { className: 'tu-actions' },
          h('button', { type: 'button', className: 'tu-button', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'tu-button tu-button--primary',
            disabled: busy || !nameOk || !portOk, onClick: submit }, '创建')))
    }

    function TunnelPanel({ bus }) {
      const [rows, setRows] = useState(null)
      const [error, setError] = useState('')
      const [showAdd, setShowAdd] = useState(false)
      const [busyName, setBusyName] = useState('')
      const rootRef = useRef(null)
      const nodeVisibleRef = useRef(true)
      const aliveRef = useRef(true)
      const gateRef = useRef(null)
      const load = useCallback(async () => {
        const listOutcome = await request('GET', '/tunnels')
        if (!aliveRef.current) return
        // 成功即清错误: 瞬态失败(如插件重载期刷新)恢复后错误条不滞留
        if (listOutcome.ok) { setRows(listOutcome.data.items); setError('') }
        else setError(listOutcome.error)
      }, [])
      const reload = useCallback(() => gateRef.current?.request(), [])
      useEffect(() => {
        aliveRef.current = true
        const snapshot = tools.createSnapshotRefresh(load)
        // 闸门认 snapshot.refresh 为执行体: 突发事件仍由公共工具合并
        const gate = createRefreshGate(() => isPageVisible(document) && nodeVisibleRef.current, snapshot.refresh)
        gateRef.current = gate
        const unsubscribe = bus.subscribe(() => gate.request(), { onReset: () => gate.request() })
        const onVisibility = () => { if (isPageVisible(document)) gate.flush() }
        document.addEventListener('visibilitychange', onVisibility)
        // 首拉不依赖总线: 总线未就绪/无事件时看板也必须能出数据; 后续增量走推送
        gate.request()
        return () => {
          aliveRef.current = false
          gateRef.current = null
          snapshot.dispose()
          unsubscribe()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [bus, load])
      // 容器级可见性: 非激活 tab 常以 0 尺寸/隐藏容器挂着, 只靠页面级会永远判可见
      useEffect(() => {
        const node = rootRef.current
        if (!node || typeof IntersectionObserver === 'undefined') return
        const observer = new IntersectionObserver((entries) => {
          nodeVisibleRef.current = entries.some((entry) => entry.isIntersecting)
          if (nodeVisibleRef.current) gateRef.current?.flush()
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])
      const remove = async (row) => {
        if (!window.confirm('删除隧道 ' + row.name + '?')) return
        setBusyName(row.name)
        const outcome = await request('DELETE', '/tunnels/' + encodeURIComponent(row.name))
        setBusyName('')
        if (!outcome.ok) setError(outcome.error)
        else reload()
      }
      return h('div', { className: 'tu-panel', ref: rootRef },
        h('header', { className: 'tu-page-head' },
          h('div', null,
            h('h1', { className: 'tu-page-title' }, '穿透隧道'),
            h('p', { className: 'tu-page-desc' }, '把本机端口映射为路径或子域名入口,供浏览器与外部服务访问。'),
          ),
          h('div', { className: 'tu-page-actions' },
            h('button', { type: 'button', className: 'tu-button tu-button--primary', onClick: () => setShowAdd(true) }, '添加隧道')),
        ),
        h('div', { className: 'tu-toolbar' },
          h('span', { className: 'tu-meta' }, rows ? '共 ' + rows.length + ' 条隧道' : '加载中…'),
        ),
        error ? h('div', { className: 'tu-error' }, error) : null,
        rows && rows.length === 0 ? h('div', { className: 'tu-empty' },
          h('span', null, '还没有隧道。创建一个,把本机服务暴露给浏览器。'),
          h('button', { type: 'button', className: 'tu-button tu-button--primary', onClick: () => setShowAdd(true) }, '添加隧道')) : null,
        rows && rows.length > 0 ? h('div', { className: 'tu-rows' },
          h('div', { className: 'tu-rows-head' },
            h('span', null, '名称'),
            h('span', null, '入口'),
            h('span', null, '端口'),
            h('span', null, '创建时间'),
            h('span', { style: { textAlign: 'right' } }, '操作')),
          rows.map((row) => h(TunnelRow, { key: row.name, row, busy: busyName === row.name, onRemove: remove }))) : null,
        showAdd ? h(AddTunnelModal, { onClose: () => setShowAdd(false), onAdded: () => { setShowAdd(false); reload() } }) : null)
    }

    // —— 挂载:全局面板(main keyed + sidebar.panellist)与 better-sidebar tab 形态仲裁 ——
    // 侧栏行与中央面板均由宿主渲染, 禁 DOM 刮取;仲裁仅由偏好驱动(设计 §3.2)

    const CARD_TITLE = '穿透隧道'
    const CARD_DESC = '手动管理穿透隧道: 路径/子域名双入口, 列表与增删, ai 使用开关'
    const CARD_TOGGLE_LABEL = '看板移入 better-sidebar 侧边栏'
    const CARD_AI_LABEL = '允许 ai 使用隧道工具'
    const CARD_AI_HINT = '关闭后 ai 无法调用 tunnel_open/tunnel_list/tunnel_close, 看板与 REST 管理不受影响。'
    const CHEVRON_DOWN = () => h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'm3.5 5.5 3.5 3.5 3.5-3.5' }))

    // 面板图标:panellist 渲染契约组件与侧边栏 tab 图标共用, 宿主传 { size, active }
    function PanelIcon({ size }) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 7, cy: 7, r: 4.5 }),
        h('path', { d: 'm10.5 10.5 3 3' }))
    }

    function registerMainPanel(ctx, bus) {
      return ctx.effect(() => {
        const injectDisposers = []
        injectDisposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => h('div', { className: 'tu-main' }, h(TunnelPanel, { bus })))))
        injectDisposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          label: PANEL_LABEL,
        }, (iconProps) => h(PanelIcon, iconProps))))
        return () => { for (const dispose of injectDisposers) dispose() }
      }, 'dsh-tunnel main panel')
    }

    // better-sidebar tab:注册即单实例(single);只注册不主动打开,
    // 打开由用户从侧边栏目录手动进入
    function registerBoardTab(ctx, service, bus) {
      return ctx.effect(() => {
        return service.registerTab({
          id: TAB_ID,
          title: PANEL_LABEL,
          icon: (size) => h(PanelIcon, { size }),
          order: TAB_ORDER,
          single: true,
          component: (props) => h('div', { className: 'tu-main' }, h(TunnelPanel, { bus })),
        })
      }, 'dsh-tunnel sidebar tab')
    }

    // 设置>插件页卡片:官方 PluginCard 形制;better-sidebar 在场可切换, 否则仅展示禁用态
    function TunnelPluginCard({ ctx }) {
      const [sidebarOn, setSidebarOn] = useState(null)
      const [aiOn, setAiOn] = useState(null)
      const [busyKey, setBusyKey] = useState('')
      const [open, setOpen] = useState(false)
      // 渲染时重探服务在场:better-sidebar 晚于设置页装载时, 重渲染自动纠正禁用态
      const sidebarReady = ctx.get('betterSidebar') !== undefined
      useEffect(() => {
        let alive = true
        request('GET', '/status').then((outcome) => {
          if (!alive || !outcome.ok || !outcome.data || !outcome.data.ui) return
          setSidebarOn(outcome.data.ui.sidebarTab === true)
          setAiOn(outcome.data.ui.aiTools !== false)
        })
        return () => { alive = false }
      }, [])
      const flip = async (key, current) => {
        if (busyKey !== '' || current === null) return
        if (key === 'sidebarTab' && !sidebarReady) return
        setBusyKey(key)
        const outcome = await request('POST', '/ui-settings', { [key]: !current })
        if (outcome.ok && outcome.data && outcome.data.ui) {
          setSidebarOn(outcome.data.ui.sidebarTab === true)
          setAiOn(outcome.data.ui.aiTools !== false)
        } else {
          console.warn('[dsh-tunnel] 偏好写入失败: ' + ((outcome.data && outcome.data.error) || outcome.error || '未知'))
        }
        setBusyKey('')
      }
      return h('li', { className: 'tu-pc' + (open ? ' tu-pc--open' : '') },
        h('button', { type: 'button', className: 'tu-pc__head', 'aria-expanded': open,
          'aria-label': (open ? '折叠' : '展开') + ': ' + CARD_TITLE, onClick: () => setOpen(!open) },
          h('span', { className: 'tu-pc__text' },
            h('span', { className: 'tu-pc__name' }, CARD_TITLE),
            h('span', { className: 'tu-pc__desc' }, CARD_DESC)),
          h('span', { className: 'tu-pc__chevron' }, h(CHEVRON_DOWN))),
        open ? h('div', { className: 'tu-pc__body' },
          h('div', { className: 'tu-pc__row' },
            h('div', { className: 'tu-pc__rowLine' },
              h('span', { className: 'tu-pc__rowLabel' }, CARD_AI_LABEL),
              switchToggle({
                checked: aiOn === true,
                disabled: busyKey !== '' || aiOn === null,
                onChange: () => flip('aiTools', aiOn),
                ariaLabel: CARD_AI_LABEL,
              })),
            h('p', { className: 'tu-pc__hint' }, CARD_AI_HINT)),
          h('div', { className: 'tu-pc__row' },
            h('div', { className: 'tu-pc__rowLine' },
              h('span', { className: 'tu-pc__rowLabel' }, CARD_TOGGLE_LABEL),
              switchToggle({
                checked: sidebarOn === true,
                disabled: busyKey !== '' || sidebarOn === null || !sidebarReady,
                onChange: () => flip('sidebarTab', sidebarOn),
                ariaLabel: CARD_TOGGLE_LABEL,
              })),
            h('p', { className: 'tu-pc__hint' },
              sidebarReady ? '开启后看板以侧边栏页签呈现,关闭时使用全局面板。' : '需已装载 better-sidebar 后方可切换;未装载时看板始终使用全局面板。'))) : null)
    }

    return {
      // slots 供面板与设置卡片挂载(缺失则 fiber 未激活, 即干净禁用)
      inject: ['slots'],
      apply(ctx) {
        const bus = tools.setupCommonTools(ctx)
        ensureStyle(document)
        // 挂载权交给用户:默认注册全局面板;偏好开启且侧边栏服务在场才移入扩展槽。
        // 形态仲裁收敛成状态机: currentMode 是唯一事实, reconcile 是唯一变更入口
        let currentSidebar = ctx.get('betterSidebar')
        let sidebarTabOn = false
        let currentMode = null
        let tabDisposer = null
        let panelDisposer = null
        const desiredMode = () => (sidebarTabOn && currentSidebar !== undefined ? MODE_TAB : MODE_PANEL)
        // 先装新后卸旧: 装载失败时旧形态仍在, 不出现双无窗口; 成功才切换事实并回收旧形态。
        // 代价是同一 tick 内两种形态短暂并存, 宿主按渲染批次取快照, 用户侧不可见
        const reconcile = () => {
          const target = desiredMode()
          if (target === currentMode) return
          if (target === MODE_TAB) {
            const disposeTab = registerBoardTab(ctx, currentSidebar, bus)
            const previousPanel = panelDisposer
            tabDisposer = disposeTab
            panelDisposer = null
            currentMode = MODE_TAB
            if (previousPanel) previousPanel()
            return
          }
          const disposePanel = registerMainPanel(ctx, bus)
          const previousTab = tabDisposer
          panelDisposer = disposePanel
          tabDisposer = null
          currentMode = MODE_PANEL
          if (previousTab) previousTab()
        }
        // 偏好仲裁数据源:订阅总线刷新(ui-settings 变更即 publish),不再周期轮询
        let prefAlive = true
        const syncPref = async () => {
          // 无侧边栏服务时形态恒为全局面板, 偏好读取无意义: 省掉每次 publish 的 /status
          if (currentSidebar === undefined) return
          try {
            const outcome = await request('GET', '/status')
            if (!prefAlive) return
            const next = outcome.ok && outcome.data && outcome.data.ui ? outcome.data.ui.sidebarTab === true : false
            if (next !== sidebarTabOn) {
              const previous = sidebarTabOn
              sidebarTabOn = next
              try {
                reconcile()
              } catch (error) {
                // 形态切换失败回滚偏好, 下轮事件重试, 避免入口消失后卡死
                sidebarTabOn = previous
                console.warn('[dsh-tunnel] 看板形态切换失败:', error)
              }
            }
          } catch { /* 刷新失败保形态不变, 下轮事件重试 */ }
        }
        const prefRefresh = tools.createSnapshotRefresh(syncPref)
        const unsubscribePref = bus.subscribe(prefRefresh.refresh, { onReset: prefRefresh.refresh })
        ctx.effect(() => () => {
          prefAlive = false
          prefRefresh.dispose()
          unsubscribePref()
          currentMode = null
          if (tabDisposer) tabDisposer()
          if (panelDisposer) panelDisposer()
          tabDisposer = null
          panelDisposer = null
        }, 'dsh-tunnel mount arbitration')
        // 设置>插件页卡片:key 配对 ns, 宿主按 describe 命名空间分发;effect 随 fiber 回收。
        // 0.1.7-rc.1+ 该槽被宿主移除, 卡片换形注册进插件管理页包详情配置槽(plugins.bundle.config,
        // key = 包名);两代槽位并存注册:inject 是声明生命周期效应, 错误世代宿主永不声明该槽,
        // 回调挂起不执行, 零成本
        ctx.effect(() => ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', key: PANEL_ID, label: PANEL_LABEL },
            () => h(TunnelPluginCard, { ctx }),
          )
        }), 'dsh-tunnel settings card')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', function* () {
          yield ctx.slots.register(
            { name: 'plugins.bundle.config', key: '@mzzsfy/dsh-tunnel' },
            () => h(TunnelPluginCard, { ctx }),
          )
        }), 'dsh-tunnel plugin manager card')
        ctx.inject(['betterSidebar'], (bsCtx) => {
          currentSidebar = bsCtx.betterSidebar
          syncPref()
          reconcile()
        })
        reconcile()
      },
    }
  }
}
})()
