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
const REFRESH_INTERVAL_MS = 30 * 1000
const PREF_POLL_MS = 5 * 1000
const COPY_FLASH_MS = 1200
const PORT_MIN = 1
const PORT_MAX = 65535
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const ENTRY_PATH = 'path'
const ENTRY_SUBDOMAIN = 'subdomain'
const ENTRY_LABELS = { path: '路径', subdomain: '子域名' }
const EMPTY_ROW = { name: '', targetPort: '', entry: ENTRY_PATH, wsText: '' }

// access 规范形态:子域名按当前 Host 派生 <name>.<当前域>, 泛解析域名场景自动成立
function accessUrlOf(row) {
  const host = window.location.host
  const target = row.entry === ENTRY_SUBDOMAIN
    ? row.name + '.' + host
    : host + '/p/' + row.name
  return window.location.protocol + '//' + target + '/'
}

function formatCreatedAt(iso) {
  if (typeof iso !== 'string' || iso === '') return '-'
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString()
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
/* LOGIC-END */

/* SBUILD-BEGIN */
const STYLE = `
/* 组件令牌层(形制对齐 dsh-im / cron-board):宿主 dsw-alias 定义在 body 作用域, tu- 令牌必须在 body 声明才能解析到主题值;
   fallback 取浅色中性, 深色主题由令牌接管, fallback 只兜裸宿主 */
body{
--tu-bg:var(--dsw-alias-bg-layer-1,#ffffff);
--tu-bg-sub:var(--dsw-alias-bg-layer-2,#f7f8fa);
--tu-bg-muted:var(--dsw-alias-bg-module-platform,#f2f3f5);
--tu-border:var(--dsw-alias-border-l2,#e5e6eb);
--tu-border-strong:var(--dsw-alias-border-l3,#dfe1e5);
--tu-text:var(--dsw-alias-label-primary,#1f2329);
--tu-text-sub:var(--dsw-alias-label-secondary,#646a73);
--tu-text-dim:var(--dsw-alias-label-tertiary,#8f959e);
--tu-accent:#1677ff;
--tu-accent-deep:#0958d9;
--tu-accent-wash:#eaf3ff;
--tu-danger:var(--dsw-alias-state-error-primary,#d54941);
--tu-ok:var(--dsw-alias-state-success-primary,#20a162);
--tu-hover:var(--dsw-alias-interactive-bg-hover,#f7f8fa);
--tu-mask:var(--dsw-alias-bg-mask-1,rgba(31,35,41,.5));
--tu-shadow:0 1px 2px rgb(31 35 41 / 4%);
--tu-radius-sm:6px;--tu-radius-md:8px;--tu-radius-lg:14px;
--tu-space-2:6px;--tu-space-3:8px;--tu-space-4:10px;--tu-space-5:12px;--tu-space-6:18px;
--tu-font-sm:12px;--tu-font-md:13px;--tu-font-lg:15px;
--tu-control-h:30px;
}
.tu-panel{display:flex;flex-direction:column;gap:var(--tu-space-5);min-width:0;max-width:880px;margin:0 auto;width:100%;color:var(--tu-text);container-type:inline-size}
.tu-main{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:var(--tu-space-6);background:var(--dsw-alias-bg-base,var(--tu-bg))}
.tu-toolbar{display:flex;align-items:center;gap:var(--tu-space-3);flex-wrap:wrap}
.tu-spacer{flex:1}
.tu-button{min-height:var(--tu-control-h);display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--tu-border-strong);border-radius:var(--tu-radius-md);padding:0 13px;font:inherit;font-size:var(--tu-font-md);font-weight:560;background:var(--tu-bg);color:var(--tu-text);cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.tu-button:hover:not(:disabled){border-color:#aeb3bb;background:var(--tu-hover)}
.tu-button:disabled{cursor:not-allowed;opacity:.55}
.tu-button--primary{background:var(--tu-accent);border-color:var(--tu-accent);color:#fff}
.tu-button--primary:hover:not(:disabled){background:var(--tu-accent-deep);border-color:var(--tu-accent-deep)}
.tu-button--danger{color:var(--tu-danger)}
.tu-button--danger:hover:not(:disabled){border-color:var(--tu-danger);background:var(--tu-danger);color:#fff}
.tu-button--sm{min-height:28px;padding:0 10px;font-size:var(--tu-font-sm)}
.tu-button:focus-visible,.tu-icon:focus-visible{outline:2px solid color-mix(in srgb, var(--tu-accent) 70%, white);outline-offset:2px}
.tu-meta{font-size:var(--tu-font-sm);color:var(--tu-text-sub)}
.tu-rows{display:flex;flex-direction:column;gap:var(--tu-space-1);font-size:var(--tu-font-md)}
.tu-row{display:flex;align-items:center;gap:var(--tu-space-3);border:1px solid var(--tu-border);border-radius:var(--tu-radius-md);padding:var(--tu-space-2) var(--tu-space-4);flex-wrap:wrap;transition:background .15s,border-color .15s}
.tu-row:hover{background:var(--tu-hover)}
.tu-name{font-size:14px;font-weight:600;color:var(--tu-text)}
.tu-badge{min-height:22px;display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;color:var(--tu-text-sub);background:var(--tu-bg-muted);font-size:var(--tu-font-sm);white-space:nowrap}
.tu-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--tu-font-sm);color:var(--tu-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tu-link{border:none;background:transparent;padding:0;font:inherit;cursor:pointer;color:var(--tu-accent);text-decoration:underline;text-underline-offset:3px}
.tu-link:hover{color:var(--tu-accent-deep)}
.tu-actions{display:flex;align-items:center;gap:var(--tu-space-2);margin-left:auto}
.tu-icon{min-height:28px;border:none;background:transparent;color:var(--tu-text-sub);cursor:pointer;font-size:var(--tu-font-sm);padding:0 8px;border-radius:var(--tu-radius-sm);transition:background .15s,color .15s}
.tu-icon:hover{background:var(--tu-hover);color:var(--tu-text)}
.tu-empty{font-size:var(--tu-font-md);color:var(--tu-text-dim);padding:var(--tu-space-6) 0;text-align:center}
.tu-error{font-size:var(--tu-font-sm);color:var(--tu-danger);background:var(--tu-bg-sub);border-left:3px solid var(--tu-danger);border-radius:var(--tu-radius-sm);padding:var(--tu-space-2) var(--tu-space-3)}
.tu-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;gap:var(--tu-space-2)}
.tu-switch input[type="checkbox"] { position:absolute;opacity:0;width:1px;height:1px }
.tu-switch__track{width:30px;height:17px;border-radius:999px;background:#aeb3bb;position:relative;transition:background .15s;flex:none}
.tu-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.tu-switch input[type="checkbox"]:checked + .tu-switch__track{background:var(--tu-accent)}
.tu-switch input[type="checkbox"]:checked + .tu-switch__track .tu-switch__thumb{left:15px}
.tu-switch input[type="checkbox"]:focus-visible + .tu-switch__track{outline:2px solid color-mix(in srgb, var(--tu-accent) 70%, white);outline-offset:1px}
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
.tu-modal{background:var(--tu-bg);color:var(--tu-text);border-radius:var(--tu-radius-lg);padding:var(--tu-space-6);max-width:520px;width:min(520px,94vw);max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 40px rgb(31 35 41 / 18%);animation:tu-pop-in .2s ease-out}
@keyframes tu-fade-in{from{opacity:0}to{opacity:1}}
@keyframes tu-pop-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.tu-modal-mask,.tu-modal{animation:none}.tu-row,.tu-button,.tu-icon,.tu-switch__track,.tu-pc,.tu-pc__chevron{transition:none}}
.tu-modal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--tu-space-3);padding-bottom:var(--tu-space-2);border-bottom:1px solid var(--tu-border)}
.tu-modal-title{font-size:16px;font-weight:600}
.tu-modal-body{display:flex;flex-direction:column;gap:var(--tu-space-4)}
.tu-seg{display:inline-flex;gap:2px;background:var(--tu-bg-muted);border-radius:8px;padding:2px;width:fit-content}
.tu-seg__opt{border:none;background:transparent;border-radius:6px;padding:5px 11px;font:inherit;font-size:var(--tu-font-sm);font-weight:520;color:var(--tu-text-sub);cursor:pointer;line-height:1.2;white-space:nowrap;transition:background .15s,color .15s}
.tu-seg__opt:hover{color:var(--tu-text)}
.tu-seg__opt--on{background:var(--tu-accent);color:#fff;font-weight:560}
.tu-seg__opt--on:hover{color:#fff}
.tu-seg__opt:focus-visible{outline:2px solid color-mix(in srgb, var(--tu-accent) 70%, white);outline-offset:1px}
.tu-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--tu-space-3) var(--tu-space-4)}
.tu-field{display:flex;flex-direction:column;gap:4px;font-size:var(--tu-font-sm);min-width:0;color:var(--tu-text-sub)}
.tu-field--wide{grid-column:1 / -1}
.tu-field input[type="text"],.tu-field input[type="number"],.tu-field textarea{min-height:30px;border:1px solid var(--tu-border-strong);border-radius:var(--tu-radius-md);padding:4px 10px;font:inherit;font-size:var(--tu-font-md);background:var(--tu-bg);color:var(--tu-text);min-width:0;transition:border-color .15s,box-shadow .15s}
.tu-field input:focus,.tu-field textarea:focus{outline:none;border-color:var(--tu-accent);box-shadow:0 0 0 3px var(--tu-accent-wash)}
.tu-field textarea{min-height:52px;resize:vertical;font-family:inherit}
.tu-hint{font-size:var(--tu-font-sm);color:var(--tu-text-dim)}
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
    let ReactDOMClient = null
    try {
      React = require('react')
      ReactDOMClient = require('react-dom/client')
    } catch {
      return noopFactory()
    }
    const { useState, useEffect, useRef, useCallback } = React
    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children)

    // 数据请求:统一 envelope, error 透传中文业务文案
    async function request(method, endpoint, body) {
      let response
      try {
        response = await fetch(API_PREFIX + endpoint, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
      let json = null
      try { json = await response.json() } catch { json = null }
      if (!response.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + response.status + ')' }
      return { ok: true, data: json }
    }

    function ensureStyle(document) {
      const existing = document.getElementById('dsh-tunnel-style')
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
        h('div', { className: 'tu-modal' },
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
      const url = accessUrlOf(row)
      const copy = async () => {
        if (await copyText(url)) {
          setCopied(true)
          setTimeout(() => setCopied(false), COPY_FLASH_MS)
        }
      }
      return h('div', { className: 'tu-row' },
        h('span', { className: 'tu-name' }, row.name),
        h('span', { className: 'tu-badge' }, ENTRY_LABELS[row.entry] ?? row.entry),
        h('span', { className: 'tu-code' }, row.entry === ENTRY_SUBDOMAIN ? row.name + '.*' : '/p/' + row.name),
        h('button', { type: 'button', className: 'tu-link', title: '点击复制 ' + url, onClick: copy },
          copied ? '已复制' : '复制地址'),
        h('span', { className: 'tu-code' }, ':' + row.targetPort),
        row.wsPaths && row.wsPaths.length > 0 ? h('span', { className: 'tu-code' }, 'ws ' + row.wsPaths.join(' ')) : null,
        h('span', { className: 'tu-meta' }, formatCreatedAt(row.createdAt)),
        h('span', { className: 'tu-actions' },
          h('button', { type: 'button', className: 'tu-button tu-button--sm tu-button--danger',
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
        const wsPaths = draft.wsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
        const body = { name: draft.name.trim(), targetPort: Number(draft.targetPort), entry: draft.entry }
        if (draft.entry === ENTRY_PATH && wsPaths.length > 0) body.wsPaths = wsPaths
        const outcome = await request('POST', '/tunnels', body)
        setBusy(false)
        if (!outcome.ok) { setError(outcome.error); return }
        onAdded()
      }
      const nameOk = NAME_RE.test(draft.name.trim())
      const portValue = Number(draft.targetPort)
      const portOk = Number.isInteger(portValue) && portValue >= PORT_MIN && portValue <= PORT_MAX
      return h(Modal, { title: '添加隧道', onClose },
        h('div', { className: 'tu-grid' },
          h('div', { className: 'tu-field' },
            h('span', null, '隧道名'),
            h('input', { type: 'text', value: draft.name, placeholder: '小写字母/数字/连字符, ≤32 位',
              onChange: (event) => patch({ name: event.target.value }) }),
            h('span', { className: 'tu-hint' }, '避开 dsh 入口域名首标签(如 dsh); 纯 IP 访问时避开 IP 首段数字(如 127)')),
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
              : '子路径部署, 目标应用需支持 base 参数(vite --base / jupyter base_url 等)')),
          draft.entry === ENTRY_PATH ? h('div', { className: 'tu-field tu-field--wide' },
            h('span', null, 'WebSocket 路径(可选, 每行一条)'),
            h('textarea', { value: draft.wsText, placeholder: '/\n/ws',
              onChange: (event) => patch({ wsText: event.target.value }) }),
            h('span', { className: 'tu-hint' }, '留空 = 纯 HTTP; 子域名模式不需要')) : null),
        error ? h('div', { className: 'tu-error' }, error) : null,
        h('div', { className: 'tu-actions' },
          h('button', { type: 'button', className: 'tu-button', onClick: onClose }, '取消'),
          h('button', { type: 'button', className: 'tu-button tu-button--primary',
            disabled: busy || !nameOk || !portOk, onClick: submit }, '创建')))
    }

    function TunnelPanel() {
      const [rows, setRows] = useState(null)
      const [error, setError] = useState('')
      const [showAdd, setShowAdd] = useState(false)
      const [busyName, setBusyName] = useState('')
      const [reloadFlag, setReloadFlag] = useState(0)
      const reload = useCallback(() => setReloadFlag((flag) => flag + 1), [])
      useEffect(() => {
        let alive = true
        const load = async () => {
          const listOutcome = await request('GET', '/tunnels')
          if (!alive) return
          // 成功即清错误: 瞬态失败(如插件重载期轮询)恢复后错误条不滞留
          if (listOutcome.ok) { setRows(listOutcome.data.items); setError('') }
          else setError(listOutcome.error)
        }
        load()
        const timer = setInterval(load, REFRESH_INTERVAL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [reloadFlag])
      const remove = async (row) => {
        if (!window.confirm('删除隧道 ' + row.name + '?')) return
        setBusyName(row.name)
        const outcome = await request('DELETE', '/tunnels/' + encodeURIComponent(row.name))
        setBusyName('')
        if (!outcome.ok) setError(outcome.error)
        else reload()
      }
      return h('div', { className: 'tu-panel' },
        h('div', { className: 'tu-toolbar' },
          h('span', { className: 'tu-meta' }, rows ? '共 ' + rows.length + ' 条隧道' : '加载中…'),
          h('span', { className: 'tu-spacer' }),
          h('button', { type: 'button', className: 'tu-button tu-button--primary', onClick: () => setShowAdd(true) }, '添加隧道')),
        error ? h('div', { className: 'tu-error' }, error) : null,
        rows && rows.length === 0 ? h('div', { className: 'tu-empty' }, '暂无隧道, 点击右上角「添加隧道」创建') : null,
        rows ? h('div', { className: 'tu-rows' },
          rows.map((row) => h(TunnelRow, { key: row.name, row, busy: busyName === row.name, onRemove: remove }))) : null,
        showAdd ? h(AddTunnelModal, { onClose: () => setShowAdd(false), onAdded: () => { setShowAdd(false); reload() } }) : null)
    }

    // —— 挂载:全局面板(main keyed + sidebar.panellist)与 better-sidebar tab 形态仲裁 ——
    // 侧栏行与中央面板均由宿主渲染, 禁 DOM 刮取;仲裁仅由偏好驱动(设计 §3.2)

    const CARD_TITLE = '穿透隧道'
    const CARD_DESC = '手动管理穿透隧道: 路径/子域名双入口, 列表与增删'
    const CARD_TOGGLE_LABEL = '看板移入 better-sidebar 侧边栏'
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

    function registerMainPanel(ctx) {
      return ctx.effect(() => {
        const injectDisposers = []
        injectDisposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => h('div', { className: 'tu-main' }, h(TunnelPanel)))))
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
    function registerBoardTab(ctx, service) {
      return ctx.effect(() => {
        return service.registerTab({
          id: TAB_ID,
          title: PANEL_LABEL,
          icon: (size) => h(PanelIcon, { size }),
          order: TAB_ORDER,
          single: true,
          component: (props) => h('div', { className: 'tu-main' }, h(TunnelPanel)),
        })
      }, 'dsh-tunnel sidebar tab')
    }

    // 设置>插件页卡片:官方 PluginCard 形制;better-sidebar 在场可切换, 否则仅展示禁用态
    function TunnelPluginCard({ ctx }) {
      const [enabled, setEnabled] = useState(null)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      // 渲染时重探服务在场:better-sidebar 晚于设置页装载时, 重渲染自动纠正禁用态
      const sidebarReady = ctx.get('betterSidebar') !== undefined
      useEffect(() => {
        let alive = true
        request('GET', '/status').then((outcome) => {
          if (alive) setEnabled(outcome.ok && outcome.data && outcome.data.ui ? outcome.data.ui.sidebarTab === true : false)
        })
        return () => { alive = false }
      }, [])
      const toggle = async () => {
        if (busy || enabled === null || !sidebarReady) return
        setBusy(true)
        const outcome = await request('POST', '/ui-settings', { sidebarTab: !enabled })
        if (outcome.ok && outcome.data && outcome.data.ui) setEnabled(outcome.data.ui.sidebarTab === true)
        else console.warn('[dsh-tunnel] 偏好写入失败: ' + ((outcome.data && outcome.data.error) || outcome.error || '未知'))
        setBusy(false)
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
              h('span', { className: 'tu-pc__rowLabel' }, CARD_TOGGLE_LABEL),
              switchToggle({
                checked: enabled === true,
                disabled: busy || enabled === null || !sidebarReady,
                onChange: toggle,
                ariaLabel: CARD_TOGGLE_LABEL,
              })),
            h('p', { className: 'tu-pc__hint' },
              sidebarReady ? '开启后看板以侧边栏页签呈现,关闭时使用全局面板。' : '需已装载 better-sidebar 后方可切换;未装载时看板始终使用全局面板。'))) : null)
    }

    return {
      // slots 供面板与设置卡片挂载(缺失则 fiber 未激活, 即干净禁用)
      inject: ['slots'],
      apply(ctx) {
        ensureStyle(document)
        // 挂载权交给用户:默认注册全局面板;偏好开启且侧边栏服务在场才移入扩展槽
        let currentSidebar = ctx.get('betterSidebar')
        let sidebarTabOn = false
        let tabDisposer = null
        let panelDisposer = null
        const attachBoardTab = (sidebar) => registerBoardTab(ctx, sidebar)
        const applyPref = () => {
          const wantTab = sidebarTabOn && currentSidebar !== undefined
          if (wantTab && tabDisposer === null) {
            if (panelDisposer) { panelDisposer(); panelDisposer = null }
            tabDisposer = attachBoardTab(currentSidebar)
          } else if (!wantTab && tabDisposer !== null) {
            tabDisposer()
            tabDisposer = null
          }
          if (!wantTab && panelDisposer === null) panelDisposer = registerMainPanel(ctx)
        }
        const prefWatch = setInterval(async () => {
          try {
            const outcome = await request('GET', '/status')
            const next = outcome.ok && outcome.data && outcome.data.ui ? outcome.data.ui.sidebarTab === true : false
            if (next !== sidebarTabOn) {
              const previous = sidebarTabOn
              sidebarTabOn = next
              try {
                applyPref()
              } catch (error) {
                // 形态切换失败回滚偏好, 下轮轮询重试, 避免入口消失后卡死
                sidebarTabOn = previous
                console.warn('[dsh-tunnel] 看板形态切换失败:', error)
              }
            }
          } catch { /* 轮询失败保形态不变, 下轮重试 */ }
        }, PREF_POLL_MS)
        ctx.effect(() => () => {
          clearInterval(prefWatch)
          if (tabDisposer) tabDisposer()
          if (panelDisposer) panelDisposer()
        }, 'dsh-tunnel mount arbitration')
        // 设置>插件页卡片:key 配对 ns, 宿主按 describe 命名空间分发;effect 随 fiber 回收
        ctx.effect(() => ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', key: PANEL_ID, label: PANEL_LABEL },
            () => h(TunnelPluginCard, { ctx }),
          )
        }), 'dsh-tunnel settings card')
        ctx.inject(['betterSidebar'], (bsCtx) => {
          currentSidebar = bsCtx.betterSidebar
          applyPref()
        })
        applyPref()
      },
    }
  }
}
})()
