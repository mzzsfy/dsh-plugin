(() => {
// 定时任务看板 client 半区:设置页三 Tab(看板/环境变量/日志)+ 任务与变量的完整 CRUD。
// 无构建:createElement + 一次性样式注入;IIFE 书挡,顶层零词法声明(经典 script 全局词法环境跨 bundle 共享)。
// 开关一律 cb-switch(规约 switch 形态);状态色语义以 STATUS_META 单一来源,与 core status-meta.mjs 镜像(parity 锁定)。

/* LOGIC-BEGIN */
const STATUS_META = {
  success: { label: '成功', tone: 'ok' },
  fail: { label: '失败', tone: 'bad' },
  timeout: { label: '超时', tone: 'warn' },
  skipped: { label: '跳过', tone: 'mute' },
  interrupted: { label: '中断', tone: 'mute' },
  running: { label: '运行中', tone: 'run' },
}
const TRIGGER_META = { cron: { label: '定时' }, manual: { label: '手动' } }
const KIND_LABELS = { shell: '脚本', session: '会话' }
const MODE_LABELS = { fresh: '每次新建', pinned: '固定会话' }
const ONMISS_LABELS = { skip: '跳过', defer: '顺延' }
const STATUS_TONE_COLOR = { ok: '#22a06b', bad: '#e5484d', warn: '#f5a524', mute: '#8b8d98', run: '#3b82f6' }
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const PAD2 = (value) => String(value).padStart(2, '0')

// 相对时间人话:未来「x 后」过去「x 前」
function relativeTime(timestamp, now) {
  if (typeof timestamp !== 'number' || !(timestamp > 0)) return '-'
  const delta = timestamp - now
  const abs = Math.abs(delta)
  const suffix = delta >= 0 ? '后' : '前'
  if (abs < MINUTE_MS) return Math.max(1, Math.round(abs / SECOND_MS)) + ' 秒' + suffix
  if (abs < HOUR_MS) return Math.round(abs / MINUTE_MS) + ' 分钟' + suffix
  if (abs < DAY_MS) return Math.round(abs / HOUR_MS) + ' 小时' + suffix
  return Math.round(abs / DAY_MS) + ' 天' + suffix
}

function formatDateTime(timestamp) {
  if (typeof timestamp !== 'number' || !(timestamp > 0)) return '-'
  const date = new Date(timestamp)
  return date.getFullYear() + '-' + PAD2(date.getMonth() + 1) + '-' + PAD2(date.getDate()) + ' ' + PAD2(date.getHours()) + ':' + PAD2(date.getMinutes())
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !(ms >= 0)) return '-'
  if (ms < SECOND_MS) return ms + 'ms'
  if (ms < MINUTE_MS) return (ms / SECOND_MS).toFixed(1) + 's'
  return Math.round(ms / MINUTE_MS) + 'min'
}

function statusMeta(status) {
  return STATUS_META[status] || { label: status || '-', tone: 'mute' }
}
/* LOGIC-END */

const API_PREFIX = '/api/cron-board/'
const REFRESH_INTERVAL_MS = 30 * SECOND_MS
const TABS = [
  { value: 'jobs', label: '看板' },
  { value: 'envs', label: '环境变量' },
  { value: 'logs', label: '日志' },
]
const CRON_PRESETS = [
  { label: '每天 08:30', value: '30 8 * * *' },
  { label: '每天 22:00', value: '0 22 * * *' },
  { label: '每 30 分钟', value: '*/30 * * * *' },
  { label: '每 2 小时', value: '0 */2 * * *' },
  { label: '工作日 09:00', value: '0 9 * * 1-5' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
  { label: '每月 1 日 00:00', value: '0 0 1 * *' },
]

const STYLE = `
/* 组件令牌层(形制对齐 dsh-im):宿主 dsw-alias 定义在 body 作用域,cb- 令牌必须在 body 声明才能解析到主题值;
   fallback 取浅色中性(dsh-im 同款),深色主题由令牌接管,fallback 只兜裸宿主 */
body{
--cb-bg:var(--dsw-alias-bg-layer-1,#ffffff);
--cb-bg-sub:var(--dsw-alias-bg-layer-2,#f7f8fa);
--cb-bg-muted:var(--dsw-alias-bg-module-platform,#f2f3f5);
--cb-border:var(--dsw-alias-border-l2,#e5e6eb);
--cb-border-strong:var(--dsw-alias-border-l3,#dfe1e5);
--cb-text:var(--dsw-alias-label-primary,#1f2329);
--cb-text-sub:var(--dsw-alias-label-secondary,#646a73);
--cb-text-dim:var(--dsw-alias-label-tertiary,#8f959e);
--cb-accent:#1677ff;
--cb-accent-deep:#0958d9;
--cb-accent-wash:#eaf3ff;
--cb-danger:var(--dsw-alias-state-error-primary,#d54941);
--cb-ok:var(--dsw-alias-state-success-primary,#20a162);
--cb-warn:var(--dsw-alias-state-warn-primary,#d97706);
--cb-hover:var(--dsw-alias-interactive-bg-hover,#f7f8fa);
--cb-mask:var(--dsw-alias-bg-mask-1,rgba(31,35,41,.5));
--cb-shadow:0 1px 2px rgb(31 35 41 / 4%);
--cb-radius-sm:6px;--cb-radius-md:8px;--cb-radius-lg:14px;
--cb-space-1:4px;--cb-space-2:6px;--cb-space-3:8px;--cb-space-4:12px;--cb-space-5:16px;--cb-space-6:24px;
--cb-font-xs:12px;--cb-font-sm:12px;--cb-font-md:13px;--cb-font-lg:15px;
--cb-control-h:34px;
}
.cb-panel{display:flex;flex-direction:column;gap:var(--cb-space-5);min-width:0;max-width:880px;color:var(--cb-text);container-type:inline-size}
.cb-toolbar{display:flex;align-items:center;gap:var(--cb-space-3);flex-wrap:wrap}
.cb-tabs{display:flex;gap:var(--cb-space-1);background:var(--cb-bg-muted);border-radius:999px;padding:3px}
.cb-pill{border:none;border-radius:999px;padding:5px 14px;font-size:var(--cb-font-md);background:transparent;color:var(--cb-text-sub);cursor:pointer;font-weight:560;transition:color .15s,background .15s}
.cb-pill:hover{color:var(--cb-text)}
.cb-pill--on{background:var(--cb-bg);color:var(--cb-text);box-shadow:var(--cb-shadow)}
.cb-pill--on:hover{color:var(--cb-text)}
.cb-spacer{flex:1}
.cb-button{min-height:var(--cb-control-h);display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:0 13px;font:inherit;font-size:var(--cb-font-md);font-weight:560;background:var(--cb-bg);color:var(--cb-text);cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.cb-button:hover:not(:disabled){border-color:#aeb3bb;background:var(--cb-hover)}
.cb-button:disabled{cursor:not-allowed;opacity:.55}
.cb-button--primary{background:var(--cb-accent);border-color:var(--cb-accent);color:#fff}
.cb-button--primary:hover:not(:disabled){background:var(--cb-accent-deep);border-color:var(--cb-accent-deep)}
.cb-button--danger{color:var(--cb-danger)}
.cb-button--danger:hover:not(:disabled){border-color:var(--cb-danger);background:var(--cb-danger);color:#fff}
.cb-button--sm{min-height:28px;padding:0 10px;font-size:var(--cb-font-sm)}
.cb-button:focus-visible,.cb-icon:focus-visible,.cb-pill:focus-visible,.cb-select:focus-visible,.cb-entry:focus-visible{outline:2px solid color-mix(in srgb, var(--cb-accent) 70%, white);outline-offset:2px}
.cb-button:active:not(:disabled){transform:translateY(1px)}
.cb-cards{display:flex;flex-direction:column;gap:var(--cb-space-3)}
.cb-card{position:relative;display:flex;flex-direction:column;gap:var(--cb-space-2);border:1px solid var(--cb-border);border-radius:var(--cb-radius-lg);padding:var(--cb-space-4) var(--cb-space-5);cursor:pointer;overflow:hidden;background:var(--cb-bg);box-shadow:var(--cb-shadow);transition:border-color .15s,box-shadow .15s}
.cb-card:hover{border-color:var(--cb-accent);box-shadow:0 2px 8px rgb(31 35 41 / 8%)}
.cb-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3.5px;background:var(--cb-status,#aeb3bb)}
.cb-card-row{display:flex;align-items:center;gap:var(--cb-space-3);flex-wrap:wrap}
.cb-name{font-size:14px;font-weight:600;color:var(--cb-text)}
.cb-badge{min-height:22px;display:inline-flex;align-items:center;padding:0 9px;border-radius:999px;color:var(--cb-text-sub);background:var(--cb-bg-muted);font-size:var(--cb-font-sm);white-space:nowrap}
.cb-dot{width:8px;height:8px;border-radius:50%;background:var(--cb-status,#aeb3bb);flex:none}
.cb-meta{font-size:var(--cb-font-sm);color:var(--cb-text-sub)}
.cb-actions{display:flex;align-items:center;gap:var(--cb-space-2);margin-left:auto}
.cb-icon{min-height:28px;border:none;background:transparent;color:var(--cb-text-sub);cursor:pointer;font-size:var(--cb-font-sm);padding:0 8px;border-radius:var(--cb-radius-sm);transition:background .15s,color .15s}
.cb-icon:hover{background:var(--cb-hover);color:var(--cb-text)}
.cb-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;gap:var(--cb-space-2)}
.cb-switch input[type="checkbox"] { position:absolute;opacity:0;width:1px;height:1px }
.cb-switch__track{width:30px;height:17px;border-radius:999px;background:#aeb3bb;position:relative;transition:background .15s;flex:none}
.cb-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track{background:var(--cb-accent)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track .cb-switch__thumb{left:15px}
.cb-switch input[type="checkbox"]:focus-visible + .cb-switch__track{outline:2px solid color-mix(in srgb, var(--cb-accent) 70%, white);outline-offset:1px}
.cb-switch input[type="checkbox"]:disabled + .cb-switch__track{opacity:.4;cursor:not-allowed}
.cb-switch:not(:has(input[type="checkbox"]:disabled)):hover .cb-switch__track{background:var(--cb-accent-deep);opacity:.85}
.cb-switch input[type="checkbox"]:checked:not(:disabled) + .cb-switch__track:hover{background:var(--cb-accent-deep)}
.cb-settings{display:flex;flex-direction:column;gap:var(--cb-space-2);padding:var(--cb-space-2) 0}
.cb-settings__hint{font-size:var(--cb-font-sm);color:var(--cb-text-dim)}
.cb-table{display:flex;flex-direction:column;gap:var(--cb-space-1);font-size:var(--cb-font-md)}
.cb-row{display:flex;align-items:center;gap:var(--cb-space-3);border:1px solid var(--cb-border);border-radius:var(--cb-radius-md);padding:var(--cb-space-2) var(--cb-space-4);flex-wrap:wrap;transition:background .15s,border-color .15s}
.cb-row:hover{background:var(--cb-hover)}
.cb-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);color:var(--cb-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.cb-mask{color:var(--cb-text-sub)}
.cb-modal-mask{position:fixed;inset:0;background:var(--cb-mask);display:flex;align-items:center;justify-content:center;z-index:60;animation:cb-fade-in .16s ease-out}
.cb-modal{background:var(--cb-bg);color:var(--cb-text);border:1px solid var(--cb-border);border-radius:var(--cb-radius-lg);padding:var(--cb-space-6);max-width:720px;width:min(720px,92vw);max-height:84vh;overflow:auto;display:flex;flex-direction:column;gap:var(--cb-space-4);box-shadow:0 12px 40px rgb(31 35 41 / 18%);animation:cb-pop-in .2s ease-out}
@keyframes cb-fade-in{from{opacity:0}to{opacity:1}}
@keyframes cb-pop-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.cb-modal-mask,.cb-modal{animation:none}.cb-card,.cb-row,.cb-button,.cb-pill,.cb-icon,.cb-switch__track{transition:none}}
.cb-modal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--cb-space-3);padding-bottom:var(--cb-space-3);border-bottom:1px solid var(--cb-border)}
.cb-modal-title{font-size:16px;font-weight:600}
.cb-modal-body{display:flex;flex-direction:column;gap:var(--cb-space-5)}
.cb-section{display:flex;flex-direction:column;gap:var(--cb-space-3)}
.cb-section-title{font-size:var(--cb-font-sm);font-weight:600;color:var(--cb-text);display:flex;align-items:center;gap:var(--cb-space-2)}
.cb-section-title::before{content:'';width:3px;height:12px;border-radius:2px;background:var(--cb-accent)}
.cb-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--cb-space-4) var(--cb-space-5)}
.cb-field{display:flex;flex-direction:column;gap:var(--cb-space-2);font-size:var(--cb-font-sm);min-width:0;color:var(--cb-text-sub)}
.cb-field--wide{grid-column:1 / -1}
.cb-field input[type="text"],.cb-field input[type="number"],.cb-field textarea,.cb-field select{min-height:var(--cb-control-h);border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:5px 10px;font:inherit;font-size:var(--cb-font-md);background:var(--cb-bg);color:var(--cb-text);min-width:0;transition:border-color .15s,box-shadow .15s}
.cb-field input:focus,.cb-field textarea:focus,.cb-field select:focus{outline:none;border-color:var(--cb-accent);box-shadow:0 0 0 3px var(--cb-accent-wash)}
.cb-field textarea{min-height:72px;resize:vertical;font-family:inherit}
.cb-hint{font-size:var(--cb-font-xs);color:var(--cb-text-dim)}
.cb-error{font-size:var(--cb-font-sm);color:var(--cb-danger);background:var(--cb-bg-sub);border-left:3px solid var(--cb-danger);border-radius:var(--cb-radius-sm);padding:var(--cb-space-2) var(--cb-space-3)}
.cb-preview{font-size:var(--cb-font-sm);border:1px dashed var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:var(--cb-space-2) var(--cb-space-3);color:var(--cb-text-sub);background:var(--cb-accent-wash);border-color:color-mix(in srgb, var(--cb-accent) 35%, transparent);color:var(--cb-text)}
.cb-log{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);white-space:pre-wrap;word-break:break-all;background:var(--cb-bg-sub);border-radius:var(--cb-radius-md);padding:var(--cb-space-3);max-height:320px;overflow:auto}
.cb-empty{font-size:var(--cb-font-md);color:var(--cb-text-dim);padding:var(--cb-space-6) 0;text-align:center;display:flex;flex-direction:column;align-items:center;gap:var(--cb-space-3)}
.cb-select{min-height:var(--cb-control-h);border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:4px 8px;font:inherit;font-size:var(--cb-font-md);background:var(--cb-bg);color:var(--cb-text)}
.cb-confirm-text{font-size:var(--cb-font-md);color:var(--cb-text);line-height:1.5}
.cb-log::-webkit-scrollbar,.cb-modal::-webkit-scrollbar{width:8px;height:8px}
.cb-log::-webkit-scrollbar-thumb,.cb-modal::-webkit-scrollbar-thumb{background:var(--cb-border-strong);border-radius:999px}
.cb-log::-webkit-scrollbar-track,.cb-modal::-webkit-scrollbar-track{background:transparent}
/* 容器查询:better-sidebar tab 与主视图宽度差异大,跟随面板自身宽度而非视口 */
@container (max-width: 560px){
.cb-grid{grid-template-columns:1fr}
.cb-card-row .cb-actions{margin-left:0;width:100%;justify-content:flex-end;flex-wrap:wrap}
.cb-view{padding:var(--cb-space-4)}
.cb-panel{gap:var(--cb-space-4)}
}
.cb-entry{display:flex;align-items:center;gap:var(--cb-space-3);width:100%;border:none;background:transparent;color:inherit;cursor:pointer;padding:var(--cb-space-2) var(--cb-space-4);border-radius:var(--cb-radius-md);font-size:var(--cb-font-md);text-align:left}
.cb-entry:hover{background:var(--cb-hover)}
.cb-entry[data-active="true"]{background:var(--cb-accent);color:#fff}
.cb-entry-icon{display:inline-flex;flex:none}
.cb-view{display:none;flex:1;min-height:0;flex-direction:column;padding:var(--cb-space-6);overflow:auto;background:var(--dsw-alias-bg-base,var(--cb-bg))}
.cb-view > .cb-panel{margin:0 auto;width:100%}
html[data-cb-board-active] [data-cb-view]{display:flex}
html[data-cb-board-active] [data-pane="conversation"] > :not([data-cb-view]){display:none !important}
html[data-cb-board-active] [class*="centerCol"] > :not([data-cb-view]){display:none !important}
html[data-cb-board-active] .dshDesktopConversationSurface > :not([data-cb-view]){display:none !important}
`

// 空模块兜底:react 缺席即整面板禁用(宿主必有 react,防御性)
function noopFactory() {
  return { inject: [], apply() {} }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-cron-board', factory })

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

    // 数据请求:统一 envelope,error 透传中文业务文案
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
      const existing = document.getElementById('dsh-cron-board-style')
      if (existing) return
      const style = document.createElement('style')
      style.id = 'dsh-cron-board-style'
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    // 规约 switch:input 锚定状态选择器,视觉由 track+thumb 呈现
    function switchToggle(props) {
      return h('label', { className: 'cb-switch' },
        h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange }),
        h('span', { className: 'cb-switch__track' }, h('span', { className: 'cb-switch__thumb' })),
        props.label ? h('span', { className: 'cb-meta' }, props.label) : null)
    }

    function PillGroup({ options, value, onChange }) {
      return h('div', { className: 'cb-tabs' },
        options.map((option) => h('button', {
          key: option.value,
          className: 'cb-pill' + (option.value === value ? ' cb-pill--on' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    function Field({ label, hint, wide, children }) {
      return h('div', { className: 'cb-field' + (wide ? ' cb-field--wide' : '') },
        h('span', null, label),
        children,
        hint ? h('span', { className: 'cb-hint' }, hint) : null)
    }

    function Modal({ title, onClose, children, width }) {
      const bodyRef = useRef(null)
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        const first = bodyRef.current && bodyRef.current.querySelector('input, textarea, select')
        if (first) first.focus()
        return () => document.removeEventListener('keydown', onKey)
      }, [])
      return h('div', { className: 'cb-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'cb-modal', style: width ? { width: 'min(' + width + 'px, 92vw)' } : null },
          h('div', { className: 'cb-modal-head' },
            h('span', { className: 'cb-modal-title' }, title),
            h('button', { className: 'cb-icon', 'aria-label': '关闭', onClick: onClose }, '✕')),
          h('div', { className: 'cb-modal-body', ref: bodyRef }, children)))
    }

    // 节标题:表单分区渐进披露(基础/执行/调度)
    function Section({ title, children }) {
      return h('div', { className: 'cb-section' },
        h('div', { className: 'cb-section-title' }, title),
        children)
    }

    // —— 任务表单(新建/编辑)——
    function JobForm({ job, onDone, wsModel }) {
      // 工作区清单:订阅 model 快照(服务缺失或形态不符即空表,仅保留手输)
      const [wsItems, setWsItems] = useState(() => (wsModel ? wsModel.getSnapshot().items || [] : []))
      useEffect(() => {
        if (!wsModel) return undefined
        const update = () => setWsItems(wsModel.getSnapshot().items || [])
        update()
        return wsModel.subscribe(update)
      }, [wsModel])
      const editing = Boolean(job && job.id)
      const [form, setForm] = useState(() => ({
        name: job ? job.name : '',
        kind: job ? job.kind : 'shell',
        command: job ? job.command : '',
        prompt: job ? job.prompt : '',
        workdir: job ? job.workdir : '',
        schedule: job ? job.schedule : '0 9 * * *',
        timeoutMs: job ? job.timeoutMs : 60 * 60 * 1000,
        concurrency: job && job.concurrency ? String(job.concurrency) : '',
        enabled: job ? job.enabled : true,
        session: {
          mode: job && job.session ? job.session.mode : 'fresh',
          pinnedSessionId: job && job.session ? job.session.pinnedSessionId : '',
          windowStart: job && job.session ? job.session.windowStart : '',
          windowEnd: job && job.session ? job.session.windowEnd : '',
          onMiss: job && job.session ? job.session.onMiss : 'skip',
        },
      }))
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const setSession = (patch) => setForm((prev) => ({ ...prev, session: { ...prev.session, ...patch } }))

      useEffect(() => {
        let alive = true
        const timer = setTimeout(async () => {
          const outcome = await request('POST', 'cron/preview', { schedule: form.schedule })
          if (alive) setPreview(outcome.ok ? outcome.data : null)
        }, 300)
        return () => { alive = false; clearTimeout(timer) }
      }, [form.schedule])

      const submit = async () => {
        if (saving) return
        setSaving(true)
        setError(null)
        const payload = { ...form }
        payload.concurrency = form.concurrency === '' ? undefined : Number(form.concurrency)
        payload.session = form.kind === 'session' ? form.session : undefined
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'jobs/' + job.id : 'jobs', payload)
        setSaving(false)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }

      return h(Modal, { title: editing ? '编辑任务' : '新建任务', onClose: onDone, width: 720 },
        h(Section, { title: '基础信息' },
          h('div', { className: 'cb-grid' },
            h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
            h(Field, { label: '类型' }, h(PillGroup, {
              options: [{ value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
              value: form.kind,
              onChange: (kind) => set({ kind }),
            })))),
        h(Section, { title: form.kind === 'shell' ? '执行配置(shell)' : '执行配置(会话)' },
          h('div', { className: 'cb-grid' },
            form.kind === 'shell'
              ? h(Field, { label: '命令', wide: true, hint: '经由宿主 shell 执行,支持环境变量插值 $NAME' },
                  h('input', { type: 'text', value: form.command, onChange: (e) => set({ command: e.target.value }) }))
              : null,
            form.kind === 'shell'
              ? h(Field, { label: '工作目录(可空)' }, h('input', { type: 'text', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) }))
              : null,
            form.kind === 'session'
              ? h(Field, {
                  label: '工作区(会话 cwd,可空)',
                  hint: wsItems.length > 0 ? '从宿主工作区选择,或留空使用默认目录' : '留空使用宿主默认目录;填入路径则会话在该目录下创建',
                },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    wsItems.length > 0
                      ? h('select', {
                          className: 'cb-select',
                          value: wsItems.some((w) => w.path === form.workdir) ? form.workdir : '',
                          onChange: (e) => set({ workdir: e.target.value }),
                        },
                          h('option', { value: '' }, '默认目录'),
                          wsItems.map((w) => h('option', { key: w.path || w.workspaceId, value: w.path }, w.title || w.path)))
                      : null,
                    h('input', { type: 'text', placeholder: '/path/to/workspace', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) })))
              : null,
            form.kind === 'session'
              ? h(Field, { label: '任务文本', wide: true, hint: '投递给会话的任务内容,环境变量会折叠在文本前部' },
                  h('textarea', { value: form.prompt, onChange: (e) => set({ prompt: e.target.value }) }))
              : null,
            form.kind === 'session'
              ? h(Field, { label: '会话模式' }, h(PillGroup, {
                  options: [{ value: 'fresh', label: MODE_LABELS.fresh }, { value: 'pinned', label: MODE_LABELS.pinned }],
                  value: form.session.mode,
                  onChange: (mode) => setSession({ mode }),
                }))
              : null,
            form.kind === 'session' && form.session.mode === 'pinned'
              ? h(Field, { label: '固定会话 ID(可空,首跑自动绑定)' },
                  h('input', { type: 'text', value: form.session.pinnedSessionId, onChange: (e) => setSession({ pinnedSessionId: e.target.value }) }))
              : null,
            form.kind === 'session'
              ? h(Field, { label: '允许时段起(可空)' }, h('input', { type: 'text', placeholder: '09:00', value: form.session.windowStart, onChange: (e) => setSession({ windowStart: e.target.value }) }))
              : null,
            form.kind === 'session'
              ? h(Field, { label: '允许时段止(可空)' }, h('input', { type: 'text', placeholder: '23:00', value: form.session.windowEnd, onChange: (e) => setSession({ windowEnd: e.target.value }) }))
              : null,
            form.kind === 'session'
              ? h(Field, { label: '窗口外策略' }, h(PillGroup, {
                  options: [{ value: 'skip', label: ONMISS_LABELS.skip }, { value: 'defer', label: ONMISS_LABELS.defer }],
                  value: form.session.onMiss,
                  onChange: (onMiss) => setSession({ onMiss }),
                }))
              : null)),
        h(Section, { title: '调度计划' },
          h('div', { className: 'cb-grid' },
            h(Field, { label: 'cron 表达式(分 时 日 月 周)' },
              h('div', { style: { display: 'flex', gap: 6 } },
                h('input', { type: 'text', value: form.schedule, onChange: (e) => set({ schedule: e.target.value }) }),
                h('select', {
                  className: 'cb-select',
                  value: '',
                  onChange: (e) => { if (e.target.value) set({ schedule: e.target.value }) },
                },
                  h('option', { value: '' }, '预设'),
                  CRON_PRESETS.map((preset) => h('option', { key: preset.value, value: preset.value }, preset.label)))),
              preview ? h('span', { className: 'cb-preview' },
                preview.summary + ';接下来 ' + preview.nextAt.map((at) => formatDateTime(at)).join(' / ')) : null),
            h(Field, { label: '超时(毫秒)' }, h('input', { type: 'number', value: form.timeoutMs, onChange: (e) => set({ timeoutMs: Number(e.target.value) }) })),
            h(Field, { label: '并发上限(可空)' }, h('input', { type: 'number', value: form.concurrency, onChange: (e) => set({ concurrency: e.target.value }) })))),
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', disabled: saving, onClick: submit }, saving ? '保存中…' : '保存')))
    }

    function JobCard({ job, now, onToggle, onRun, onEdit, onDelete }) {
      const meta = statusMeta(job.lastStatus)
      const style = { '--cb-status': STATUS_TONE_COLOR[meta.tone] }
      return h('div', { className: 'cb-card', style, role: 'button', tabIndex: 0, onClick: onEdit },
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-dot' }),
          h('span', { className: 'cb-name' }, job.name),
          h('span', { className: 'cb-badge' }, KIND_LABELS[job.kind] || job.kind),
          job.kind === 'session' && job.session ? h('span', { className: 'cb-badge' }, MODE_LABELS[job.session.mode]) : null,
          job.kind === 'session' && job.session && job.session.windowStart
            ? h('span', { className: 'cb-badge' }, job.session.windowStart + '-' + job.session.windowEnd) : null,
          h('div', { className: 'cb-actions', onClick: (event) => event.stopPropagation() },
            switchToggle({ checked: Boolean(job.enabled), onChange: onToggle }),
            h('button', { className: 'cb-button cb-button--primary cb-button--sm', disabled: !job.enabled, title: job.enabled ? '立即运行' : '已停用', onClick: onRun }, '运行'),
            h('button', { className: 'cb-icon', title: '编辑', onClick: onEdit }, '编辑'),
            h('button', { className: 'cb-icon cb-button--danger', title: '删除', onClick: onDelete }, '删除'))),
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-meta' }, job.lastStatus ? meta.label : '未运行'),
          h('span', { className: 'cb-meta' }, job.summary || job.schedule),
          typeof job.nextRunAt === 'number' && job.enabled ? h('span', { className: 'cb-meta' }, '下次 ' + relativeTime(job.nextRunAt, now)) : null,
          typeof job.lastDurationMs === 'number' ? h('span', { className: 'cb-meta' }, '耗时 ' + formatDuration(job.lastDurationMs)) : null),
        h('div', { className: 'cb-code' }, job.kind === 'session' ? job.prompt : job.command))
    }

    // 应用内删除确认(替换 window.confirm:风格统一 + ESC 可取消)
    function ConfirmDialog({ message, onConfirm, onCancel }) {
      return h(Modal, { title: '删除确认', onClose: onCancel, width: 420 },
        h('div', { className: 'cb-confirm-text' }, message),
        h('div', { className: 'cb-toolbar' },
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: onCancel }, '取消'),
          h('button', { className: 'cb-button cb-button--danger', onClick: onConfirm }, '删除')))
    }

    function JobsTab({ jobs, status, now, reload, wsModel }) {
      const [formJob, setFormJob] = useState(null)
      const [notice, setNotice] = useState(null)
      const [kindFilter, setKindFilter] = useState('all')
      const [pendingDelete, setPendingDelete] = useState(null)

      const runJob = async (job) => {
        const outcome = await request('POST', 'jobs/' + job.id + '/run')
        setNotice(outcome.ok ? '已发起 ' + outcome.data.runIds.length + ' 个运行' : outcome.error)
        setTimeout(reload, 300)
      }
      const toggleJob = async (job) => {
        await request('PATCH', 'jobs/' + job.id, { enabled: !job.enabled })
        reload()
      }
      const deleteJob = async (job) => {
        await request('DELETE', 'jobs/' + job.id)
        setPendingDelete(null)
        setNotice('已删除「' + job.name + '」')
        reload()
      }

      const visible = jobs.filter((job) => kindFilter === 'all' || job.kind === kindFilter)
        .sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0))
      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, {
            options: [{ value: 'all', label: '全部' }, { value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: kindFilter,
            onChange: setKindFilter,
          }),
          h('div', { className: 'cb-spacer' }),
          status && !status.timerRunning ? h('span', { className: 'cb-badge', style: { color: 'var(--cb-danger)' } }, status.timerReason || '调度停用') : null,
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormJob({}) }, '新建任务')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        visible.length === 0
          ? h('div', { className: 'cb-empty' },
              h('div', null, kindFilter === 'all' ? '还没有定时任务' : '该类型下暂无任务'),
              h('button', { className: 'cb-button', onClick: () => setFormJob({}) }, '新建任务'))
          : h('div', { className: 'cb-cards' },
              visible.map((job) => h(JobCard, {
                key: job.id, job, now,
                onToggle: () => toggleJob(job),
                onRun: () => runJob(job),
                onEdit: () => setFormJob(job),
                onDelete: () => setPendingDelete(job),
              }))),
        pendingDelete ? h(ConfirmDialog, {
          message: '删除任务「' + pendingDelete.name + '」?运行记录与日志一并清除,操作不可撤销。',
          onConfirm: () => deleteJob(pendingDelete),
          onCancel: () => setPendingDelete(null),
        }) : null,
        formJob ? h(JobForm, { job: formJob.id ? formJob : null, wsModel, onDone: () => { setFormJob(null); reload() } }) : null)
    }

    // —— 环境变量 Tab ——
    // —— 环境变量表单(新建/编辑)——
    // 编辑经明文单条接口回填:列表接口的 value 已打码,直接回填保存会覆盖真实值
    function EnvForm({ row, onDone }) {
      const editing = Boolean(row && row.id)
      const [form, setForm] = useState(() => ({
        name: row ? row.name : '',
        value: row ? row.value : '',
        remarks: row ? row.remarks : '',
        multi: row ? row.multi : false,
        enabled: row ? row.enabled : true,
      }))
      const [error, setError] = useState(null)
      useEffect(() => {
        if (!editing) return
        let alive = true
        request('GET', 'envs/' + row.id).then((outcome) => {
          if (!alive) return
          if (outcome.ok) setForm((prev) => ({ ...prev, value: outcome.data.value }))
          else setError('读取变量明文失败:' + outcome.error)
        })
        return () => { alive = false }
      }, [editing, row && row.id])
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const submit = async () => {
        setError(null)
        const payload = { ...form }
        if (form.multi) payload.values = form.value.split('\n').map((line) => line.trim()).filter(Boolean)
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'envs/' + row.id : 'envs', payload)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }
      return h(Modal, { title: editing ? '编辑变量' : '新建变量', onClose: onDone, width: 520 },
        h('div', { className: 'cb-grid' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '备注(可空)' }, h('input', { type: 'text', value: form.remarks, onChange: (e) => set({ remarks: e.target.value }) })),
          h(Field, { label: '值', wide: true, hint: '勾选多值后每行一个值,运行时按同名多值展开' },
            form.multi
              ? h('textarea', { value: form.value, onChange: (e) => set({ value: e.target.value }) })
              : h('input', { type: 'text', value: form.value, onChange: (e) => set({ value: e.target.value }) })),
          h('div', { className: 'cb-field' }, switchToggle({ checked: form.multi, onChange: (e) => set({ multi: e.target.checked }), label: '多值' })),
        ),
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', onClick: submit }, '保存')))
    }

    function ImportForm({ onDone, reload }) {
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const doPreview = async () => {
        const outcome = await request('POST', 'envs/import', { text, apply: false })
        if (outcome.ok) setPreview(outcome.data)
        else setError(outcome.error)
      }
      const doApply = async (overwrite) => {
        const outcome = await request('POST', 'envs/import', { text, apply: true, overwrite })
        if (outcome.ok) { onDone(); reload() } else setError(outcome.error)
      }
      return h(Modal, { title: '导入环境变量', onClose: onDone, width: 560 },
        h('div', { className: 'cb-field cb-field--wide' },
          h('textarea', { style: { minHeight: '120px' }, placeholder: 'NAME=value #备注', value: text, onChange: (e) => setText(e.target.value) })),
        preview ? h('div', { className: 'cb-preview' },
          '解析 ' + preview.parsed.length + ' 条,非法 ' + preview.invalid + ' 条') : null,
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: doPreview }, '预览'),
          h('button', { className: 'cb-button', onClick: () => doApply(false) }, '追加导入'),
          h('button', { className: 'cb-button cb-button--danger', onClick: () => doApply(true) }, '覆盖导入')))
    }

    function EnvsTab({ envs, reload }) {
      const [formRow, setFormRow] = useState(null)
      const [importing, setImporting] = useState(false)
      const [exportText, setExportText] = useState(null)
      const [notice, setNotice] = useState(null)

      const toggleEnv = async (row) => {
        await request('PATCH', 'envs/' + row.id, { enabled: !row.enabled })
        reload()
      }
      const deleteEnv = async (row) => {
        if (!window.confirm('删除变量「' + row.name + '」?')) return
        await request('DELETE', 'envs/' + row.id)
        reload()
      }
      const doExport = async () => {
        const outcome = await request('GET', 'envs/export')
        if (outcome.ok) setExportText(outcome.data.text)
      }

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: doExport }, '导出'),
          h('button', { className: 'cb-button', onClick: () => setImporting(true) }, '导入'),
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormRow({}) }, '新建变量')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        envs.length === 0 ? h('div', { className: 'cb-empty' }, '暂无环境变量') :
          h('div', { className: 'cb-table' },
            envs.map((row) => h('div', { key: row.id, className: 'cb-row' },
              switchToggle({ checked: Boolean(row.enabled), onChange: () => toggleEnv(row) }),
              h('span', { className: 'cb-code' }, row.name),
              h('span', { className: 'cb-code cb-mask' }, row.value),
              row.remarks ? h('span', { className: 'cb-meta' }, '# ' + row.remarks) : null,
              row.multi ? h('span', { className: 'cb-badge' }, '多值') : null,
              h('div', { className: 'cb-actions' },
                h('button', { className: 'cb-icon', onClick: () => setFormRow(row) }, '编辑'),
                h('button', { className: 'cb-icon cb-button--danger', onClick: () => deleteEnv(row) }, '删除'))))),
        formRow ? h(EnvForm, { row: formRow.id ? formRow : null, onDone: () => { setFormRow(null); reload() } }) : null,
        importing ? h(ImportForm, { onDone: () => setImporting(false), reload }) : null,
        exportText !== null ? h(Modal, { title: '导出(仅启用行)', onClose: () => setExportText(null) },
          h('div', { className: 'cb-field cb-field--wide' }, h('textarea', { readOnly: true, value: exportText, style: { minHeight: '160px' } })),
          h('div', { className: 'cb-toolbar' },
            h('button', { className: 'cb-button', onClick: () => { setNotice(null); navigator.clipboard && navigator.clipboard.writeText(exportText).then(() => setNotice('已复制到剪贴板')) } }, '复制'),
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => setExportText(null) }, '关闭'))) : null)
    }

    // —— 日志 Tab ——
    function LogsTab({ jobs, reload, reloadFlag }) {
      const [jobId, setJobId] = useState(jobs.length > 0 ? jobs[0].id : null)
      const [runs, setRuns] = useState([])
      const [logText, setLogText] = useState(null)
      const [logRunId, setLogRunId] = useState(null)

      useEffect(() => {
        let alive = true
        if (!jobId) { setRuns([]); return undefined }
        request('GET', 'runs?jobId=' + encodeURIComponent(jobId)).then((outcome) => {
          if (alive && outcome.ok) setRuns(outcome.data.items)
        })
        return () => { alive = false }
      }, [jobId, reloadFlag])

      const openLog = async (run) => {
        const outcome = await request('GET', 'runs/' + run.runId + '/log')
        if (outcome.ok) { setLogRunId(run.runId); setLogText(outcome.data.text) }
      }
      const clearLog = async (run) => {
        await request('DELETE', 'runs/' + run.runId + '/log')
        setLogText(null)
        setLogRunId(null)
        reload()
      }

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h('select', { className: 'cb-select', value: jobId || '', onChange: (e) => setJobId(e.target.value) },
            jobs.map((job) => h('option', { key: job.id, value: job.id }, job.name)))),
        runs.length === 0 ? h('div', { className: 'cb-empty' }, '该任务暂无运行记录') :
          h('div', { className: 'cb-table' },
            runs.map((run) => {
              const meta = statusMeta(run.status)
              return h('div', { key: run.runId, className: 'cb-row' },
                h('span', { className: 'cb-dot', style: { '--cb-status': STATUS_TONE_COLOR[meta.tone] } }),
                h('span', { className: 'cb-meta' }, meta.label),
                h('span', { className: 'cb-badge' }, TRIGGER_META[run.trigger] ? TRIGGER_META[run.trigger].label : run.trigger),
                h('span', { className: 'cb-meta' }, formatDateTime(run.createdAt)),
                typeof run.durationMs === 'number' ? h('span', { className: 'cb-meta' }, formatDuration(run.durationMs)) : null,
                run.message ? h('span', { className: 'cb-meta' }, run.message) : null,
                h('div', { className: 'cb-actions' },
                  h('button', { className: 'cb-icon', onClick: () => openLog(run) }, '日志'),
                  h('button', { className: 'cb-icon cb-button--danger', onClick: () => clearLog(run) }, '清空')))
            })),
        logText !== null ? h(Modal, { title: '运行日志', onClose: () => setLogText(null), width: 640 },
          h('div', { className: 'cb-log' }, logText || '(空)'),
          h('div', { className: 'cb-toolbar' },
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => setLogText(null) }, '关闭'))) : null)
    }

    function CronBoardPanel({ visible, wsModel } = {}) {
      const active = visible !== false
      const [tab, setTab] = useState('jobs')
      const [jobs, setJobs] = useState([])
      const [envs, setEnvs] = useState([])
      const [status, setStatus] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [reloadFlag, setReloadFlag] = useState(0)
      const reload = useCallback(() => setReloadFlag((value) => value + 1), [])

      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const load = async () => {
          const [jobsOutcome, envsOutcome, statusOutcome] = await Promise.all([
            request('GET', 'jobs'),
            request('GET', 'envs'),
            request('GET', 'status'),
          ])
          if (!alive) return
          if (jobsOutcome.ok) setJobs(jobsOutcome.data.items)
          if (envsOutcome.ok) setEnvs(envsOutcome.data.items)
          if (statusOutcome.ok) setStatus(statusOutcome.data)
          setNow(Date.now())
        }
        load()
        const timer = setInterval(load, REFRESH_INTERVAL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [reloadFlag, active])

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, { options: TABS, value: tab, onChange: setTab }),
          h('div', { className: 'cb-spacer' }),
          status ? h('span', { className: 'cb-meta' },
            '运行中 ' + status.scheduler.active + ' · 队列 ' + status.scheduler.queued +
            (status.nextAt ? ' · 下次 ' + relativeTime(status.nextAt, now) : '')) : null),
        tab === 'jobs' ? h(JobsTab, { key: 'jobs', jobs, status, now, reload, wsModel }) : null,
        tab === 'envs' ? h(EnvsTab, { key: 'envs', envs, reload }) : null,
        tab === 'logs' ? h(LogsTab, { key: 'logs', jobs, reload, reloadFlag }) : null)
    }

    // —— 主页面挂载(形态对齐 dsh-taskboard,cb- 属性命名空间)——
    // 优先 better-sidebar 扩展槽(单实例 tab);未装回退主界面:侧栏入口行 + 中心列看板容器。

    const TAB_ID = 'cron-board:board'
    const ENTRY_ATTR = 'data-cb-entry'
    const VIEW_ATTR = 'data-cb-view'
    const BOARD_ACTIVE_ATTR = 'data-cb-board-active'
    const PANEL_ACTIVATE_EVENT = 'dsh-panel-activate'
    const PANEL_NAME = 'dsh-cron-board'
    const ENTRY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12M10 2v12"/></svg>'
    // 三代布局壳兼容:dev data-pane / 官方 CSS-Module centerCol / DSH Desktop 扩展面
    const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
    const SIDEBAR_ROOT_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
    // 家族面板入口条目(taskboard 系),插入时排其前,避免重渲染后顺序漂移
    const FAMILY_ENTRY_SELECTOR = '[data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry], [' + ENTRY_ATTR + ']'
    const OTHER_PANEL_ACTIVE_ATTRS = ['data-dsh-atb-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']
    const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

    // 设置>插件页卡片:sidebarTab 选项;better-sidebar 在场可切换,否则仅展示禁用态
    function CronBoardPluginCard() {
      const [enabled, setEnabled] = useState(null)
      const [busy, setBusy] = useState(false)
      const [sidebarReady, setSidebarReady] = useState(Boolean(document.querySelector(SIDEBAR_ROOT_SELECTOR)))
      useEffect(() => {
        let alive = true
        request('GET', 'status').then((outcome) => {
          if (alive) setEnabled(outcome.ok && outcome.data && outcome.data.ui ? outcome.data.ui.sidebarTab === true : false)
        })
        return () => { alive = false }
      }, [])
      const toggle = async () => {
        if (busy || enabled === null || !sidebarReady) return
        setBusy(true)
        const outcome = await request('POST', 'ui-settings', { sidebarTab: !enabled })
        if (outcome.ok && outcome.data && outcome.data.ui) setEnabled(outcome.data.ui.sidebarTab === true)
        setBusy(false)
      }
      return h('div', { className: 'cb-settings' },
        switchToggle({
          checked: enabled === true,
          disabled: busy || enabled === null || !sidebarReady,
          onChange: toggle,
          label: '看板移入 better-sidebar 侧边栏',
        }),
        h('div', { className: 'cb-settings__hint' },
          sidebarReady ? '开启后看板以侧边栏页签呈现,关闭时始终使用主界面。' : '需安装 better-sidebar 后方可切换;未安装时看板始终使用主界面。'),
      )
    }

    // better-sidebar tab:注册即单实例(single);v0.19.0 起注册只入「可打开」目录,
    // 须显式 openTab 落入底部工作台;wsModel 供会话任务选工作区
    function registerBoardTab(ctx, service, wsModel) {
      return ctx.effect(() => {
        const disposeTab = service.registerTab({
          id: TAB_ID,
          title: '定时任务',
          icon: (size) => h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
            h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
            h('path', { d: 'M6 2v12M10 2v12' })),
          order: 46,
          single: true,
          component: (props) => h(CronBoardPanel, { visible: props.visible, wsModel }),
        })
        // 无会话时 openTab 静默不落,tab 仍注册在册(新建标签页菜单可见)
        if (typeof service.openTab === 'function') {
          try { service.openTab({ type: TAB_ID }) } catch { /* 打开失败不回滚注册 */ }
        }
        return disposeTab
      }, 'cron-board sidebar tab')
    }

    function sidebarRoot() {
      const column = document.querySelector(SIDEBAR_ROOT_SELECTOR)
      if (!column) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')
      return (logoOwner && logoOwner.parentElement) || column.firstElementChild || undefined
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested) return nested
      for (const child of root.children) {
        if (child instanceof HTMLButtonElement && !child.matches('[' + ENTRY_ATTR + ']')) return child
      }
      return root.querySelector('button[aria-label="新建会话"], button[aria-label*="新会话"], button[aria-label*="new session" i]') || undefined
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root)
      if (!button) return false
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]')
        const base = (row && row.parentElement === root) ? row : button
        const family = Array.from(root.children).filter((el) => el.matches(FAMILY_ENTRY_SELECTOR))
        const anchor = family.length > 0 ? family[0] : (base.nextElementSibling || null)
        root.insertBefore(entry, anchor)
      }
      return true
    }

    // 主界面形态:入口行 + 中心列容器 + html 属性显隐 + 面板互斥;返回幂等 disposer
    function mountStandaloneBoard(wsModel) {
      let disposed = false
      let entry = null
      let rootEl = undefined
      let placed = false
      let rootObserver = null
      let viewRoot = null
      let viewEl = null

      const setOpen = (open) => {
        if (open) {
          for (const attr of OTHER_PANEL_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
          document.documentElement.setAttribute(BOARD_ACTIVE_ATTR, '')
          document.dispatchEvent(new CustomEvent(PANEL_ACTIVATE_EVENT, { detail: PANEL_NAME }))
          entry.dataset.active = 'true'
        } else {
          document.documentElement.removeAttribute(BOARD_ACTIVE_ATTR)
          entry.dataset.active = 'false'
        }
      }
      const isOpen = () => document.documentElement.hasAttribute(BOARD_ACTIVE_ATTR)

      const ensureEntry = () => {
        if (rootEl !== undefined && !rootEl.isConnected) { placed = false; rootEl = undefined }
        if (placed && document.body.contains(entry)) return true
        placed = false
        rootEl = sidebarRoot()
        if (!rootEl) return false
        placed = placeEntry(rootEl, entry)
        if (placed && rootObserver) rootObserver.observe(rootEl, { childList: true, subtree: true })
        return placed
      }

      const ensureView = () => {
        if (viewEl && viewEl.isConnected) return true
        const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR)
        if (!column) return false
        viewEl = document.createElement('div')
        viewEl.setAttribute(VIEW_ATTR, '')
        viewEl.className = 'cb-view'
        column.appendChild(viewEl)
        viewRoot = ReactDOMClient.createRoot(viewEl)
        viewRoot.render(React.createElement(CronBoardPanel, { visible: true, wsModel }))
        return true
      }

      const onClickDocument = (event) => {
        if (!isOpen()) return
        const target = event.target
        if (target && target.closest && target.closest('[' + ENTRY_ATTR + ']')) return
        if (target && target.closest && target.closest(SIDEBAR_ROW_SELECTOR)) setOpen(false)
      }
      const onOtherActivate = (event) => {
        if (event.detail !== PANEL_NAME && isOpen()) setOpen(false)
      }
      entry = document.createElement('button')
      entry.type = 'button'
      entry.setAttribute(ENTRY_ATTR, '')
      entry.className = 'cb-entry'
      entry.setAttribute('aria-label', '定时任务')
      entry.innerHTML = '<span class="cb-entry-icon">' + ENTRY_ICON + '</span><span>定时任务</span>'
      entry.addEventListener('click', () => setOpen(!isOpen()))
      document.addEventListener('click', onClickDocument, true)
      document.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
      const waitObserver = new MutationObserver(() => { ensureEntry(); ensureView() })
      waitObserver.observe(document.body, { childList: true, subtree: true })
      rootObserver = new MutationObserver(() => {
        if (rootEl === undefined || !rootEl.isConnected) { ensureEntry(); return }
        if (!rootEl.contains(entry)) placeEntry(rootEl, entry)
      })
      const retry = setInterval(() => { ensureEntry(); ensureView() }, 2000)
      ensureEntry()
      ensureView()

      return () => {
        if (disposed) return
        disposed = true
        clearInterval(retry)
        waitObserver.disconnect()
        if (rootObserver) rootObserver.disconnect()
        document.removeEventListener('click', onClickDocument, true)
        document.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate)
        document.documentElement.removeAttribute(BOARD_ACTIVE_ATTR)
        entry.remove()
        if (viewRoot) viewRoot.unmount()
        if (viewEl) viewEl.remove()
      }
    }

    return {
      // workspaces 由宿主 client 常驻提供;slots 供设置页分区挂载(缺失则 fiber 未激活,即干净禁用)
      inject: ['workspaces', 'slots'],
      apply(ctx) {
        ensureStyle(document)
        // 工作区 model(list 即 getSnapshot/subscribe 契约的响应式模型;形态不符传 null,表单仅保留手输)
        const wsService = ctx.get('workspaces')
        const wsModel = wsService && wsService.list && typeof wsService.list.getSnapshot === 'function' ? wsService.list : null
        // 挂载权交给用户:默认永远主界面;设置 sidebarTab 开启且侧边栏服务在场才移入扩展槽,注册后不再自动回退
        const attachBoardTab = (sidebar) => registerBoardTab(ctx, sidebar, wsModel)
        let standalone = mountStandaloneBoard(wsModel)
        let tabDisposer = null
        let sidebarTabOn = false
        // betterSidebar 服务软探测 + 晚注册追踪:出现/变化时按当前偏好重新决策
        let currentSidebar = ctx.get('betterSidebar')
        const applyPref = () => {
          const wantTab = sidebarTabOn && currentSidebar !== undefined
          if (wantTab && tabDisposer === null) {
            standalone()
            standalone = null
            tabDisposer = attachBoardTab(currentSidebar)
          } else if (!wantTab && tabDisposer !== null) {
            tabDisposer()
            tabDisposer = null
          }
          if (!wantTab && standalone === null) standalone = mountStandaloneBoard(wsModel)
        }
        const prefWatch = setInterval(async () => {
          try {
            const outcome = await request('GET', 'status')
            if (outcome.ok && outcome.data && typeof outcome.data.ui === 'object' && outcome.data.ui !== null) {
              const next = outcome.data.ui.sidebarTab === true
              if (next !== sidebarTabOn) {
                sidebarTabOn = next
                applyPref()
              }
            }
          } catch { /* 轮询失败保形态不变,下轮重试 */ }
        }, 5 * 1000)
        ctx.effect(() => () => {
          clearInterval(prefWatch)
          if (standalone) standalone()
          if (tabDisposer) tabDisposer()
        }, 'cron-board mount arbitration')
        // 设置>插件页卡片:key 配对 ns,宿主按 describe 命名空间分发;effect 随 fiber 回收
        ctx.effect(() => ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', key: 'cron-board', label: '定时任务' },
            CronBoardPluginCard,
          )
        }), 'cron-board settings card')
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
