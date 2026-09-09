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
.cb-panel{display:flex;flex-direction:column;gap:12px;min-width:0}
.cb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cb-tabs{display:flex;gap:4px}
.cb-pill{border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:999px;padding:3px 12px;font-size:13px;background:transparent;color:inherit;cursor:pointer}
.cb-pill--on{background:var(--dsh-accent,#3b82f6);border-color:transparent;color:#fff}
.cb-spacer{flex:1}
.cb-button{border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:6px;padding:4px 10px;font-size:13px;background:transparent;color:inherit;cursor:pointer}
.cb-button:hover{border-color:var(--dsh-accent,#3b82f6)}
.cb-button--primary{background:var(--dsh-accent,#3b82f6);border-color:transparent;color:#fff}
.cb-button--danger{color:#e5484d}
.cb-cards{display:flex;flex-direction:column;gap:8px}
.cb-card{position:relative;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:8px;padding:10px 12px;cursor:pointer;overflow:hidden}
.cb-card:hover{border-color:var(--dsh-accent,#3b82f6)}
.cb-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3.5px;background:var(--cb-status,#8b8d98)}
.cb-card-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cb-name{font-size:14px;font-weight:600}
.cb-badge{font-size:11px;border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:4px;padding:1px 6px;color:var(--dsh-text-secondary,inherit)}
.cb-dot{width:8px;height:8px;border-radius:50%;background:var(--cb-status,#8b8d98);flex:none}
.cb-meta{font-size:12px;color:var(--dsh-text-secondary,rgba(128,128,128,.9))}
.cb-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.cb-icon{border:none;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}
.cb-icon:hover{background:rgba(128,128,128,.15)}
.cb-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;gap:6px}
.cb-switch input[type="checkbox"] { position:absolute;opacity:0;width:1px;height:1px }
.cb-switch__track{width:30px;height:17px;border-radius:999px;background:rgba(128,128,128,.4);position:relative;transition:background .15s;flex:none}
.cb-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track{background:var(--dsh-accent,#3b82f6)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track .cb-switch__thumb{left:15px}
.cb-switch input[type="checkbox"]:focus-visible + .cb-switch__track{outline:2px solid var(--dsh-accent,#3b82f6);outline-offset:1px}
.cb-switch input[type="checkbox"]:disabled + .cb-switch__track{opacity:.4;cursor:not-allowed}
.cb-switch:not(:has(input[type="checkbox"]:disabled)):hover .cb-switch__track{background:rgba(128,128,128,.6)}
.cb-switch input[type="checkbox"]:checked:not(:disabled) + .cb-switch__track:hover{background:var(--dsh-accent,#3b82f6)}
.cb-table{display:flex;flex-direction:column;gap:4px;font-size:13px}
.cb-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:6px;padding:6px 10px;flex-wrap:wrap}
.cb-code{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}
.cb-mask{color:var(--dsh-text-secondary,rgba(128,128,128,.9))}
.cb-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:60}
.cb-modal{background:var(--dsh-bg,#1e1f24);color:inherit;border-radius:10px;padding:16px;max-width:720px;width:min(720px,92vw);max-height:84vh;overflow:auto;display:flex;flex-direction:column;gap:10px}
.cb-modal-title{font-size:15px;font-weight:600}
.cb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}
.cb-field{display:flex;flex-direction:column;gap:4px;font-size:12px;min-width:0}
.cb-field--wide{grid-column:1 / -1}
.cb-field input[type="text"],.cb-field input[type="number"],.cb-field textarea,.cb-field select{border:1px solid var(--dsh-border,rgba(128,128,128,.4));border-radius:6px;padding:5px 8px;font-size:13px;background:transparent;color:inherit;min-width:0}
.cb-field textarea{min-height:64px;resize:vertical}
.cb-hint{font-size:11px;color:var(--dsh-text-secondary,rgba(128,128,128,.9))}
.cb-preview{font-size:12px;border:1px dashed var(--dsh-border,rgba(128,128,128,.4));border-radius:6px;padding:6px 8px}
.cb-log{font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;background:rgba(128,128,128,.08);border-radius:6px;padding:8px;max-height:320px;overflow:auto}
.cb-empty{font-size:13px;color:var(--dsh-text-secondary,rgba(128,128,128,.9));padding:12px 0;text-align:center}
.cb-select{border:1px solid var(--dsh-border,rgba(128,128,128,.4));border-radius:6px;padding:4px 8px;font-size:13px;background:transparent;color:inherit}
`

// 空模块兜底:react 缺席即整面板禁用(宿主必有 react,防御性)
function noopFactory() {
  return { inject: [], apply() {} }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-cron-board', factory })

  function factory(require) {
    let React = null
    try {
      React = require('react')
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

    function Modal({ title, onClose, children }) {
      return h('div', { className: 'cb-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'cb-modal' },
          h('div', { className: 'cb-modal-title' }, title),
          children))
    }

    // —— 任务表单(新建/编辑)——
    function JobForm({ job, onDone }) {
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
        setError(null)
        const payload = { ...form }
        payload.concurrency = form.concurrency === '' ? undefined : Number(form.concurrency)
        payload.session = form.kind === 'session' ? form.session : undefined
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'jobs/' + job.id : 'jobs', payload)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }

      return h(Modal, { title: editing ? '编辑任务' : '新建任务', onClose: onDone },
        h('div', { className: 'cb-grid' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '类型' }, h(PillGroup, {
            options: [{ value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: form.kind,
            onChange: (kind) => set({ kind }),
          })),
          form.kind === 'shell'
            ? h(Field, { label: '命令', wide: true, hint: '经由宿主 shell 执行,支持环境变量插值 $NAME' },
                h('input', { type: 'text', value: form.command, onChange: (e) => set({ command: e.target.value }) }))
            : null,
          form.kind === 'shell'
            ? h(Field, { label: '工作目录(可空)' }, h('input', { type: 'text', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) }))
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
            : null,
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
          h(Field, { label: '并发上限(可空)' }, h('input', { type: 'number', value: form.concurrency, onChange: (e) => set({ concurrency: e.target.value }) })),
        ),
        error ? h('div', { className: 'cb-hint', style: { color: '#e5484d' } }, error) : null,
        h('div', { className: 'cb-toolbar' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', onClick: submit }, '保存')))
    }

    function JobCard({ job, now, onToggle, onRun, onEdit, onDelete }) {
      const meta = statusMeta(job.lastStatus)
      const style = { '--cb-status': STATUS_TONE_COLOR[meta.tone] }
      return h('div', { className: 'cb-card', style, role: 'button', tabIndex: 0, onClick: onEdit },
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-name' }, job.name),
          h('span', { className: 'cb-badge' }, KIND_LABELS[job.kind] || job.kind),
          job.kind === 'session' && job.session ? h('span', { className: 'cb-badge' }, MODE_LABELS[job.session.mode]) : null,
          job.kind === 'session' && job.session && job.session.windowStart
            ? h('span', { className: 'cb-badge' }, job.session.windowStart + '-' + job.session.windowEnd) : null,
          h('span', { className: 'cb-dot' }),
          h('span', { className: 'cb-meta' }, job.lastStatus ? meta.label : '未运行'),
          h('div', { className: 'cb-actions', onClick: (event) => event.stopPropagation() },
            switchToggle({ checked: Boolean(job.enabled), onChange: onToggle }),
            h('button', { className: 'cb-icon', title: '立即运行', onClick: onRun }, '▶ 运行'),
            h('button', { className: 'cb-icon', title: '编辑', onClick: onEdit }, '编辑'),
            h('button', { className: 'cb-icon cb-button--danger', title: '删除', onClick: onDelete }, '删除'))),
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-meta' }, job.summary || job.schedule),
          typeof job.nextRunAt === 'number' && job.enabled ? h('span', { className: 'cb-meta' }, '下次 ' + relativeTime(job.nextRunAt, now)) : null,
          typeof job.lastDurationMs === 'number' ? h('span', { className: 'cb-meta' }, '上次耗时 ' + formatDuration(job.lastDurationMs)) : null),
        h('div', { className: 'cb-code' }, job.kind === 'session' ? job.prompt : job.command))
    }

    function JobsTab({ jobs, status, now, reload }) {
      const [formJob, setFormJob] = useState(null)
      const [notice, setNotice] = useState(null)
      const [kindFilter, setKindFilter] = useState('all')

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
        if (!window.confirm('删除任务「' + job.name + '」?运行记录与日志一并清除')) return
        await request('DELETE', 'jobs/' + job.id)
        reload()
      }

      const visible = jobs.filter((job) => kindFilter === 'all' || job.kind === kindFilter)
      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, {
            options: [{ value: 'all', label: '全部' }, { value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: kindFilter,
            onChange: setKindFilter,
          }),
          h('div', { className: 'cb-spacer' }),
          status && !status.timerRunning ? h('span', { className: 'cb-badge', style: { color: '#e5484d' } }, status.timerReason || '调度停用') : null,
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormJob({}) }, '新建任务')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        visible.length === 0 ? h('div', { className: 'cb-empty' }, '暂无任务,点击右上角新建') :
          h('div', { className: 'cb-cards' },
            visible.map((job) => h(JobCard, {
              key: job.id, job, now,
              onToggle: () => toggleJob(job),
              onRun: () => runJob(job),
              onEdit: () => setFormJob(job),
              onDelete: () => deleteJob(job),
            }))),
        formJob ? h(JobForm, { job: formJob.id ? formJob : null, onDone: () => { setFormJob(null); reload() } }) : null)
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
      return h(Modal, { title: editing ? '编辑变量' : '新建变量', onClose: onDone },
        h('div', { className: 'cb-grid' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '备注(可空)' }, h('input', { type: 'text', value: form.remarks, onChange: (e) => set({ remarks: e.target.value }) })),
          h(Field, { label: '值', wide: true, hint: '勾选多值后每行一个值,运行时按同名多值展开' },
            form.multi
              ? h('textarea', { value: form.value, onChange: (e) => set({ value: e.target.value }) })
              : h('input', { type: 'text', value: form.value, onChange: (e) => set({ value: e.target.value }) })),
          h('div', { className: 'cb-field' }, switchToggle({ checked: form.multi, onChange: (e) => set({ multi: e.target.checked }), label: '多值' })),
        ),
        error ? h('div', { className: 'cb-hint', style: { color: '#e5484d' } }, error) : null,
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
      return h(Modal, { title: '导入环境变量', onClose: onDone },
        h('div', { className: 'cb-field cb-field--wide' },
          h('textarea', { style: { minHeight: '120px' }, placeholder: 'NAME=value #备注', value: text, onChange: (e) => setText(e.target.value) })),
        preview ? h('div', { className: 'cb-preview' },
          '解析 ' + preview.parsed.length + ' 条,非法 ' + preview.invalid.length + ' 条') : null,
        error ? h('div', { className: 'cb-hint', style: { color: '#e5484d' } }, error) : null,
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
    function LogsTab({ jobs, reload }) {
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
      }, [jobId, reload])

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
        logText !== null ? h(Modal, { title: '运行日志', onClose: () => setLogText(null) },
          h('div', { className: 'cb-log' }, logText || '(空)'),
          h('div', { className: 'cb-toolbar' },
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => setLogText(null) }, '关闭'))) : null)
    }

    function CronBoardPanel() {
      const [tab, setTab] = useState('jobs')
      const [jobs, setJobs] = useState([])
      const [envs, setEnvs] = useState([])
      const [status, setStatus] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [reloadFlag, setReloadFlag] = useState(0)
      const reload = useCallback(() => setReloadFlag((value) => value + 1), [])

      useEffect(() => {
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
      }, [reloadFlag])

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, { options: TABS, value: tab, onChange: setTab }),
          h('div', { className: 'cb-spacer' }),
          status ? h('span', { className: 'cb-meta' },
            '运行中 ' + status.scheduler.active + ' · 队列 ' + status.scheduler.queued +
            (status.nextAt ? ' · 下次 ' + relativeTime(status.nextAt, now) : '')) : null),
        tab === 'jobs' ? h(JobsTab, { key: 'jobs', jobs, status, now, reload }) : null,
        tab === 'envs' ? h(EnvsTab, { key: 'envs', envs, reload }) : null,
        tab === 'logs' ? h(LogsTab, { key: 'logs', jobs, reload }) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle(document)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'cron-board', order: 46, label: '定时任务' },
            CronBoardPanel,
          ))
      },
    }
  }
}
})()
