// rs-workflow v4 client 半区:会话页签「若水编排」(gui-session,唯一运行记录视图)+
// 设置页分区「若水工作流」:流程模板(gui-editor)/配置(gui-config)。
// 自注册 __ModuleLoader__.load(对齐 v3);数据经 /api/rsww/* 读写。
// 类名前缀 rsww-;颜色仅取官方 alias token;开关遵循仓库规约(track+thumb,锚定 checkbox)。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-rs-workflow',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useCallback } = React

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
.rsww-pills{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:9px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);width:max-content}
.rsww-pill{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:500 var(--dsw-font-xs-13,13px/20px sans-serif);border-radius:6px;padding:4px 12px;cursor:pointer;white-space:nowrap}
.rsww-pill--on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.rsww-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rsww-detail{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.rsww-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 40%,transparent);padding:40px 16px;overflow:auto}
.rsww-modal__panel{width:100%;max-width:860px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 40px color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 18%,transparent)}
.rsww-card--err{border-color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-input--err{border-color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-tree__row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;font:400 var(--dsw-font-xs-13,13px/20px sans-serif)}
.rsww-note{font:400 var(--dsw-font-xxs-12,12px/18px sans-serif);color:var(--dsw-alias-label-caption,#adb2b8)}
.rsww-kv{display:flex;flex-direction:column;gap:6px}
.rsww-kv__row{display:flex;gap:6px;align-items:center;min-width:0}
.rsww-stack{display:flex;flex-direction:column;gap:10px}
.rsww-textarea{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:1.6;padding:8px 10px;min-height:110px;resize:vertical;width:100%;box-sizing:border-box}
.rsww-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}
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
      if (!res.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + res.status + ')', data: json }
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
    // 剪贴板写入:clipboard API 优先;非安全上下文(LAN HTTP)退化 execCommand
    const copyText = async (text) => {
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); return true } catch { /* 权限拒绝时走兜底 */ }
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const done = document.execCommand('copy')
        ta.remove()
        return done
      } catch { return false }
    }

    function CopyButton({ text, label = '复制' }) {
      const [done, setDone] = useState(false)
      useEffect(() => {
        if (!done) return undefined
        const t = setTimeout(() => setDone(false), ARMED_TIMEOUT_MS)
        return () => clearTimeout(t)
      }, [done])
      return React.createElement('button', { className: 'rsww-btn', style: { padding: '2px 8px' }, type: 'button',
        onClick: async () => { if (await copyText(text)) setDone(true) } },
        done ? '已复制' : label)
    }

    function OutputFullText({ label, text, tone }) {
      const [open, setOpen] = useState(false)
      if (!text) return null
      return React.createElement('div', {},
        React.createElement('button', { className: 'rsww-btn', style: { padding: '2px 8px' }, onClick: () => setOpen((v) => !v) },
          (open ? '收起 ' : '展开 ') + label),
        open ? React.createElement('div', { className: 'rsww-full', style: tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary,#ec1313)' } : null }, text) : null,
        open ? React.createElement(CopyButton, { text }) : null)
    }

    // 步骤事件账行:按 store.step 落盘顺序渲染全量 body;body 判空兜底(空账/异常事件不崩页签)
    function StreamRow({ stepId, instance, event, body }) {
      const safeBody = body || {}
      const tag = stepId + (instance && instance !== '-' ? '#' + instance : '')
      const kind = EVENT_LABELS[event] || event
      let summary = ''
      if (event === 'dispatch') summary = safeBody.callLabel ? String(safeBody.callLabel) : '→ ' + tag
      else if (event === 'submit') summary = '产出已提交'
      else if (event === 'fail') summary = safeBody.error || '失败'
      else if (event === 'control') summary = (safeBody.kind === 'message' ? (safeBody.inject ? '[纠偏注入] ' : '[排队] ') : '[' + safeBody.kind + '] ') + (safeBody.text || '')
      else summary = safeBody.reason || ''
      return React.createElement('li', { className: 'rsww-step' + (event === 'fail' ? ' rsww-step--fail' : '') },
        React.createElement('span', { className: 'rsww-step__node' }, tag + ' · ' + kind),
        React.createElement('span', { className: 'rsww-step__sum' },
          summary,
          event === 'dispatch' && safeBody.prompt ? React.createElement(OutputFullText, { label: '指令全文', text: safeBody.prompt }) : null,
          event === 'submit' && safeBody.outputs ? React.createElement(OutputFullText, { label: '产出全文', text: JSON.stringify(safeBody.outputs, null, 2) }) : null,
          event === 'fail' ? React.createElement(OutputFullText, { label: '错误详情', text: safeBody.error || '' }) : null))
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

    // 单 run 卡片:详情自轮询(运行中 2s;落定仅挂载一次);终态卡内嵌重跑/续跑/删除操作
    function RunCard({ run, onChanged }) {
      const [detail, setDetail] = useState(null)
      const [fetchError, setFetchError] = useState(false)
      const live = run.status === 'running' || run.status === 'paused'
      const reload = useCallback(() => request('run?id=' + encodeURIComponent(run.runId)).then((outcome) => {
        if (outcome.ok) { setDetail(outcome.data); setFetchError(false) } else setFetchError(true)
      }), [run.runId])
      useEffect(() => {
        let alive = true
        const load = () => reload().then(() => { if (!alive) return })
        load()
        const timer = live ? setInterval(load, LIVE_REFRESH_MS) : null
        return () => { alive = false; if (timer) clearInterval(timer) }
      }, [reload, live])
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
      const settled = TERMINAL_STATES.includes(view.status)
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
        settled && view.summary ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '结论'),
          React.createElement('span', { className: 'rsww-text' }, view.summary)) : null,
        settled && detail ? React.createElement(DetailActions, { detail, onReload: reload, onRemoved: onChanged }) : null,
        fetchError ? React.createElement('span', { className: 'rsww-error' }, '详情拉取失败,下轮自动重试') : null)
    }

    function FlowView({ getSessionId }) {
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
      // 只呈现本会话的 run:页签语义=本会话编排在场;跨会话检索交给宿主会话搜索
      const mine = (runs || []).filter((r) => r.sessionId === getSessionId())
      const running = mine.filter((r) => r.status === 'running' || r.status === 'paused')
      const settled = mine.filter((r) => !running.includes(r)).slice(0, SETTLED_COUNT)
      const group = (title, count, items) => React.createElement('div', { className: 'rsww-group' },
        React.createElement('div', { className: 'rsww-group__head' },
          React.createElement('span', { className: 'rsww-group__title' }, title),
          React.createElement('span', { className: 'rsww-group__count' }, count)),
        items.map((run) => React.createElement(RunCard, { key: run.runId, run, onChanged: reload })))
      return React.createElement('div', { className: 'rsww-flow' },
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-rs-workflow', dangerouslySetInnerHTML: { __html: CSS } }),
        error ? React.createElement('span', { className: 'rsww-error' }, error) : null,
        mine.length === 0 ? EmptyState({ title: '本会话还没有运行记录', hint: '在若水模式下发送需求后,编排进度会实时出现在这里。' }) : null,
        running.length ? group('进行中', running.length + ' 次', running) : null,
        settled.length ? group('已落定', '近 ' + settled.length + ' 次', settled) : null)
    }

    // 页签切换:宿主 selectView face 未下发 header.actions 子槽(实测),官方 face 到位即走;
    // 兜底=按 a11y role 精确匹配宿主页签按钮,不可达静默
    function FlowChip({ selectView }) {
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
      const open = () => {
        if (selectView) { selectView(VIEW_ID); return }
        try {
          const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent === '若水编排')
          if (tab) tab.click()
        } catch { /* 页签不可达:静默 */ }
      }
      return React.createElement('button', { className: 'rsww-chip rsww-chip--live', onClick: open, title: '查看若水编排' },
        React.createElement('span', { className: 'rsww-chip__dot' }),
        '若水编排 ' + live.length + ' 运行中')
    }

    // ── 设置页共享件:pill 组/行编辑/钳制(gui-center/gui-editor/gui-config 同源) ──
    const h = React.createElement
    const SLOT_KEYS = ['planner', 'executor', 'reviewer', 'executor-loop', 'reviewer-approve', 'executor-escalate']
    const BUDGET_KEYS = ['maxStepFail', 'approveRounds', 'escalateLimit']
    const BUDGET_MIN = 1
    const BUDGET_MAX = 10

    function PillGroup({ value, options, onChange, tab, ariaLabel }) {
      return h('div', { className: 'rsww-pills', role: tab ? 'tablist' : undefined, 'aria-label': ariaLabel },
        options.map((o) => h('button', {
          key: o.key, type: 'button', role: tab ? 'tab' : undefined,
          className: 'rsww-pill' + (value === o.key ? ' rsww-pill--on' : ''),
          'aria-pressed': value === o.key, onClick: () => onChange(o.key),
        }, o.label)))
    }

    function clampRange(v, min, max) {
      const n = Math.round(Number(v))
      if (!Number.isFinite(n)) return min
      return Math.min(max, Math.max(min, n))
    }

    // 键值行编辑(顶层 inputs/outputs/flow input/续跑 inputs 同款);空名行在序列化侧剔除
    function KvRows({ rows, onChange, kPh, vPh, kMono }) {
      const set = (i, part, v) => onChange(rows.map((r, j) => (j === i ? { k: r.k, v: r.v, [part]: v } : r)))
      return h('div', { className: 'rsww-kv' },
        rows.map((r, i) => h('div', { className: 'rsww-kv__row', key: i },
          h('input', { className: 'rsww-input' + (kMono ? ' rsww-mono' : ''), value: r.k, placeholder: kPh, onChange: (e) => set(i, 'k', e.target.value) }),
          h('input', { className: 'rsww-input rsww-input--wide', value: r.v, placeholder: vPh, onChange: (e) => set(i, 'v', e.target.value) }),
          h('button', { className: 'rsww-btn', type: 'button', onClick: () => onChange(rows.filter((_, j) => j !== i)) }, '删除'))),
        h('button', { className: 'rsww-btn', type: 'button', onClick: () => onChange(rows.concat({ k: '', v: '' })) }, '添加一行'))
    }

    function StrRows({ items, onChange, ph, min }) {
      return h('div', { className: 'rsww-kv' },
        items.map((v, i) => h('div', { className: 'rsww-kv__row', key: i },
          h('input', { className: 'rsww-input rsww-mono rsww-input--wide', value: v, placeholder: ph, onChange: (e) => onChange(items.map((x, j) => (j === i ? e.target.value : x))) }),
          h('button', { className: 'rsww-btn', type: 'button', disabled: min !== undefined && items.length <= min, onClick: () => onChange(items.filter((_, j) => j !== i)) }, '删除'))),
        h('button', { className: 'rsww-btn', type: 'button', onClick: () => onChange(items.concat('')) }, '添加一行'))
    }

    // 危险操作两段确认(armed 超时自动解除)
    function ArmedButton({ label, confirmLabel, onConfirm, disabled }) {
      const [armed, setArmed] = useState(false)
      useEffect(() => {
        if (!armed) return undefined
        const t = setTimeout(() => setArmed(false), ARMED_TIMEOUT_MS)
        return () => clearTimeout(t)
      }, [armed])
      return h('button', { className: 'rsww-btn rsww-btn--danger', type: 'button', disabled: disabled || undefined,
        onClick: () => { if (armed) { setArmed(false); onConfirm() } else setArmed(true) } }, armed ? confirmLabel : label)
    }

    // ── run 终态操作与重跑/续跑选择器(gui-session 卡片内使用) ──
    const STEP_TONES = { pending: 'mute', running: 'business', done: 'success', failed: 'error', skipped: 'mute' }
    const STEP_STATUS_LABELS = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败', skipped: '已跳过' }

    function StepBadge({ status }) {
      return h(Badge, { tone: STEP_TONES[status] || 'mute' }, STEP_STATUS_LABELS[status] || status || '-')
    }

    function ResumePicker({ detail, init, onClose, onResumed }) {
      const macroAll = (detail.state && detail.state.steps) || {}
      const ids = Object.keys(macroAll)
      const breakpoint = ids.find((id) => macroAll[id] && macroAll[id].status !== 'done') || ''
      const radioName = 'rsww-resume-' + detail.runId
      const [sel, setSel] = useState(init === 'resume' ? breakpoint : '')
      const [rows, setRows] = useState(() => Object.entries(detail.inputs || {}).map(([k, v]) => ({ k, v: String(v) })))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [newRunId, setNewRunId] = useState('')
      const confirm = async () => {
        setBusy(true); setError('')
        const inputs = {}
        for (const r of rows) if (r.k.trim() !== '' && r.v.trim() !== '') inputs[r.k.trim()] = r.v
        const body = { runId: detail.runId }
        if (sel !== '') body.fromStepId = sel
        if (Object.keys(inputs).length > 0) body.inputs = inputs
        const o = await post('resume-from', body)
        setBusy(false)
        if (!o.ok) { setError(o.error); return }
        setNewRunId((o.data && o.data.runId) || '')
        onResumed()
      }
      return h('div', { className: 'rsww-card rsww-stack' },
        h('div', { className: 'rsww-row' },
          h('span', { className: 'rsww-label' }, '重跑/续跑'),
          h('span', { className: 'rsww-note' }, 'inputs 留空 = 不覆盖;成功后生成新 run,已完成步骤作种子')),
        h('label', { className: 'rsww-tree__row' },
          h('input', { type: 'radio', name: radioName, checked: sel === '', onChange: () => setSel('') }),
          h('span', { className: 'rsww-text' }, '从头重跑(不携带 fromStepId)')),
        ids.map((id) => h('label', { className: 'rsww-tree__row', key: id },
          h('input', { type: 'radio', name: radioName, checked: sel === id, onChange: () => setSel(id) }),
          h('span', { className: 'rsww-mono' }, id),
          h(StepBadge, { status: macroAll[id] && macroAll[id].status }),
          id === breakpoint ? h('span', { className: 'rsww-note' }, '断点') : null)),
        h(KvRows, { rows, onChange: setRows, kPh: 'input 名', vPh: '值(留空该行不覆盖)', kMono: true }),
        error ? h('span', { className: 'rsww-error' }, error) : null,
        newRunId ? h('span', { className: 'rsww-text' }, '新 run:', h('span', { className: 'rsww-mono' }, ' ' + newRunId)) : null,
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', onClick: confirm, disabled: busy }, busy ? '提交中' : '确认'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: onClose }, '关闭')))
    }

    // 终态操作行:重跑/断点续跑/删除(RunCard 落定卡内嵌;删除成功经 onRemoved 通知列表刷新)
    function DetailActions({ detail, onReload, onRemoved }) {
      const [picker, setPicker] = useState('')
      const [error, setError] = useState('')
      const remove = async () => {
        setError('')
        const o = await post('run-remove', { runId: detail.runId })
        if (!o.ok) { setError(/404/.test(o.error) ? '宿主不支持删除路由(404),记录保留' : o.error); return }
        onRemoved()
      }
      return h('div', { className: 'rsww-section' },
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', onClick: () => setPicker(picker === 'rerun' ? '' : 'rerun') }, '重跑'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: () => setPicker(picker === 'resume' ? '' : 'resume') }, '断点续跑'),
          h(ArmedButton, { label: '删除', confirmLabel: '确认删除', onConfirm: remove })),
        error ? h('span', { className: 'rsww-error' }, error) : null,
        picker !== '' ? h(ResumePicker, { detail, init: picker, onClose: () => setPicker(''), onResumed: onReload }) : null)
    }

    // ── gui-editor 模板编辑器:权威态=编辑模型,文本派生+显式应用(host dryRun 权威校验) ──
    const TYPE_OPTIONS = [{ key: 'ai', label: '普通' }, { key: 'approve', label: 'approve' }, { key: 'flow', label: 'flow' }]
    const MODE_OPTIONS = [{ key: 'sequential', label: '顺序' }, { key: 'parallel', label: '并行' }]
    const TEMPLATE_ID_RE = /^[a-z][a-z0-9-]*$/
    const asStr = (v) => (typeof v === 'string' ? v : '')
    const asArr = (v) => (Array.isArray(v) ? v.slice() : [])
    const objToRows = (v) => Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).map(([k, x]) => ({ k, v: typeof x === 'string' ? x : JSON.stringify(x) }))
    const rowsToObj = (rows) => Object.fromEntries((rows || []).filter((r) => r.k.trim() !== '').map((r) => [r.k.trim(), r.v]))
    const outNamesOf = (s) => s.outputs.map((r) => r.k.trim()).filter((n) => n !== '')

    const newStep = () => ({ id: '', label: '', type: 'ai', slot: '', prompt: '', outputs: [], listOutputs: [], load: [], after: [], maxFail: '', for_each: '', mode: '', target: '', rounds: '', onExhausted: '', flow: '', input: [] })

    function normalizeStep(s) {
      const base = newStep()
      if (!s || typeof s !== 'object') return base
      return {
        ...base,
        id: asStr(s.id), label: asStr(s.label),
        type: ['ai', 'approve', 'flow'].includes(s.type) ? s.type : 'ai',
        slot: asStr(s.slot), prompt: asStr(s.prompt),
        outputs: objToRows(s.outputs), listOutputs: asArr(s.listOutputs), load: asArr(s.load), after: asArr(s.after),
        maxFail: Number.isInteger(s.maxFail) ? s.maxFail : '',
        for_each: asStr(s.for_each), mode: asStr(s.mode),
        target: asStr(s.target), rounds: Number.isInteger(s.rounds) ? s.rounds : '',
        onExhausted: asStr(s.onExhausted), flow: asStr(s.flow), input: objToRows(s.input),
      }
    }

    // 序列化裁剪:空值省略;type=ai 省略(type 缺省即 ai);enabled 不入文(校验器禁)
    function stepOut(s) {
      const o = { id: s.id }
      if (s.label !== '') o.label = s.label
      if (s.type !== 'ai') o.type = s.type
      if (s.slot !== '') o.slot = s.slot
      if (s.type !== 'flow' && s.prompt !== '') o.prompt = s.prompt
      if (s.after.length > 0) o.after = s.after
      if (s.type === 'ai') {
        if (outNamesOf(s).length > 0) o.outputs = rowsToObj(s.outputs)
        if (s.listOutputs.length > 0) o.listOutputs = s.listOutputs
        if (s.load.length > 0) o.load = s.load
        if (s.maxFail !== '') o.maxFail = Number(s.maxFail)
        if (s.for_each !== '') { o.for_each = s.for_each; o.mode = s.mode === 'parallel' ? 'parallel' : 'sequential' }
      }
      if (s.type === 'approve') {
        if (s.target !== '') o.target = s.target
        if (s.rounds !== '') o.rounds = Number(s.rounds)
        if (s.onExhausted !== '') o.onExhausted = s.onExhausted
      }
      if (s.type === 'flow') {
        if (s.flow !== '') o.flow = s.flow
        if (s.input.some((r) => r.k.trim() !== '')) o.input = rowsToObj(s.input)
      }
      return o
    }

    function serializeModel(m) {
      return JSON.stringify({
        id: m.id,
        ...(m.label !== '' ? { label: m.label } : {}),
        ...(m.description !== '' ? { description: m.description } : {}),
        ...(m.inputs.some((r) => r.k.trim() !== '') ? { inputs: rowsToObj(m.inputs) } : {}),
        steps: m.steps.map(stepOut),
      }, null, 2)
    }

    // 文本可 JSON.parse 即建全模型;否则文本模式(synced=false,结构表单锁定,应用后回填)。
    // 副本条目(id 空)仅继承结构,meta(id/label/description)由用户重填,防覆盖原模板
    function modelFromEntry(entry) {
      let parsed = null
      try { parsed = JSON.parse(entry.json5) } catch { parsed = null }
      const meta = { id: entry.id || '', label: asStr(entry.label) || entry.id || '', description: asStr(entry.description), enabled: entry.enabled !== false }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { model: { ...meta, inputs: [], steps: [] }, text: entry.json5, synced: false }
      }
      const model = {
        id: meta.id !== '' ? (asStr(parsed.id) || meta.id) : '',
        label: meta.id !== '' ? (asStr(parsed.label) || meta.label) : meta.label,
        description: meta.id !== '' ? (asStr(parsed.description) || meta.description) : meta.description,
        enabled: meta.enabled,
        inputs: objToRows(parsed.inputs),
        steps: asArr(parsed.steps).map(normalizeStep),
      }
      return { model, text: serializeModel(model), synced: true }
    }

    // 前端即时校验(保存/应用前);step: 空 id 的错误平铺展示
    function clientErrors(m) {
      const errs = []
      if (!TEMPLATE_ID_RE.test(m.id || '')) errs.push({ target: 'top:id', message: 'id 必填且匹配 ^[a-z][a-z0-9-]*$' })
      if (m.steps.length === 0) errs.push({ target: 'top:steps', message: '至少一个步骤' })
      const seen = new Set()
      for (const s of m.steps) {
        const at = s.id !== '' ? 'step:' + s.id : 'step:'
        if (!TEMPLATE_ID_RE.test(s.id || '')) errs.push({ target: at, message: '步骤 id 必填且匹配 ^[a-z][a-z0-9-]*$' })
        else if (seen.has(s.id)) errs.push({ target: at, message: '步骤 id 重复:' + s.id })
        if (s.id !== '') seen.add(s.id)
        if (s.type !== 'flow' && s.prompt.trim() === '') errs.push({ target: at, message: (s.id || '未命名步骤') + ':prompt 必填' })
        if (s.type === 'ai' && outNamesOf(s).length === 0) errs.push({ target: at, message: (s.id || '未命名步骤') + ':outputs 产出契约必填' })
        if (s.type === 'approve' && s.target === '') errs.push({ target: at, message: (s.id || '未命名步骤') + ':approve 步骤 target 必填' })
        if (s.type === 'flow' && s.flow.trim() === '') errs.push({ target: at, message: (s.id || '未命名步骤') + ':flow 必填' })
      }
      return errs
    }

    const stripForType = (s) => {
      if (s.type === 'approve') return { ...s, outputs: [], listOutputs: [], load: [], for_each: '', mode: '', flow: '', input: [] }
      if (s.type === 'flow') return { ...s, prompt: '', outputs: [], listOutputs: [], load: [], for_each: '', mode: '', target: '', rounds: '', onExhausted: '' }
      return { ...s, target: '', rounds: '', onExhausted: '', flow: '', input: [] }
    }

    function MetaForm({ model, update, synced, topErr }) {
      const idErrs = topErr('id')
      const field = (label, key, mono, disabled) => h('div', { className: 'rsww-kv__row' },
        h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, label),
        h('input', { className: 'rsww-input' + (mono ? ' rsww-mono' : '') + ' rsww-input--wide' + (key === 'id' && idErrs.length > 0 ? ' rsww-input--err' : ''),
          value: model[key], disabled: disabled || undefined, onChange: (e) => update((m) => ({ ...m, [key]: e.target.value })) }))
      return h('div', { className: 'rsww-kv' },
        field('id', 'id', true, false),
        idErrs.map((e, i) => h('span', { className: 'rsww-error', key: i }, e.message)),
        field('显示名', 'label', false, false),
        field('说明', 'description', false, false),
        h(Switch, { checked: model.enabled, onChange: (e) => update((m) => ({ ...m, enabled: e.target.checked })), label: '启用(禁用后不可释放、重跑不可选)', ariaLabel: '启用模板' }),
        synced ? null : h('span', { className: 'rsww-note' }, '此模板文本含 JSON5 扩展语法,结构表单锁定:请在文本视图点「应用」,经 host 校验通过后回填。'))
    }

    function InputsForm({ model, update, topErr }) {
      const errs = topErr('inputs')
      return h('div', { className: 'rsww-section' },
        h('span', { className: 'rsww-label' }, '顶层 inputs(prompt 内 {input.name} 引用)'),
        errs.map((e, i) => h('span', { className: 'rsww-error', key: i }, e.message)),
        h(KvRows, { rows: model.inputs, onChange: (rows) => update((m) => ({ ...m, inputs: rows })), kPh: 'name', vPh: '说明', kMono: true }))
    }

    function ListOutSelect({ step, onChange }) {
      const names = outNamesOf(step)
      if (names.length === 0) return h('span', { className: 'rsww-note' }, 'listOutputs:先声明 outputs 后可选列表字段')
      const toggle = (n) => onChange({ ...step, listOutputs: step.listOutputs.includes(n) ? step.listOutputs.filter((x) => x !== n) : step.listOutputs.concat(n) })
      return h('div', { className: 'rsww-section' },
        h('span', { className: 'rsww-label' }, 'listOutputs(列表型产出,供 for_each 引用)'),
        names.map((n) => h('label', { className: 'rsww-switch', key: n },
          h('input', { type: 'checkbox', checked: step.listOutputs.includes(n), onChange: () => toggle(n), 'aria-label': n }),
          h('span', { className: 'rsww-switch__track' }, h('span', { className: 'rsww-switch__thumb' })),
          h('span', { className: 'rsww-mono' }, n))))
    }

    function AfterSelect({ step, otherIds, onChange }) {
      if (otherIds.length === 0) return h('span', { className: 'rsww-note' }, 'after:暂无其他步骤可选')
      const toggle = (id) => onChange({ ...step, after: step.after.includes(id) ? step.after.filter((x) => x !== id) : step.after.concat(id) })
      return h('div', { className: 'rsww-section' },
        h('span', { className: 'rsww-label' }, 'after(前置步骤;缺省=文档序前一步)'),
        otherIds.map((id) => h('label', { className: 'rsww-switch', key: id },
          h('input', { type: 'checkbox', checked: step.after.includes(id), onChange: () => toggle(id), 'aria-label': id }),
          h('span', { className: 'rsww-switch__track' }, h('span', { className: 'rsww-switch__thumb' })),
          h('span', { className: 'rsww-mono' }, id))))
    }

    function ForEachRow({ step, sources, onChange }) {
      return h('div', { className: 'rsww-section' },
        h('div', { className: 'rsww-kv__row' },
          h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, 'for_each'),
          h('select', { className: 'rsww-input', value: step.for_each, onChange: (e) => onChange({ ...step, for_each: e.target.value }) },
            h('option', { value: '' }, '(不循环)'),
            sources.map((o) => h('option', { key: o, value: o }, o)))),
        step.for_each !== '' ? h('div', { className: 'rsww-kv__row' },
          h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, 'mode'),
          h(PillGroup, { value: step.mode === 'parallel' ? 'parallel' : 'sequential', options: MODE_OPTIONS, onChange: (v) => onChange({ ...step, mode: v }), ariaLabel: '循环模式' })) : null)
    }

    function ApproveForm({ step, otherIds, onChange }) {
      return h('div', { className: 'rsww-stack' },
        h('div', { className: 'rsww-kv__row' },
          h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, 'target'),
          h('select', { className: 'rsww-input', value: step.target, onChange: (e) => onChange({ ...step, target: e.target.value }) },
            h('option', { value: '' }, '(必选:被审批步骤)'),
            otherIds.map((id) => h('option', { key: id, value: id }, id)))),
        h('div', { className: 'rsww-kv__row' },
          h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, 'rounds'),
          h('input', { className: 'rsww-input', type: 'number', value: step.rounds, placeholder: '留空=预算 approveRounds',
            onChange: (e) => onChange({ ...step, rounds: e.target.value === '' ? '' : Number(e.target.value) }),
            onBlur: () => { if (step.rounds !== '') onChange({ ...step, rounds: clampRange(step.rounds, BUDGET_MIN, BUDGET_MAX) }) } })),
        h('div', { className: 'rsww-kv__row' },
          h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, 'onExhausted'),
          h('select', { className: 'rsww-input', value: step.onExhausted, onChange: (e) => onChange({ ...step, onExhausted: e.target.value }) },
            h('option', { value: '' }, '(缺省 blocked)'),
            h('option', { value: 'blocked' }, 'blocked'),
            otherIds.map((id) => h('option', { key: id, value: id }, id)))))
    }

    function FlowForm({ step, templates, onChange }) {
      return h('div', { className: 'rsww-stack' },
        h('div', { className: 'rsww-kv__row' },
          h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, 'flow'),
          h('input', { className: 'rsww-input rsww-mono rsww-input--wide', list: 'rsww-tmpl-ids', value: step.flow,
            placeholder: '模板 id 或 {步骤.产出}', onChange: (e) => onChange({ ...step, flow: e.target.value }) })),
        h('div', { className: 'rsww-section' },
          h('span', { className: 'rsww-label' }, 'input(子流程入参,单占位符引用)'),
          h(KvRows, { rows: step.input, onChange: (rows) => onChange({ ...step, input: rows }), kPh: '入参名', vPh: '{步骤.产出}', kMono: true })))
    }

    function StepCard({ step, index, model, errors, onChange, onRemove }) {
      const [openSelf, setOpenSelf] = useState(false)
      const [adv, setAdv] = useState(false)
      const open = openSelf || errors.length > 0
      const otherIds = [...new Set(model.steps.map((s) => s.id).filter((id) => id !== '' && id !== step.id))]
      const sources = []
      for (const s of model.steps) {
        if (s.id !== '' && s.id !== step.id && s.type === 'ai') for (const out of s.listOutputs) sources.push(s.id + '.' + out)
      }
      const row = (label, control) => h('div', { className: 'rsww-kv__row' },
        h('span', { className: 'rsww-label', style: { width: 64, flex: 'none' } }, label), control)
      return h('div', { className: 'rsww-card' + (errors.length > 0 ? ' rsww-card--err' : '') },
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', style: { padding: '2px 8px' }, onClick: () => setOpenSelf(!openSelf) },
            (open ? '收起 ' : '展开 ') + (step.id !== '' ? step.id : '#' + (index + 1))),
          h(Badge, { tone: 'mute' }, (TYPE_OPTIONS.find((t) => t.key === step.type) || TYPE_OPTIONS[0]).label),
          h('span', { style: { flex: 1 } }),
          h(ArmedButton, { label: '删除步骤', confirmLabel: '确认删除', onConfirm: onRemove })),
        errors.map((e, i) => h('span', { className: 'rsww-error', key: i }, e.message)),
        !open ? null : h('div', { className: 'rsww-stack' },
          row('类型', h(PillGroup, { value: step.type, options: TYPE_OPTIONS, onChange: (t) => onChange(stripForType({ ...step, type: t })), ariaLabel: '步骤类型' })),
          row('id', h('input', { className: 'rsww-input rsww-mono rsww-input--wide', value: step.id, placeholder: '步骤 id(小写字母开头)', onChange: (e) => onChange({ ...step, id: e.target.value }) })),
          row('显示名', h('input', { className: 'rsww-input rsww-input--wide', value: step.label, placeholder: '可空', onChange: (e) => onChange({ ...step, label: e.target.value }) })),
          step.type !== 'approve' ? row('slot', h('select', { className: 'rsww-input', value: step.slot, onChange: (e) => onChange({ ...step, slot: e.target.value }) },
            h('option', { value: '' }, '(引擎缺省)'), SLOT_KEYS.map((k) => h('option', { key: k, value: k }, k)))) : null,
          step.type !== 'flow' ? row('prompt', h('textarea', { className: 'rsww-textarea', value: step.prompt, rows: 4,
            placeholder: '指令全文;占位符 {request}/{input.x}/{步骤.产出}{item}', onChange: (e) => onChange({ ...step, prompt: e.target.value }) })) : null,
          step.type === 'ai' ? h('div', { className: 'rsww-section' },
            h('span', { className: 'rsww-label' }, 'outputs 产出契约'),
            h(KvRows, { rows: step.outputs, onChange: (rows) => onChange({ ...step, outputs: rows }), kPh: '字段名', vPh: '说明(结构化产出口径)', kMono: true })) : null,
          step.type === 'ai' ? h(ListOutSelect, { step, onChange }) : null,
          step.type === 'approve' ? h(ApproveForm, { step, otherIds, onChange }) : null,
          step.type === 'flow' ? h(FlowForm, { step, onChange }) : null,
          h('div', {},
            h('button', { className: 'rsww-btn', type: 'button', onClick: () => setAdv(!adv) }, adv ? '收起高级' : '高级字段(after/for_each/load/maxFail)'),
            !adv ? null : h('div', { className: 'rsww-stack', style: { marginTop: 6 } },
              h(AfterSelect, { step, otherIds, onChange }),
              step.type === 'ai' ? h(ForEachRow, { step, sources, onChange }) : null,
              step.type === 'ai' ? h('div', { className: 'rsww-section' },
                h('span', { className: 'rsww-label' }, 'load 资源'),
                h(StrRows, { items: step.load, onChange: (items) => onChange({ ...step, load: items }), ph: 'skill:name 或 doc:name' })) : null,
              step.type === 'ai' ? row('maxFail', h('input', { className: 'rsww-input', type: 'number', value: step.maxFail, placeholder: '留空=预算 maxStepFail',
                onChange: (e) => onChange({ ...step, maxFail: e.target.value === '' ? '' : Number(e.target.value) }),
                onBlur: () => { if (step.maxFail !== '') onChange({ ...step, maxFail: clampRange(step.maxFail, BUDGET_MIN, BUDGET_MAX) }) } })) : null))))
    }

    function StepsForm({ model, update, allErrors }) {
      const setSteps = (steps) => update((m) => ({ ...m, steps }))
      return h('div', { className: 'rsww-stack' },
        model.steps.map((s, i) => h(StepCard, {
          key: i, step: s, index: i, model,
          errors: allErrors.filter((e) => s.id !== '' && e.target === 'step:' + s.id),
          onChange: (next) => setSteps(model.steps.map((x, j) => (j === i ? next : x))),
          onRemove: () => setSteps(model.steps.filter((_, j) => j !== i)),
        })),
        h('button', { className: 'rsww-btn', type: 'button', onClick: () => setSteps(model.steps.concat(newStep())) }, '添加步骤'))
    }

    function Json5Pane({ text, setText, onApply, onValidate, jsonErrs, saving }) {
      return h('div', { className: 'rsww-stack' },
        h('textarea', { className: 'rsww-textarea', value: text, rows: 18, spellCheck: false, onChange: (e) => setText(e.target.value) }),
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', onClick: onApply, disabled: saving }, '应用(校验并回填表单)'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: onValidate, disabled: saving }, '校验')),
        jsonErrs.map((e, i) => h('span', { className: 'rsww-error', key: i },
          typeof e.line === 'number' ? '行 ' + e.line + ':' + e.message : e.message)))
    }

    function TemplateEditor({ entry, isNew, templates, onClose, onSaved }) {
      const init = isNew
        ? { model: { id: '', label: '', description: '', enabled: true, inputs: [], steps: [newStep()] }, text: '', synced: true }
        : modelFromEntry(entry)
      const [model, setModel] = useState(init.model)
      const [text, setText] = useState(() => init.text !== '' ? init.text : serializeModel(init.model))
      const [synced, setSynced] = useState(init.synced)
      const [view, setView] = useState(init.synced ? 'struct' : 'json')
      const [saveErrors, setSaveErrors] = useState([])
      const [saving, setSaving] = useState(false)
      const [note, setNote] = useState('')
      // 未回填(文本模式)时表单编辑不重写文本,json5 正文始终权威
      const update = (fn) => {
        if (!synced) { setModel((prev) => fn(prev)); return }
        setModel((prev) => {
          const next = fn(prev)
          setText(serializeModel(next))
          return next
        })
      }
      const errsOf = (o) => (o.data && Array.isArray(o.data.errors) && o.data.errors.length > 0 ? o.data.errors : [{ target: 'json', message: o.error }])
      const allErrors = clientErrors(model).filter(() => synced).concat(saveErrors)
      const topErr = (field) => allErrors.filter((e) => e.target === 'top:' + field)
      const jsonErrs = allErrors.filter((e) => e.target === 'json')
      const flatErrs = allErrors.filter((e) => e.target === 'step:')
      const dryRun = async () => {
        setSaving(true); setNote(''); setSaveErrors([])
        const o = await post('template-save', { id: model.id, label: model.label, description: model.description, enabled: model.enabled, json5: text, dryRun: true })
        setSaving(false)
        if (!o.ok) { setSaveErrors(errsOf(o)); return null }
        return true
      }
      const applyText = async () => {
        if (await dryRun() === null) { setNote('校验失败,文本与表单均未修改'); return }
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setNote('校验通过;文本含 JSON5 扩展语法,表单未回填(保存仍以文本为准)')
          return
        }
        const m = {
          id: asStr(parsed.id) || model.id,
          label: asStr(parsed.label), description: asStr(parsed.description),
          enabled: model.enabled, inputs: objToRows(parsed.inputs),
          steps: asArr(parsed.steps).map(normalizeStep),
        }
        setModel(m); setText(serializeModel(m)); setSynced(true)
        setNote('已应用:表单按文本回填')
      }
      const validateText = async () => {
        if (await dryRun() !== null) setNote('校验通过(未落盘)')
        else setNote('校验失败')
      }
      const doSave = async (andRelease) => {
        setNote(''); setSaveErrors([])
        const local = synced ? clientErrors(model) : []
        if (local.length > 0) { setSaveErrors(local); return }
        setSaving(true)
        const o = await post('template-save', { id: model.id, label: model.label, description: model.description, enabled: model.enabled, json5: text })
        if (!o.ok) { setSaving(false); setSaveErrors(errsOf(o)); setNote('保存被拒绝'); return }
        if (!andRelease) { setSaving(false); onSaved(''); return }
        const r = await post('release', { id: model.id })
        setSaving(false)
        onSaved(r.ok ? '' : '已保存;释放失败:' + r.error)
      }
      return h('div', { className: 'rsww-detail' },
        h('div', { className: 'rsww-row' },
          h('span', { className: 'rsww-label' }, isNew ? '新建模板' : '编辑模板'),
          h('span', { className: 'rsww-mono' }, isNew ? '(未保存)' : entry.id || '(副本:待定 id)'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'rsww-btn', type: 'button', onClick: onClose }, '关闭')),
        h('datalist', { id: 'rsww-tmpl-ids' }, templates.map((t) => h('option', { key: t.id, value: t.id }))),
        h(MetaForm, { model, update, synced, topErr }),
        synced ? h(InputsForm, { model, update, topErr }) : null,
        h(PillGroup, { tab: true, ariaLabel: '视图', value: view, options: [{ key: 'struct', label: '结构' }, { key: 'json', label: 'JSON5' }], onChange: setView }),
        view === 'struct'
          ? (synced ? h(StepsForm, { model, update, allErrors }) : h('span', { className: 'rsww-note' }, '结构表单已锁定:先在 JSON5 视图点「应用」回填。'))
          : h(Json5Pane, { text, setText, onApply: applyText, onValidate: validateText, jsonErrs, saving }),
        flatErrs.map((e, i) => h('span', { className: 'rsww-error', key: 'flat' + i }, e.message)),
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', onClick: () => doSave(false), disabled: saving }, '保存'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: () => doSave(true), disabled: saving }, '保存并释放'),
          note ? h('span', { className: 'rsww-note' }, note) : null))
    }

    function TemplateCard({ t, released, busy, onView, onEdit, onCopy, onRelease, onUnrelease, onDelete }) {
      const builtin = t.builtin === true
      const disabled = t.enabled === false
      return h('div', { className: 'rsww-card' },
        h('div', { className: 'rsww-row' },
          h('span', { className: 'rsww-text', style: { fontWeight: 600 } }, t.label || t.id),
          h('span', { className: 'rsww-mono rsww-note' }, t.id),
          builtin ? h(Badge, { tone: 'business' }, '内置') : null,
          disabled ? h(Badge, { tone: 'mute' }, '已禁用') : null,
          released.includes(t.id) ? h(Badge, { tone: 'success' }, '已释放') : null),
        t.description ? h('span', { className: 'rsww-note' }, t.description) : null,
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', disabled: busy || undefined, onClick: onView }, '详情'),
          builtin
            ? h('button', { className: 'rsww-btn', type: 'button', disabled: busy || undefined, onClick: onCopy }, '另存为副本')
            : h('button', { className: 'rsww-btn', type: 'button', disabled: busy || undefined, onClick: onEdit }, '编辑'),
          !builtin && !disabled ? (released.includes(t.id)
            ? h('button', { className: 'rsww-btn', type: 'button', disabled: busy || undefined, onClick: onUnrelease }, '撤下模式')
            : h('button', { className: 'rsww-btn', type: 'button', disabled: busy || undefined, onClick: onRelease }, '更新到 dsh')) : null,
          h(ArmedButton, { label: builtin ? '禁用' : '删除', confirmLabel: builtin ? '确认禁用' : '确认删除', disabled: busy, onConfirm: onDelete })))
    }

    // ── 只读详情弹窗:所有模板可点开;结构视图(JSON.parse 可达时)+JSON5 原文+一键检验 ──
    function Modal({ title, onClose, children }) {
      return h('div', { className: 'rsww-modal', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'rsww-modal__panel', role: 'dialog', 'aria-label': title },
          h('div', { className: 'rsww-row' },
            h('span', { className: 'rsww-head__title' }, title),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'rsww-btn', type: 'button', onClick: onClose }, '关闭')),
          children))
    }

    function ViewerStep({ step }) {
      const [open, setOpen] = useState(false)
      const typeName = (TYPE_OPTIONS.find((t) => t.key === step.type) || TYPE_OPTIONS[0]).label
      const row = (label, text) => (text !== '' && text != null) ? h('div', { className: 'rsww-kv__row' },
        h('span', { className: 'rsww-label', style: { width: 84, flex: 'none' } }, label),
        h('span', { className: 'rsww-text', style: { whiteSpace: 'pre-wrap' } }, String(text))) : null
      const kvRows = (rows) => h('div', { className: 'rsww-kv' },
        rows.map((kv, i) => h('div', { className: 'rsww-kv__row', key: i },
          h('span', { className: 'rsww-mono' }, kv.k),
          kv.v ? h('span', { className: 'rsww-note' }, kv.v) : null)))
      return h('div', { className: 'rsww-card' },
        h('div', { className: 'rsww-row' },
          h('button', { className: 'rsww-btn', type: 'button', style: { padding: '2px 8px' }, onClick: () => setOpen(!open) },
            (open ? '收起 ' : '展开 ') + (step.id !== '' ? step.id : '#')),
          h(Badge, { tone: 'mute' }, typeName),
          step.type === 'ai' && outNamesOf(step).length > 0 ? h('span', { className: 'rsww-note' }, outNamesOf(step).join('/')) : null),
        !open ? null : h('div', { className: 'rsww-stack' },
          row('显示名', step.label),
          row('slot', step.slot),
          step.type !== 'flow' ? row('prompt', step.prompt) : null,
          step.type === 'ai' && step.outputs.length > 0 ? h('div', { className: 'rsww-section' },
            h('span', { className: 'rsww-label' }, 'outputs 产出契约'),
            kvRows(step.outputs),
            step.listOutputs.length > 0 ? h('span', { className: 'rsww-note' }, 'listOutputs: ' + step.listOutputs.join(', ')) : null) : null,
          step.type === 'approve' ? h('div', { className: 'rsww-stack' },
            row('target', step.target), row('rounds', step.rounds), row('onExhausted', step.onExhausted || '(缺省 blocked)')) : null,
          step.type === 'flow' ? h('div', { className: 'rsww-stack' },
            row('flow', step.flow),
            step.input.length > 0 ? h('div', { className: 'rsww-section' },
              h('span', { className: 'rsww-label' }, 'input(子流程入参)'), kvRows(step.input)) : null) : null,
          step.after.length > 0 ? row('after', step.after.join(', ')) : null,
          step.for_each !== '' ? h('div', { className: 'rsww-stack' },
            row('for_each', step.for_each), row('mode', step.mode === 'parallel' ? 'parallel' : 'sequential')) : null,
          step.load.length > 0 ? row('load', step.load.join(', ')) : null,
          step.maxFail !== '' ? row('maxFail', step.maxFail) : null))
    }

    function TemplateViewer({ entry, onClose }) {
      const [data, setData] = useState(null)
      const [loadErr, setLoadErr] = useState('')
      const [showJson, setShowJson] = useState(false)
      const [checking, setChecking] = useState(false)
      const [checkNote, setCheckNote] = useState('')
      const [checkErrs, setCheckErrs] = useState([])
      const reload = useCallback(() => request('template?id=' + encodeURIComponent(entry.id)).then((o) => {
        if (o.ok) { setData(o.data); setLoadErr('') } else setLoadErr(o.error)
      }), [entry.id])
      useEffect(() => { reload() }, [reload])
      const validate = async () => {
        setChecking(true); setCheckNote(''); setCheckErrs([])
        const o = await post('template-save', { id: entry.id, label: entry.label, description: entry.description, enabled: entry.enabled !== false, json5: entry.json5, dryRun: true })
        setChecking(false)
        if (o.ok) { setCheckNote('校验通过(未落盘)'); return }
        setCheckErrs(o.data && Array.isArray(o.data.errors) && o.data.errors.length > 0 ? o.data.errors : [{ target: 'json', message: o.error }])
      }
      const parsed = data && data.parsed
      const model = parsed ? { steps: asArr(parsed.steps).map(normalizeStep), inputs: objToRows(parsed.inputs) } : null
      const badge = (tone, text) => h(Badge, { tone }, text)
      return h(Modal, { title: '模板详情', onClose },
        h('div', { className: 'rsww-row' },
          h('span', { className: 'rsww-mono rsww-note' }, entry.id),
          entry.builtin === true ? badge('business', '内置') : null,
          entry.enabled === false ? badge('mute', '已禁用') : null,
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'rsww-btn', type: 'button', onClick: validate, disabled: checking }, checking ? '检验中' : '一键检验'),
          checkNote ? badge('success', checkNote) : null),
        entry.description ? h('span', { className: 'rsww-note' }, entry.description) : null,
        loadErr ? h('span', { className: 'rsww-error' }, loadErr) : null,
        !data && !loadErr ? h('span', { className: 'rsww-note' }, '加载中...') : null,
        checkErrs.map((e, i) => h('span', { className: 'rsww-error', key: i }, (e.target ? e.target + ': ' : '') + e.message)),
        data && !parsed ? h('span', { className: 'rsww-note' }, '模板文本解析失败,仅展示原文与一键检验。') : null,
        model && model.inputs.length > 0 ? h('div', { className: 'rsww-section' },
          h('span', { className: 'rsww-label' }, '顶层 inputs'),
          h('div', { className: 'rsww-kv' },
            model.inputs.map((kv, i) => h('div', { className: 'rsww-kv__row', key: i },
              h('span', { className: 'rsww-mono' }, kv.k),
              kv.v ? h('span', { className: 'rsww-note' }, kv.v) : null)))) : null,
        model ? h('div', { className: 'rsww-section' },
          h('span', { className: 'rsww-label' }, '步骤(' + model.steps.length + ')'),
          model.steps.map((s, i) => h(ViewerStep, { key: i, step: s }))) : null,
        h('div', { className: 'rsww-section' },
          h('div', { className: 'rsww-row' },
            h('button', { className: 'rsww-btn', type: 'button', onClick: () => setShowJson(!showJson) }, showJson ? '收起 JSON5' : 'JSON5 全文'),
            showJson ? h(CopyButton, { text: entry.json5 || '' }) : null),
          showJson ? h('div', { className: 'rsww-full', style: { maxHeight: 300 } }, entry.json5 || '(空)') : null))
    }

    function TemplatesPage() {
      const [templates, setTemplates] = useState(null)
      const [released, setReleased] = useState([])
      const [releasedErr, setReleasedErr] = useState('')
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(null)
      const [viewing, setViewing] = useState(null)
      const [busyId, setBusyId] = useState('')
      const [specOpen, setSpecOpen] = useState(false)
      const [specText, setSpecText] = useState('')
      const [specLoaded, setSpecLoaded] = useState(false)
      const reload = useCallback(async () => {
        const [t, r] = await Promise.all([request('templates'), request('released')])
        if (!t.ok) { setError(t.error); return }
        setTemplates(t.data.templates || [])
        setError('')
        if (r.ok) { setReleased(r.data.ids || []); setReleasedErr('') } else setReleasedErr('已释放列表拉取失败,释放按钮按未释放态渲染')
      }, [])
      useEffect(() => { reload() }, [reload])
      const toggleSpec = async () => {
        const next = !specOpen
        setSpecOpen(next)
        if (next && !specLoaded) {
          const o = await request('spec')
          setSpecText(o.ok ? (o.data.spec || '') : '规范拉取失败:' + o.error)
          setSpecLoaded(o.ok)
        }
      }
      const write = async (path, body) => {
        setBusyId(body.id || '?')
        const o = await post(path, body)
        setBusyId('')
        if (!o.ok) { setError(o.error); return }
        setError('')
        await reload()
      }
      if (templates === null) {
        return h('div', { className: 'rsww-stack' },
          h('span', { className: 'rsww-error' }, error || '加载中...'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: reload }, '重试'))
      }
      const groups = [['内置模板', templates.filter((t) => t.builtin === true)], ['自定义模板', templates.filter((t) => t.builtin !== true)]]
      return h('div', { className: 'rsww-stack' },
        h('div', { className: 'rsww-toolbar' },
          h('button', { className: 'rsww-btn', type: 'button', onClick: () => setEditing({ entry: null, isNew: true }) }, '新建模板'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: toggleSpec }, specOpen ? '收起模板规范' : '模板规范')),
        error ? h('span', { className: 'rsww-error' }, error) : null,
        releasedErr ? h('span', { className: 'rsww-note' }, releasedErr) : null,
        specOpen ? h('div', { className: 'rsww-card' },
          h('div', { className: 'rsww-row' },
            h('span', { className: 'rsww-label' }, '模板规范'),
            specText !== '' && !/^规范拉取失败/.test(specText) ? h(CopyButton, { text: specText }) : null),
          h('div', { className: 'rsww-full', style: { maxHeight: 320 } }, specText !== '' ? specText : '加载中...')) : null,
        editing ? h(TemplateEditor, {
          entry: editing.entry, isNew: editing.isNew, templates,
          onClose: () => setEditing(null),
          onSaved: (err2) => { setEditing(null); reload(); if (err2) setError(err2) },
        }) : null,
        viewing ? h(TemplateViewer, { entry: viewing, onClose: () => setViewing(null) }) : null,
        groups.map(([title, list]) => h('div', { className: 'rsww-group', key: title },
          h('div', { className: 'rsww-group__head' },
            h('span', { className: 'rsww-group__title' }, title),
            h('span', { className: 'rsww-group__count' }, list.length + ' 个')),
          list.map((t) => h(TemplateCard, {
            key: t.id, t, released, busy: busyId === t.id,
            onView: () => setViewing(t),
            onEdit: () => setEditing({ entry: t, isNew: false }),
            onCopy: () => setEditing({ entry: { id: '', label: (t.label || t.id) + ' 副本', description: t.description || '', enabled: true, json5: t.json5, copyOf: t.id }, isNew: false }),
            onRelease: () => write('release', { id: t.id }),
            onUnrelease: () => write('unrelease', { id: t.id }),
            onDelete: () => write('template-remove', { id: t.id }),
          })))))
    }

    // ── gui-config 配置编辑 ─────────────────────────────────────────────────
    // 副文案与常量镜像 lib/settings-schema.mjs(DEFAULT_CONCURRENCY/KEEP_RUNS 为 host 常量)
    const SLOT_INFO = [
      { key: 'planner', name: 'planner 规划位', desc: '大纲/计划/分诊类步骤显式绑定;留空 = 会话默认模型' },
      { key: 'executor', name: 'executor 执行位', desc: '常规步骤缺省绑定;候选失败依次轮换' },
      { key: 'reviewer', name: 'reviewer 审阅位', desc: '审批域通用绑定(approve 步固定 reviewer-approve,不降级至此)' },
      { key: 'executor-loop', name: 'executor-loop 循环位', desc: 'for_each 实例与审批重做批次的缺省绑定' },
      { key: 'reviewer-approve', name: 'reviewer-approve 审批位', desc: 'type:"approve" 步骤固定绑定,模板不可覆盖' },
      { key: 'executor-escalate', name: 'executor-escalate 升级位', desc: 'onExhausted 升级步骤的缺省绑定' },
    ]
    const BUDGET_INFO = [
      { key: 'maxStepFail', name: 'maxStepFail', desc: '步骤连续失败上限;达上限步骤 failed、下游 skipped' },
      { key: 'approveRounds', name: 'approveRounds', desc: 'approve 步骤默认重审轮次;耗尽走 onExhausted' },
      { key: 'escalateLimit', name: 'escalateLimit', desc: 'run 级升级账上限;达上限整流程 blocked' },
    ]
    const DEFAULT_CONCURRENCY = 4
    const KEEP_RUNS = 200

    function normSlotValue(v) {
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim() !== '')
      return typeof v === 'string' && v.trim() !== '' ? v : undefined
    }

    function slotsNorm(slots) {
      const out = {}
      for (const k of SLOT_KEYS) {
        const v = normSlotValue(slots ? slots[k] : undefined)
        if (v !== undefined && v.length !== 0) out[k] = v
      }
      return out
    }

    function budgetsNorm(budgets) {
      const out = {}
      for (const k of BUDGET_KEYS) out[k] = clampRange(budgets ? budgets[k] : '', BUDGET_MIN, BUDGET_MAX)
      return out
    }

    // 形态切换保值:数组→单取首;单→数组包一
    function SlotRow({ info, value, onChange }) {
      const isArr = Array.isArray(value)
      return h('div', { className: 'rsww-card' },
        h('div', { className: 'rsww-row' },
          h('span', { className: 'rsww-text', style: { fontWeight: 600 } }, info.name),
          h(PillGroup, {
            value: isArr ? 'array' : 'single',
            options: [{ key: 'single', label: '单绑定' }, { key: 'array', label: '候选数组' }],
            onChange: (k) => {
              if (k === 'array' && !isArr) onChange([typeof value === 'string' ? value : ''])
              else if (k === 'single' && isArr) onChange(value[0] || '')
            },
            ariaLabel: info.name + ' 取值形态',
          })),
        h('span', { className: 'rsww-note' }, info.desc),
        isArr && value.length > 1 ? h('span', { className: 'rsww-note' }, '切回单绑定将仅保留首个候选') : null,
        !isArr
          ? h('input', { className: 'rsww-input rsww-input--wide', value: typeof value === 'string' ? value : '', placeholder: 'provider/model 或模型名,留空=缺省链', onChange: (e) => onChange(e.target.value) })
          : h(StrRows, { items: value, onChange, ph: 'provider/model 或模型名', min: 1 }))
    }

    function BudgetsForm({ budgets, onChange }) {
      return h('div', { className: 'rsww-section' },
        h('span', { className: 'rsww-label' }, '预算(clamp [1,10],失焦钳制)'),
        BUDGET_INFO.map((b) => h('div', { className: 'rsww-kv__row', key: b.key },
          h('span', { className: 'rsww-label', style: { width: 110, flex: 'none' } }, b.name),
          h('input', { className: 'rsww-input', type: 'number', value: budgets[b.key], min: BUDGET_MIN, max: BUDGET_MAX,
            onChange: (e) => onChange({ ...budgets, [b.key]: e.target.value === '' ? '' : Number(e.target.value) }),
            onBlur: () => onChange({ ...budgets, [b.key]: clampRange(budgets[b.key], BUDGET_MIN, BUDGET_MAX) }) }),
          h('span', { className: 'rsww-note', style: { flex: 1, minWidth: 200 } }, b.desc))))
    }

    function ConfigPage() {
      const [meta, setMeta] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState(false)
      const load = useCallback(async () => {
        const o = await request('config')
        if (!o.ok) { setError(o.error); return }
        const snap = { slots: { ...(o.data.config.slots || {}) }, budgets: { ...(o.data.config.budgets || {}) } }
        setMeta(snap)
        setDraft({ slots: { ...snap.slots }, budgets: { ...snap.budgets } })
        setError('')
      }, [])
      useEffect(() => { load() }, [load])
      if (!meta) {
        return h('div', { className: 'rsww-stack' },
          h('span', { className: 'rsww-error' }, error || '加载中...'),
          error ? h('span', { className: 'rsww-note' }, '配置读取失败:宿主半区可能未装载。') : null,
          h('button', { className: 'rsww-btn', type: 'button', onClick: load }, '重试'))
      }
      const dirty = JSON.stringify(slotsNorm(draft.slots)) !== JSON.stringify(slotsNorm(meta.slots))
        || JSON.stringify(budgetsNorm(draft.budgets)) !== JSON.stringify(budgetsNorm(meta.budgets))
      const save = async () => {
        setSaving(true); setError(''); setSaved(false)
        const o = await post('config-save', { slots: slotsNorm(draft.slots), budgets: budgetsNorm(draft.budgets) })
        setSaving(false)
        if (!o.ok) { setError(o.error); return }
        setSaved(true)
        await load()
      }
      return h('div', { className: 'rsww-stack' },
        h('div', { className: 'rsww-section' },
          h('span', { className: 'rsww-label' }, '工作位(留空 = host 缺省解析)'),
          SLOT_INFO.map((info) => h(SlotRow, {
            key: info.key, info, value: draft.slots[info.key],
            onChange: (v) => setDraft((d) => ({ ...d, slots: { ...d.slots, [info.key]: v } })),
          }))),
        h(BudgetsForm, { budgets: draft.budgets, onChange: (b) => setDraft((d) => ({ ...d, budgets: b })) }),
        h('div', { className: 'rsww-section' },
          h('span', { className: 'rsww-label' }, '常量(不开放配置)'),
          h('span', { className: 'rsww-note' }, '默认并发 ' + DEFAULT_CONCURRENCY + ' · 运行记录保留 ' + KEEP_RUNS + ' 条')),
        h('div', { className: 'rsww-toolbar' },
          dirty ? h(Badge, { tone: 'warn' }, '有未保存修改') : h(Badge, { tone: 'mute' }, '与宿主一致'),
          h('button', { className: 'rsww-btn', type: 'button', onClick: save, disabled: !dirty || saving }, saving ? '保存中' : '保存'),
          saved ? h('span', { className: 'rsww-note' }, '已保存并复核') : null,
          error ? h('span', { className: 'rsww-error' }, error) : null))
    }

    // ── section 壳:标题/说明/子页 pill(模板默认;运行记录唯一视图=会话页签) ──
    function RswwApp() {
      const [page, setPage] = useState('templates')
      const pages = [{ key: 'templates', label: '流程模板' }, { key: 'config', label: '配置' }]
      return h('div', { className: 'rsww-root' },
        React.createElement('style', { 'data-plugin': '@mzzsfy/dsh-rs-workflow', dangerouslySetInnerHTML: { __html: CSS } }),
        React.createElement('div', { className: 'rsww-head' },
          React.createElement('span', { className: 'rsww-head__title' }, '若水工作流'),
          React.createElement('span', { className: 'rsww-head__caption' },
            '强规则编排:模式内消息被接管,批次推进,结构化产出强制校验;流程模板与配置在此集中管理,运行记录在会话「若水编排」页签查看。')),
        h(PillGroup, { tab: true, ariaLabel: '子页', value: page, options: pages, onChange: setPage }),
        page === 'templates' ? h(TemplatesPage) : h(ConfigPage))
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
          let currentSessionId
          const ensure = (isRs) => {
            if (disposed) return
            if (isRs && !disposeView) {
              disposeView = ctx.slots.inject('conversation.view', () =>
                ctx.slots.register(
                  { name: 'conversation.view', id: VIEW_ID, order: 15, label: '若水编排' },
                  (props) => React.createElement(FlowView, { getSessionId: () => currentSessionId, ...props }),
                ))
              disposeChip = ctx.slots.inject('conversation.session.header.actions', () =>
                ctx.slots.register(
                  { name: 'conversation.session.header.actions', id: CHIP_ID, order: 15 },
                  (props) => React.createElement(FlowChip, props),
                ))
            } else if (!isRs && disposeView) {
              disposeView(); disposeView = null
              disposeChip(); disposeChip = null
            }
          }
          const judge = async () => {
            const sessionId = ctx.sessions?.list?.getSnapshot?.().current
            currentSessionId = sessionId
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
