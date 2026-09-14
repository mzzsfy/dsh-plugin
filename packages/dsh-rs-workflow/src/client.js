// rs-workflow 看板 client 半区:设置页 settings.section 分区,运行历史 + 结果树浏览。
// 自注册 __ModuleLoader__.load 形态(对齐 dsh-usage-panel);数据经 host 半区
// /api/rs-workflow/* 读写,权威态在宿主 report-store 单例。
// 类名前缀 rsww-;开关遵循仓库规约(track+thumb 视觉开关,状态锚定 input[type=checkbox])。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-rs-workflow',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/rs-workflow/'
    const REFRESH_MS = 5 * 1000
    const REQUEST_PREVIEW_CHARS = 120
    const TEXT_PREVIEW_CHARS = 300
    const AUTO_REFRESH_KEY = 'rsww:auto-refresh'

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染(本插件分区 → flow);
    // 该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '若水工作流': 'flow' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    const STATUS_META = {
      running: { label: '运行中', tone: 'run' },
      done: { label: '已完成', tone: 'ok' },
      blocked: { label: '受阻', tone: 'bad' },
    }
    const VERDICT_LABELS = { APPROVED: '通过', REJECTED: '拒绝', UNREVIEWED: '未审' }
    const TONE_COLOR = { ok: '#22a06b', bad: '#e5484d', warn: '#f5a524', mute: '#8b8d98', run: '#3b82f6' }

    const CSS = `
.rsww-panel{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-text-primary,#e6e6e6)}
.rsww-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.rsww-title{font-size:15px;font-weight:600;flex:none}
.rsww-spacer{flex:1}
.rsww-btn{border:1px solid var(--dsw-alias-border-secondary,#3c3c46);background:transparent;color:inherit;font:inherit;font-size:12px;border-radius:6px;padding:4px 10px;cursor:pointer}
.rsww-btn:hover{border-color:var(--dsw-alias-border-primary,#5a5a66)}
.rsww-btn:disabled{opacity:.5;cursor:default}
.rsww-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.rsww-switch input[type="checkbox"]{position:absolute;opacity:0;width:1px;height:1px}
.rsww-switch__track{width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-border-secondary,#3c3c46);position:relative;transition:background .15s;flex:none}
.rsww-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s}
.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track{background:#3b82f6}
.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track .rsww-switch__thumb{transform:translateX(13px)}
.rsww-switch input[type="checkbox"]:focus-visible + .rsww-switch__track{outline:2px solid color-mix(in srgb,#3b82f6 70%,white);outline-offset:1px}
.rsww-meta{font-size:12px;color:var(--dsw-alias-text-secondary,#9a9aa6)}
.rsww-empty{font-size:13px;color:var(--dsw-alias-text-tertiary,#77778a);padding:20px 0;text-align:center}
.rsww-group{display:flex;flex-direction:column;gap:6px}
.rsww-grouphead{font-size:12px;font-weight:600;color:var(--dsw-alias-text-secondary,#9a9aa6);padding:6px 2px 0}
.rsww-card{border:1px solid var(--dsw-alias-border-secondary,#3c3c46);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;cursor:pointer;background:transparent}
.rsww-card:hover{border-color:var(--dsw-alias-border-primary,#5a5a66)}
.rsww-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.rsww-dot{width:7px;height:7px;border-radius:50%;flex:none}
.rsww-req{font-size:13px;font-weight:520;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:160px}
.rsww-tags{display:inline-flex;gap:6px;flex-wrap:wrap}
.rsww-tag{font-size:11px;color:var(--dsw-alias-text-secondary,#9a9aa6);border:1px solid var(--dsw-alias-border-secondary,#3c3c46);border-radius:999px;padding:1px 8px;white-space:nowrap}
.rsww-detail{border:1px solid var(--dsw-alias-border-primary,#5a5a66);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;cursor:default}
.rsww-section{display:flex;flex-direction:column;gap:4px}
.rsww-label{font-size:11px;font-weight:600;color:var(--dsw-alias-text-secondary,#9a9aa6)}
.rsww-text{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.rsww-mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px}
.rsww-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.rsww-item{font-size:12px;line-height:1.5;display:flex;gap:6px;align-items:baseline}
.rsww-id{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--dsw-alias-text-secondary,#9a9aa6);flex:none}
.rsww-error{font-size:12px;color:#e5484d}
.rsww-pc{border:.5px solid var(--dsw-alias-border-l4,#3c3c46);border-radius:10px;background:var(--dsw-alias-bg-l4,#1c1c24);padding:0;display:flex;flex-direction:column;list-style:none}
.rsww-pc__head{display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;color:inherit;font:inherit;text-align:left;padding:12px 14px;cursor:pointer}
.rsww-pc__title{font-size:13px;font-weight:600;flex:none}
.rsww-pc__hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa6);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsww-pc__chevron{flex:none;color:var(--dsw-alias-label-tertiary,#9a9aa6)}
.rsww-pc__body{padding:4px 14px 12px;border-top:1px solid var(--dsw-alias-border-l4,#3c3c46);display:flex;flex-direction:column;gap:8px}
.rsww-pc__row{display:flex;align-items:baseline;gap:10px}
.rsww-pc__label{font-size:12px;color:var(--dsw-alias-label-tertiary,#9a9aa6);flex:none;width:150px}
.rsww-pc__value{font-size:12px;font-variant-numeric:tabular-nums}
`

    async function request(path) {
      let res
      try { res = await fetch(API + path) } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      let json = null
      try { json = await res.json() } catch { json = null }
      if (!res.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + res.status + ')' }
      return { ok: true, data: json }
    }

    async function post(path, body) {
      let res
      try {
        res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      let json = null
      try { json = await res.json() } catch { json = null }
      if (!res.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + res.status + ')' }
      return { ok: true, data: json }
    }

    function statusMeta(status) { return STATUS_META[status] || { label: status || '-', tone: 'mute' } }

    function workspaceLabel(path) {
      if (!path) return '未知工作区'
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      return parts[parts.length - 1] || path
    }

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

    function Switch(props) {
      return React.createElement('label', { className: 'rsww-switch' },
        React.createElement('input', { type: 'checkbox', checked: props.checked, onChange: props.onChange, 'aria-label': props.ariaLabel }),
        React.createElement('span', { className: 'rsww-switch__track' }, React.createElement('span', { className: 'rsww-switch__thumb' })),
        React.createElement('span', { className: 'rsww-meta' }, props.label))
    }

    // 设置>插件页卡片:头部可折叠(aria-expanded);展开后经 settings 命名空间
    // describe 拉 schema,渲染字段概览(编辑走「打开配置文件」,与宿主插件表单契约一致)
    function RswwPluginCard() {
      const [open, setOpen] = useState(false)
      const [meta, setMeta] = useState(null)
      useEffect(() => {
        if (!open || meta) return
        let alive = true
        fetch('/api/settings/describe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'rsww-card', method: 'settings/describe', payload: { args: {} } }),
        }).then((r) => r.json()).then((json) => {
          const ns = json && json.result && json.result.value
            ? json.result.value.namespaces.find((n) => n.ns === 'rs-workflow') : null
          if (alive && ns) setMeta(ns.value)
        }).catch(() => {})
        return () => { alive = false }
      }, [open, meta])
      return React.createElement('li', { className: 'rsww-pc' },
        React.createElement('button', {
          type: 'button', className: 'rsww-pc__head', 'aria-expanded': open,
          onClick: () => setOpen((prev) => !prev),
        },
          React.createElement('span', { className: 'rsww-pc__title' }, '若水工作流'),
          React.createElement('span', { className: 'rsww-pc__hint' },
            '工作位模型绑定、默认模板、任务上限与预算;运行历史见左侧「若水工作流」分区'),
          React.createElement('span', { className: 'rsww-pc__chevron' }, open ? '▾' : '▸')),
        open ? React.createElement('div', { className: 'rsww-pc__body' },
          meta ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'rsww-pc__row' },
              React.createElement('span', { className: 'rsww-pc__label' }, '默认模板'),
              React.createElement('span', { className: 'rsww-pc__value' },
                meta.workflow ? meta.workflow.defaultTemplate : '-')),
            React.createElement('div', { className: 'rsww-pc__row' },
              React.createElement('span', { className: 'rsww-pc__label' }, '任务上限'),
              React.createElement('span', { className: 'rsww-pc__value' },
                meta.workflow && typeof meta.workflow.maxTasks === 'number' ? meta.workflow.maxTasks : '-')),
            React.createElement('div', { className: 'rsww-pc__row' },
              React.createElement('span', { className: 'rsww-pc__label' }, '预算(拒/计划拒/重问/追问)'),
              React.createElement('span', { className: 'rsww-pc__value' },
                meta.budgets ? [meta.budgets.reviewRejectBeforeEscalate, meta.budgets.planRejectBeforeBlocked,
                  meta.budgets.emptyOutputRetryLimit, meta.budgets.reportNudgeLimit].join(' / ') : '-')),
            React.createElement('div', { className: 'rsww-pc__row' },
              React.createElement('span', { className: 'rsww-pc__label' }, '已配置工作位'),
              React.createElement('span', { className: 'rsww-pc__value' }, Object.keys(meta.slots || {})
                .filter((k) => meta.slots[k]).length + ' / 16')),

          ) : React.createElement('span', { className: 'rsww-meta' }, '读取配置中...'),
          React.createElement('div', { className: 'rsww-pc__row' },
            React.createElement('span', { className: 'rsww-pc__hint' },
              '修改配置:设置页右上「打开配置文件」编辑 settings.yaml 的 rs-workflow 段;GUI 表单由宿主按命名空间渲染。'))) : null)
    }

    function StatusDot({ status }) {
      const meta = statusMeta(status)
      return React.createElement('span', { className: 'rsww-row' },
        React.createElement('span', { className: 'rsww-dot', style: { background: TONE_COLOR[meta.tone] } }),
        React.createElement('span', { className: 'rsww-meta' }, meta.label))
    }

    function RunDetail({ run, onRemove }) {
      const result = run.result || null
      const tasks = result && Array.isArray(result.tasks) ? result.tasks : []
      const reviews = result && Array.isArray(result.reviews) ? result.reviews : []
      const updates = Array.isArray(run.updates) ? run.updates : []
      return React.createElement('div', { className: 'rsww-detail', onClick: (e) => e.stopPropagation() },
        React.createElement('div', { className: 'rsww-row' },
          React.createElement(StatusDot, { status: run.status }),
          React.createElement('span', { className: 'rsww-meta rsww-mono' }, run.runId),
          React.createElement('span', { className: 'rsww-tags' },
            run.templateId ? React.createElement('span', { className: 'rsww-tag' }, run.templateId) : null,
            run.stats ? React.createElement('span', { className: 'rsww-tag' },
              '任务 ' + run.stats.tasks + ' · 审批 ' + run.stats.reviews + ' · 变更 ' + run.stats.changedFiles) : null),
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('button', { className: 'rsww-btn', onClick: onRemove }, '删除记录')),
        React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '需求'),
          React.createElement('span', { className: 'rsww-text' }, run.request || '-')),
        run.blocked ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '受阻原因'),
          React.createElement('span', { className: 'rsww-text rsww-error' },
            (run.blocked.nodeId ? '[' + run.blocked.nodeId + '] ' : '') + (run.blocked.reason || '')
            + (run.blocked.detail ? '\n' + run.blocked.detail : ''))) : null,
        run.summary ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '结论'),
          React.createElement('span', { className: 'rsww-text' }, run.summary)) : null,
        result && result.difficulty ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '分诊'),
          React.createElement('span', { className: 'rsww-meta' },
            '复杂度 ' + (result.difficulty.complexity || '-') + ' · 风险 ' + (result.difficulty.risk || '-') + ' · 规模 ' + (result.difficulty.scope || '-')
            + ' · 升级 ' + (result.escalations || 0) + ' 次')) : null,
        result && result.plan ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '执行计划'),
          React.createElement('span', { className: 'rsww-text rsww-mono' }, String(result.plan).slice(0, 2000))) : null,
        tasks.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '任务'),
          React.createElement('ul', { className: 'rsww-list' }, tasks.map((t) =>
            React.createElement('li', { className: 'rsww-item', key: t.id },
              React.createElement('span', { className: 'rsww-id' }, t.id),
              React.createElement('span', { className: 'rsww-text' },
                t.description + (t.summary ? ' — ' + String(t.summary).slice(0, TEXT_PREVIEW_CHARS) : '')))))) : null,
        reviews.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '审批'),
          React.createElement('ul', { className: 'rsww-list' }, reviews.map((r) =>
            React.createElement('li', { className: 'rsww-item', key: r.id },
              React.createElement('span', { className: 'rsww-id' }, r.id),
              React.createElement('span', { className: 'rsww-text' },
                (VERDICT_LABELS[r.verdict] || r.verdict) + (r.reviewerFault ? '(审批者故障折算)' : '')
                + (r.summary ? ' — ' + String(r.summary).slice(0, TEXT_PREVIEW_CHARS) : '')))))) : null,
        result && Array.isArray(result.changedFiles) && result.changedFiles.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '变更文件'),
          React.createElement('span', { className: 'rsww-text rsww-mono' }, result.changedFiles.join('\n'))) : null,
        updates.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '节点上报'),
          React.createElement('ul', { className: 'rsww-list' }, updates.slice().reverse().map((u, i) =>
            React.createElement('li', { className: 'rsww-item', key: i },
              React.createElement('span', { className: 'rsww-id' }, (u.nodeId || '-') + ' ' + relativeTime(u.at)),
              React.createElement('span', { className: 'rsww-text' }, (u.status ? '[' + u.status + '] ' : '') + (u.summary || '')))))) : null)
    }

    function BoardApp() {
      const [runs, setRuns] = useState(null)
      const [error, setError] = useState('')
      const [expandedId, setExpandedId] = useState(null)
      const [details, setDetails] = useState({})
      const [autoRefresh, setAutoRefresh] = useState(() => {
        try { return window.localStorage.getItem(AUTO_REFRESH_KEY) !== '0' } catch { return true }
      })
      const expandedRef = useRef(null)
      expandedRef.current = expandedId

      const reload = useCallback(async () => {
        const outcome = await request('runs')
        if (outcome.ok) { setRuns(outcome.data.runs || []); setError('') }
        else setError(outcome.error)
      }, [])

      useEffect(() => {
        reload()
        if (!autoRefresh) return undefined
        const timer = setInterval(() => { reload(); const id = expandedRef.current; if (id) loadDetail(id, true) }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [autoRefresh, reload])

      const loadDetail = useCallback(async (runId, silent) => {
        const outcome = await request('run?id=' + encodeURIComponent(runId))
        if (outcome.ok) setDetails((prev) => ({ ...prev, [runId]: outcome.data }))
        else if (!silent) setError(outcome.error)
      }, [])

      const toggleRun = (runId) => {
        if (expandedId === runId) { setExpandedId(null); return }
        setExpandedId(runId)
        if (!details[runId]) loadDetail(runId)
      }

      const removeRun = async (runId) => {
        await post('remove', { runId })
        setExpandedId((prev) => (prev === runId ? null : prev))
        reload()
      }

      const clearAll = async () => {
        await post('remove', {})
        setExpandedId(null)
        reload()
      }

      if (runs === null && !error) return React.createElement('div', { className: 'rsww-panel' }, React.createElement('span', { className: 'rsww-meta' }, '加载中...'))

      // 分组展示:工作区分组头 + 组内新到旧
      const groups = []
      const byWorkspace = {}
      for (const run of runs) {
        const key = run.workspace || ''
        if (!byWorkspace[key]) { byWorkspace[key] = []; groups.push(key) }
        byWorkspace[key].push(run)
      }

      const expandedRun = expandedId ? (details[expandedId] || runs.find((r) => r.runId === expandedId)) : null

      return React.createElement('div', { className: 'rsww-panel' },
          React.createElement('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          React.createElement('div', { className: 'rsww-head' },
            React.createElement('span', { className: 'rsww-title' }, '若水工作流'),
            React.createElement('span', { className: 'rsww-spacer' }),
            React.createElement(Switch, { checked: autoRefresh, onChange: (e) => {
              const next = e.target.checked
              setAutoRefresh(next)
              try { window.localStorage.setItem(AUTO_REFRESH_KEY, next ? '1' : '0') } catch { /* 存储不可用仅影响偏好记忆 */ }
            }, ariaLabel: '自动刷新', label: '自动刷新' }),
            React.createElement('button', { className: 'rsww-btn', onClick: reload }, '刷新'),
            React.createElement('button', { className: 'rsww-btn', disabled: !runs || runs.length === 0, onClick: clearAll }, '清空')),
          error ? React.createElement('span', { className: 'rsww-error' }, error) : null,
          runs && runs.length === 0 ? React.createElement('span', { className: 'rsww-empty' }, '还没有运行记录:以若水工作流模式启动一次编排后,这里会出现运行历史。') : null,
          groups.map((ws) => React.createElement('div', { className: 'rsww-group', key: ws },
            ws ? React.createElement('span', { className: 'rsww-grouphead' }, workspaceLabel(ws)) : null,
            byWorkspace[ws].map((run) => React.createElement(React.Fragment, { key: run.runId },
              React.createElement('div', { className: 'rsww-card', onClick: () => toggleRun(run.runId) },
                React.createElement('div', { className: 'rsww-row' },
                  React.createElement(StatusDot, { status: run.status }),
                  React.createElement('span', { className: 'rsww-req', title: run.request }, run.request || '(无需求记录)'),
                  React.createElement('span', { className: 'rsww-tags' },
                    run.templateId ? React.createElement('span', { className: 'rsww-tag' }, run.templateId) : null,
                    React.createElement('span', { className: 'rsww-tag' }, relativeTime(run.startedAt)))),
                run.blocked && run.blocked.reason ? React.createElement('span', { className: 'rsww-text rsww-error' }, run.blocked.reason) : null),
              expandedId === run.runId && expandedRun
                ? React.createElement(RunDetail, { run: expandedRun, onRemove: () => removeRun(run.runId) })
                : null)))))
    }

    // 设置分区看板(id 配对 ns, 宿主 describe 后按命名空间渲染表单) + 插件页卡片
    // (key 配对 ns;卡片壳语义对齐 cron-board settings.plugin.item)
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'rs-workflow-board', order: 45, label: '若水工作流' },
            () => React.createElement(BoardApp),
          ))
        ctx.effect(() => ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', key: 'rs-workflow', label: '若水工作流' },
            () => React.createElement(RswwPluginCard),
          )
        }), 'rs-workflow settings card')
      },
    }
  },
})
