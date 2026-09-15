// rs-workflow v4 client 半区:会话页签「若水编排」(gui-session 最小面)+
// 设置页分区「若水工作流」(运行中心最小列表,gui-center 完整形态见 steps/02)。
// 自注册 __ModuleLoader__.load(对齐 v3);数据经 /api/rsww/* 读写。
// 类名前缀 rsww-;颜色仅取官方 alias token;开关遵循仓库规约(track+thumb,锚定 checkbox)。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-rs-workflow',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/rsww/'
    const REFRESH_MS = 5 * 1000
    const LIVE_REFRESH_MS = 2 * 1000
    const VIEW_ID = 'rsww-flow'
    const CHIP_ID = 'rsww-flow-chip'
    const SETTLED_COUNT = 8
    const ARMED_TIMEOUT_MS = 3 * 1000

    const NAV_ICON = { '若水工作流': 'flow', 'dsh-rs-workflow': 'flow' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    const STATUS_META = {
      running: { label: '运行中', tone: 'business' },
      paused: { label: '已暂停', tone: 'warn' },
      completed: { label: '已完成', tone: 'success' },
      cancelled: { label: '已取消', tone: 'mute' },
      failed: { label: '失败', tone: 'error' },
      blocked: { label: '受阻', tone: 'error' },
    }
    const TERMINAL_STATES = ['completed', 'cancelled', 'failed', 'blocked']
    const EVENT_LABELS = { dispatch: '派发', submit: '产出', fail: '失败', skip: '跳过', control: '控制' }

    const CSS = `
.rsww-root{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-flow{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#0f1115);padding-top:10px}
.rsww-head{display:flex;flex-direction:column;gap:2px;padding:4px 2px 0}
.rsww-head__title{font:600 16px/24px var(--dsw-font-family,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif)}
.rsww-head__caption{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#61666b);font:500 var(--dsw-font-xs-13,13px/20px sans-serif);border-radius:8px;padding:5px 12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.rsww-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-btn--danger{color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-btn--danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.06));border-color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-btn:disabled{opacity:.45;cursor:default}
.rsww-badge{display:inline-flex;align-items:center;gap:5px;font:500 var(--dsw-font-xxs-12,12px/18px sans-serif);border-radius:999px;padding:2px 9px;white-space:nowrap}
.rsww-badge--business{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-badge--success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a)}
.rsww-badge--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-badge--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#b45309)}
.rsww-badge--mute{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor}
.rsww-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.rsww-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.rsww-req{font:600 var(--dsw-font-s-14,14px/22px sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:180px}
.rsww-group{display:flex;flex-direction:column;gap:8px}
.rsww-group__head{display:flex;align-items:baseline;gap:8px;padding:2px 2px 0}
.rsww-group__title{font:600 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,#61666b)}
.rsww-group__count{font:400 var(--dsw-font-xxs-12,12px/18px sans-serif);color:var(--dsw-alias-label-caption,#adb2b8)}
.rsww-section{display:flex;flex-direction:column;gap:4px}
.rsww-label{font:600 var(--dsw-font-xxs-12,12px/18px sans-serif);color:var(--dsw-alias-label-tertiary,#81858c);letter-spacing:.02em}
.rsww-text{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
.rsww-error{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 0 40px;color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-empty__title{font:500 var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-label-secondary,#61666b)}
.rsww-empty__hint{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);text-align:center;max-width:420px}
.rsww-input{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:400 var(--dsw-font-xs-13,13px/20px sans-serif);padding:6px 10px;transition:border-color .15s}
.rsww-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-input--wide{flex:1;min-width:220px}
.rsww-steps{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;max-height:420px;overflow:auto}
.rsww-step{display:flex;align-items:baseline;gap:8px;font:400 var(--dsw-font-xs-13,13px/20px sans-serif);line-height:1.55;padding:4px 6px;border-radius:6px}
.rsww-step:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.rsww-step__node{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);flex:none;min-width:88px}
.rsww-step__sum{color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word;flex:1;min-width:0}
.rsww-step--fail .rsww-step__sum{color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-full{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;padding:8px;margin-top:4px;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.rsww-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.rsww-switch input[type="checkbox"]{position:absolute;opacity:0;width:1px;height:1px}
.rsww-switch__track{width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.12));position:relative;transition:background .15s;flex:none}
.rsww-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track{background:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track .rsww-switch__thumb{transform:translateX(13px)}
.rsww-switch input[type="checkbox"]:focus-visible + .rsww-switch__track{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 70%,white);outline-offset:1px}
.rsww-chip{position:relative;display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:500 var(--dsw-font-xs-13,13px/20px sans-serif);border-radius:6px;padding:3px 2px;cursor:pointer;white-space:nowrap}
.rsww-chip--live{color:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-chip__dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;animation:rsww-pulse 1.2s ease-in-out infinite}
@keyframes rsww-pulse{0%,100%{opacity:1}50%{opacity:.35}}
`

    async function request(path) {
      let res
      try { res = await fetch(API + path) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
      let json = null
      try { json = await res.json() } catch { json = null }
      if (!res.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + res.status + ')' }
      return { ok: true, data: json }
    }

    async function post(path, body) {
      let res
      try {
        res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
      let json = null
      try { json = await res.json() } catch { json = null }
      if (!res.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + res.status + ')' }
      return { ok: true, data: json }
    }

    function statusMeta(status) { return STATUS_META[status] || { label: status || '-', tone: 'mute' } }

    function relativeTime(ts) {
      if (typeof ts !== 'number' || !(ts > 0)) return '-'
      const delta = Date.now() - ts
      const abs = Math.abs(delta)
      const MINUTE = 60 * 1000
      const HOUR = 60 * MINUTE
      const DAY = 24 * HOUR
      const suffix = delta >= 0 ? '前' : '后'
      if (abs < MINUTE) return Math.max(1, Math.round(abs / 1000)) + ' 秒' + suffix
      if (abs < HOUR) return Math.round(abs / MINUTE) + ' 分钟' + suffix
      if (abs < DAY) return Math.round(abs / HOUR) + ' 小时' + suffix
      return Math.round(abs / DAY) + ' 天' + suffix
    }

    function Badge({ tone, children, dot }) {
      return React.createElement('span', { className: 'rsww-badge rsww-badge--' + tone },
        dot ? React.createElement('span', { className: 'rsww-dot' }) : null, children)
    }

    function StatusBadge({ status }) {
      const meta = statusMeta(status)
      return React.createElement(Badge, { tone: meta.tone, dot: true }, meta.label)
    }

    function EmptyState({ title, hint }) {
      return React.createElement('div', { className: 'rsww-empty' },
        React.createElement('span', { className: 'rsww-empty__title' }, title),
        hint ? React.createElement('span', { className: 'rsww-empty__hint' }, hint) : null)
    }

    function Switch(props) {
      return React.createElement('label', { className: 'rsww-switch' },
        React.createElement('input', { type: 'checkbox', checked: props.checked, onChange: props.onChange, 'aria-label': props.ariaLabel }),
        React.createElement('span', { className: 'rsww-switch__track' }, React.createElement('span', { className: 'rsww-switch__thumb' })),
        React.createElement('span', { className: 'rsww-text' }, props.label))
    }

    // 产出/指令/错误全文展开(痛点 7/18:零截断,默认折叠)
    function OutputFullText({ label, text, tone }) {
      const [open, setOpen] = useState(false)
      if (!text) return null
      return React.createElement('div', {},
        React.createElement('button', { className: 'rsww-btn', style: { padding: '2px 8px' }, onClick: () => setOpen((v) => !v) },
          (open ? '收起 ' : '展开 ') + label),
        open ? React.createElement('div', { className: 'rsww-full', style: tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary,#ec1313)' } : null }, text) : null)
    }

    // 步骤事件账行:按 store.step 落盘顺序渲染全量 body
    function StreamRow({ stepId, instance, event, body }) {
      const tag = stepId + (instance && instance !== '-' ? '#' + instance : '')
      const kind = EVENT_LABELS[event] || event
      let summary = ''
      if (event === 'dispatch') summary = body.callLabel ? String(body.callLabel) : '→ ' + tag
      else if (event === 'submit') summary = '产出已提交'
      else if (event === 'fail') summary = body.error || '失败'
      else if (event === 'control') summary = (body.kind === 'message' ? (body.inject ? '[纠偏注入] ' : '[排队] ') : '[' + body.kind + '] ') + (body.text || '')
      else summary = body.reason || ''
      return React.createElement('li', { className: 'rsww-step' + (event === 'fail' ? ' rsww-step--fail' : '') },
        React.createElement('span', { className: 'rsww-step__node' }, tag + ' · ' + kind),
        React.createElement('span', { className: 'rsww-step__sum' },
          summary,
          event === 'dispatch' && body.prompt ? React.createElement(OutputFullText, { label: '指令全文', text: body.prompt }) : null,
          event === 'submit' && body.outputs ? React.createElement(OutputFullText, { label: '产出全文', text: JSON.stringify(body.outputs, null, 2) }) : null,
          event === 'fail' ? React.createElement(OutputFullText, { label: '错误详情', text: body.error || '' }) : null))
    }

    // 控制条:按状态显隐按钮 + 末端消息输入行(勾选「纠偏注入」)
    function ControlBar({ run }) {
      const [text, setText] = useState('')
      const [inject, setInject] = useState(false)
      const [armed, setArmed] = useState(false)
      const [error, setError] = useState('')
      const live = run.status === 'running' || run.status === 'paused'
      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), ARMED_TIMEOUT_MS)
        return () => clearTimeout(timer)
      }, [armed])
      if (!live) return null
      const control = async (kind) => {
        setError('')
        const outcome = await post('control', { runId: run.runId, kind })
        if (!outcome.ok) setError(outcome.error)
      }
      const send = async () => {
        if (!text.trim()) return
        setError('')
        const outcome = await post('control', { runId: run.runId, kind: 'message', text: text.trim(), inject })
        if (!outcome.ok) { setError(outcome.error); return }
        setText('')
      }
      return React.createElement('div', { className: 'rsww-section' },
        React.createElement('div', { className: 'rsww-row' },
          run.status === 'running' ? React.createElement('button', { className: 'rsww-btn', onClick: () => control('pause') }, '暂停') : null,
          run.status === 'paused' ? React.createElement('button', { className: 'rsww-btn', onClick: () => control('resume') }, '恢复') : null,
          armed
            ? React.createElement('button', { className: 'rsww-btn rsww-btn--danger', onClick: () => control('cancel') }, '确认取消')
            : React.createElement('button', { className: 'rsww-btn rsww-btn--danger', onClick: () => setArmed(true) }, '取消')),
        React.createElement('div', { className: 'rsww-row' },
          React.createElement('input', {
            className: 'rsww-input rsww-input--wide', value: text, placeholder: '追加消息(运行中入队,下一步进入编排)',
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') send() },
          }),
          React.createElement('button', { className: 'rsww-btn', onClick: send, disabled: !text.trim() }, '发送'),
          React.createElement(Switch, { checked: inject, onChange: (e) => setInject(e.target.checked), label: '纠偏注入', ariaLabel: '纠偏注入' })),
        error ? React.createElement('span', { className: 'rsww-error' }, error) : null)
    }

    // 单 run 卡片:详情自轮询(运行中 2s;落定仅挂载一次)
    function RunCard({ run }) {
      const [detail, setDetail] = useState(null)
      const [fetchError, setFetchError] = useState(false)
      const live = run.status === 'running' || run.status === 'paused'
      useEffect(() => {
        let alive = true
        const reload = () => request('run?id=' + encodeURIComponent(run.runId)).then((outcome) => {
          if (!alive) return
          if (outcome.ok) { setDetail(outcome.data); setFetchError(false) } else setFetchError(true)
        })
        reload()
        const timer = live ? setInterval(reload, LIVE_REFRESH_MS) : null
        return () => { alive = false; if (timer) clearInterval(timer) }
      }, [run.runId, run.status, live])
      const view = detail || run
      const queued = Array.isArray(view.queued) ? view.queued : []
      const stepEvents = []
      const steps = view.steps || {}
      for (const [stepId, byInstance] of Object.entries(steps)) {
        for (const [instance, events] of Object.entries(byInstance || {})) {
          for (const e of events || []) stepEvents.push({ stepId, instance, ...e })
        }
      }
      stepEvents.sort((a, b) => (a.at || '').localeCompare(b.at || ''))
      const requestText = String(view.request || '').split(/<\/?system-reminder>/i)[0].trim() || '(见完整记录)'
      return React.createElement('div', { className: 'rsww-card' },
        React.createElement('div', { className: 'rsww-row' },
          React.createElement(StatusBadge, { status: view.status }),
          view.templateId ? React.createElement(Badge, { tone: 'mute' }, view.templateId) : null,
          React.createElement('span', { className: 'rsww-req', title: view.request }, requestText),
          React.createElement('span', { className: 'rsww-text' }, relativeTime(view.updatedAt || view.createdAt))),
        React.createElement(ControlBar, { run: view }),
        queued.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '排队消息'),
          queued.map((q, i) => React.createElement('span', { className: 'rsww-text', key: i }, '[' + (i + 1) + '] ' + q))) : null,
        stepEvents.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '批次节点流'),
          React.createElement('ul', { className: 'rsww-steps' },
            stepEvents.map((e, i) => React.createElement(StreamRow, { key: i, ...e })))) : null,
        TERMINAL_STATES.includes(view.status) && view.summary ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '结论'),
          React.createElement('span', { className: 'rsww-text' }, view.summary)) : null,
        fetchError ? React.createElement('span', { className: 'rsww-error' }, '详情拉取失败,下轮自动重试') : null)
    }

    function FlowView() {
      const [runs, setRuns] = useState(null)
      const [error, setError] = useState('')
      const reload = useCallback(async () => {
        const outcome = await request('runs')
        if (outcome.ok) { setRuns(outcome.data.runs || []); setError('') } else setError(outcome.error)
      }, [])
      useEffect(() => {
        reload()
        const timer = setInterval(reload, REFRESH_MS)
        return () => clearInterval(timer)
      }, [reload])
      if (error && !runs) return React.createElement('div', { className: 'rsww-flow' }, React.createElement('span', { className: 'rsww-error' }, error))
      const mine = runs || []
      const running = mine.filter((r) => r.status === 'running' || r.status === 'paused')
      const settled = mine.filter((r) => !running.includes(r)).slice(0, SETTLED_COUNT)
      const group = (title, count, items) => React.createElement('div', { className: 'rsww-group' },
        React.createElement('div', { className: 'rsww-group__head' },
          React.createElement('span', { className: 'rsww-group__title' }, title),
          React.createElement('span', { className: 'rsww-group__count' }, count)),
        items.map((run) => React.createElement(RunCard, { key: run.runId, run })))
      return React.createElement('div', { className: 'rsww-flow' },
        React.createElement('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        error ? React.createElement('span', { className: 'rsww-error' }, error) : null,
        mine.length === 0 ? EmptyState({ title: '还没有运行记录', hint: '选中任一若水模式发送需求后,编排进度会实时出现在这里。' }) : null,
        running.length ? group('进行中', running.length + ' 次', running) : null,
        settled.length ? group('已落定', '近 ' + settled.length + ' 次', settled) : null)
    }

    function FlowChip() {
      const [runs, setRuns] = useState([])
      const reload = useCallback(async () => {
        const outcome = await request('runs')
        if (outcome.ok) setRuns(outcome.data.runs || [])
      }, [])
      useEffect(() => {
        reload()
        const timer = setInterval(reload, REFRESH_MS)
        return () => clearInterval(timer)
      }, [reload])
      const live = runs.filter((r) => r.status === 'running')
      if (live.length === 0) return null
      return React.createElement('button', { className: 'rsww-chip rsww-chip--live', onClick: () => { window.dispatchEvent(new CustomEvent('rsww:open-flow-view')) } },
        React.createElement('span', { className: 'rsww-chip__dot' }),
        '若水编排 ' + live.length + ' 运行中')
    }

    // 设置页分区最小面:与页签同源的运行中心列表(完整 gui-center/gui-editor/gui-config 见 steps/02-03)
    function RswwApp() {
      return React.createElement('div', { className: 'rsww-root' },
        React.createElement('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        React.createElement('div', { className: 'rsww-head' },
          React.createElement('span', { className: 'rsww-head__title' }, '若水工作流'),
          React.createElement('span', { className: 'rsww-head__caption' },
            '强规则编排:模式内消息被接管,批次推进,结构化产出强制校验;运行中心完整形态在后续版本提供。')),
        React.createElement(FlowView))
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'rs-workflow-board', order: 45, label: '若水工作流' },
            () => React.createElement(RswwApp),
          ))
        // 会话感知条件注入:当前会话存在 rs 运行记录才挂页签与胶囊(v3 ensure/judge 模式)
        ctx.effect(() => {
          let disposed = false
          let timer = null
          let disposeView = null
          let disposeChip = null
          let cache = { sessionId: undefined, isRs: false }
          const ensure = (isRs) => {
            if (disposed) return
            if (isRs && !disposeView) {
              disposeView = ctx.slots.inject('conversation.view', () =>
                ctx.slots.register(
                  { name: 'conversation.view', id: VIEW_ID, order: 15, label: '若水编排' },
                  () => React.createElement(FlowView),
                ))
              disposeChip = ctx.slots.inject('conversation.session.header.actions', () =>
                ctx.slots.register(
                  { name: 'conversation.session.header.actions', id: CHIP_ID, order: 15 },
                  () => React.createElement(FlowChip),
                ))
            } else if (!isRs && disposeView) {
              disposeView(); disposeView = null
              disposeChip(); disposeChip = null
            }
          }
          const judge = async () => {
            const sessionId = ctx.sessions?.list?.getSnapshot?.().current
            if (sessionId === undefined) { ensure(false); return }
            if (cache.sessionId === sessionId && cache.fetched) { ensure(cache.isRs); return }
            try {
              const res = await fetch(API + 'runs')
              if (!res.ok) return
              const json = await res.json()
              if (disposed) return
              const isRs = (json && Array.isArray(json.runs) ? json.runs : []).some((r) => r.sessionId === sessionId)
              cache = { sessionId, isRs, fetched: true }
              ensure(isRs)
            } catch { /* host 未就绪:下轮重试 */ }
          }
          const unsubscribe = ctx.sessions.list.subscribe(() => { cache = { sessionId: undefined, isRs: false }; judge() })
          timer = setInterval(judge, REFRESH_MS)
          judge()
          return () => {
            disposed = true
            unsubscribe()
            if (timer) clearInterval(timer)
            if (disposeView) disposeView()
            if (disposeChip) disposeChip()
          }
        }, 'rs-workflow: session-aware flow view')
      },
    }
  },
})
