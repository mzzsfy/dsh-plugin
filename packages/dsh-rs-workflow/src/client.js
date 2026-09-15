// rs-workflow 看板 client 半区:设置页唯一 settings.section 分区「若水工作流」,
// 内部三个子页(运行历史 | 流程模板 | 配置)分级承载。自注册 __ModuleLoader__.load
// 形态(对齐 dsh-usage-panel);数据经 host 半区 /api/rs-workflow/* 读写,权威态在
// 宿主 report-store 单例。类名前缀 rsww-;开关/段控遵循仓库规约(track+thumb 视觉
// 开关与 pill 段控,状态锚定 input[type=checkbox] / button aria-pressed)。

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

    // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;双键 = 分区 label + 市场
    // 短名(发现页收录显示形态);该插件未就绪时入队,由其启动时排空
    const NAV_ICON = { '若水工作流': 'flow', 'dsh-rs-workflow': 'flow' }
    if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
    else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
    else window.__navicIconQueue = [NAV_ICON]

    const STATUS_META = {
      running: { label: '运行中', tone: 'business' },
      done: { label: '已完成', tone: 'success' },
      blocked: { label: '受阻', tone: 'error' },
    }
    const VERDICT_LABELS = { APPROVED: '通过', REJECTED: '拒绝', UNREVIEWED: '未审' }

    // 全部颜色取官方主题 alias token(品牌主色浅色主题下为近黑,非蓝);
    // fallback 值仅兜主题未就绪,与浅色主题对齐
    const CSS = `
.rsww-root{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-head{display:flex;flex-direction:column;gap:2px;padding:4px 2px 0}
.rsww-head__title{font:600 16px/24px var(--dsw-font-family,-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif)}
.rsww-head__caption{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-tabs{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:9px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);align-self:flex-start}
.rsww-pill{position:relative;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:500 var(--dsw-font-xs-13,13px/20px sans-serif);border-radius:7px;padding:5px 14px;cursor:pointer;transition:background .15s,color .15s}
.rsww-pill:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-pill--on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.rsww-toolbar{display:flex;align-items:center;gap:8px}
.rsww-spacer{flex:1}
.rsww-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#61666b);font:500 var(--dsw-font-xs-13,13px/20px sans-serif);border-radius:8px;padding:5px 12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.rsww-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
.rsww-btn:disabled{opacity:.45;cursor:default;background:var(--dsw-alias-bg-base,#fff)}
.rsww-btn--primary{background:var(--dsw-alias-button-primary-fill,#0f1115);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.rsww-btn--primary:hover{background:var(--dsw-alias-button-primary-fill,#0f1115);opacity:.88;color:var(--dsw-alias-label-primary-foreground,#fff)}
.rsww-btn--danger{color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-btn--danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.06));border-color:var(--dsw-alias-state-error-primary,#ec1313);color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-badge{display:inline-flex;align-items:center;gap:5px;font:500 var(--dsw-font-xxs-12,12px/18px sans-serif);border-radius:999px;padding:2px 9px;white-space:nowrap}
.rsww-badge--business{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-badge--success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a)}
.rsww-badge--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-badge--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#b45309)}
.rsww-badge--mute{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor}
.rsww-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);padding:12px 14px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s,box-shadow .15s}
.rsww-card--hover{cursor:pointer}
.rsww-card--hover:hover{border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16));box-shadow:0 2px 8px rgba(0,0,0,.06)}
.rsww-card--open{border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16));box-shadow:0 2px 8px rgba(0,0,0,.06)}
.rsww-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.rsww-req{font:600 var(--dsw-font-s-14,14px/22px sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:180px}
.rsww-group{display:flex;flex-direction:column;gap:8px}
.rsww-group__head{display:flex;align-items:baseline;gap:8px;padding:2px 2px 0}
.rsww-group__title{font:600 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,#61666b)}
.rsww-group__count{font:400 var(--dsw-font-xxs-12,12px/18px sans-serif);color:var(--dsw-alias-label-caption,#adb2b8)}
.rsww-detail{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);padding:14px;display:flex;flex-direction:column;gap:10px;cursor:default}
.rsww-section{display:flex;flex-direction:column;gap:4px}
.rsww-label{font:600 var(--dsw-font-xxs-12,12px/18px sans-serif);color:var(--dsw-alias-label-tertiary,#81858c);letter-spacing:.02em}
.rsww-text{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,monospace);font-size:12px}
.rsww-list{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.rsww-item{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);line-height:1.55;display:flex;gap:8px;align-items:baseline}
.rsww-id{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);flex:none}
.rsww-error{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-state-error-primary,#ec1313)}
.rsww-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 0 40px;color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-empty__title{font:500 var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-label-secondary,#61666b)}
.rsww-empty__hint{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);text-align:center;max-width:420px}
.rsww-empty__icon{opacity:.5;color:var(--dsw-alias-label-caption,#adb2b8)}
.rsww-input{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:400 var(--dsw-font-xs-13,13px/20px sans-serif);padding:6px 10px;min-width:130px;transition:border-color .15s}
.rsww-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 15%,transparent)}
.rsww-input--wide{flex:1;min-width:220px}
.rsww-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,monospace);font-size:12px;line-height:1.6;padding:10px;resize:vertical;white-space:pre;overflow-x:auto}
.rsww-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 15%,transparent)}
.rsww-kv{display:grid;grid-template-columns:150px 1fr;row-gap:8px;column-gap:12px;align-items:baseline}
.rsww-kv__label{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-tertiary,#81858c)}
.rsww-kv__value{font:500 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.rsww-tpldesc{font:400 var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,#61666b);line-height:1.55}
.rsww-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.rsww-switch input[type="checkbox"]{position:absolute;opacity:0;width:1px;height:1px}
.rsww-switch__track{width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.12));position:relative;transition:background .15s;flex:none}
.rsww-switch__thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track{background:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track .rsww-switch__thumb{transform:translateX(13px)}
.rsww-switch input[type="checkbox"]:focus-visible + .rsww-switch__track{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 70%,white);outline-offset:1px}
/* 会话页签与 header 胶囊 */
.rsww-flow{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#0f1115);padding-top:10px}
.rsww-chip{position:relative;display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:500 var(--dsw-font-xs-13,13px/20px sans-serif);border-radius:6px;padding:3px 2px;cursor:pointer;white-space:nowrap}
.rsww-chip:hover,.rsww-chip:focus-visible{color:var(--dsw-alias-label-primary,#0f1115)}
.rsww-chip--live{color:var(--dsw-alias-state-business-primary,#4176e6)}
.rsww-chip__dot{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor;animation:rsww-pulse 1.2s ease-in-out infinite}
@keyframes rsww-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.rsww-float{z-index:100;box-sizing:border-box;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-elevation-prominent);border-radius:20px;width:340px;max-width:min(400px,100vw - 32px);max-height:min(420px,100vh - 140px);display:flex;flex-direction:column;gap:1px;padding:4px;position:absolute;top:calc(100% + 5px);right:0;overflow:auto}
.rsww-float__item{box-sizing:border-box;width:100%;min-height:32px;color:var(--dsw-alias-label-primary,#0f1115);border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font:400 var(--dsw-font-xs-13,13px/20px sans-serif);display:flex;background:transparent;border:0;cursor:default;text-align:left}
.rsww-float__req{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.rsww-float__time{color:var(--dsw-alias-label-tertiary,#81858c);flex:none;font-size:11px;font-variant-numeric:tabular-nums}
.rsww-steps{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.rsww-step{display:flex;align-items:baseline;gap:8px;font:400 var(--dsw-font-xs-13,13px/20px sans-serif);line-height:1.55;padding:4px 6px;border-radius:6px}
.rsww-step:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.rsww-step__node{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);flex:none;min-width:72px}
.rsww-step__sum{color:var(--dsw-alias-label-primary,#0f1115);word-break:break-word}
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
        React.createElement('span', { className: 'rsww-text' }, props.label))
    }

    function Badge({ tone, children, dot }) {
      return React.createElement('span', { className: 'rsww-badge rsww-badge--' + tone },
        dot ? React.createElement('span', { className: 'rsww-dot' }) : null, children)
    }

    function StatusBadge({ status }) {
      const meta = statusMeta(status)
      return React.createElement(Badge, { tone: meta.tone, dot: true }, meta.label)
    }

    function EmptyState({ icon, title, hint, action }) {
      return React.createElement('div', { className: 'rsww-empty' },
        React.createElement('span', { className: 'rsww-empty__icon' }, icon),
        React.createElement('span', { className: 'rsww-empty__title' }, title),
        hint ? React.createElement('span', { className: 'rsww-empty__hint' }, hint) : null,
        action || null)
    }

    const FLOW_GLYPH = React.createElement('svg', { width: 34, height: 34, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' },
      React.createElement('rect', { x: '3', y: '3', width: '7', height: '7', rx: '1.5' }),
      React.createElement('rect', { x: '14', y: '14', width: '7', height: '7', rx: '1.5' }),
      React.createElement('path', { d: 'M10 6.5h5.5A2.5 2.5 0 0 1 18 9v5' }),
      React.createElement('circle', { cx: '18', cy: '6.5', r: '0.2' }))

    // ── 运行历史 ────────────────────────────────────────────────────────────────

    function RunDetail({ run, onRemove }) {
      const result = run.result || null
      const tasks = result && Array.isArray(result.tasks) ? result.tasks : []
      const reviews = result && Array.isArray(result.reviews) ? result.reviews : []
      const updates = Array.isArray(run.updates) ? run.updates : []
      return React.createElement('div', { className: 'rsww-detail', onClick: (e) => e.stopPropagation() },
        React.createElement('div', { className: 'rsww-row' },
          React.createElement(StatusBadge, { status: run.status }),
          React.createElement('span', { className: 'rsww-text rsww-mono' }, run.runId),
          run.stats ? React.createElement(Badge, { tone: 'mute' },
            '任务 ' + run.stats.tasks + ' · 审批 ' + run.stats.reviews + ' · 变更 ' + run.stats.changedFiles) : null,
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('button', { className: 'rsww-btn rsww-btn--danger', onClick: onRemove }, '删除记录')),
        React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '需求'),
          React.createElement('span', { className: 'rsww-text' }, run.request || '-')),
        run.blocked ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '受阻原因'),
          React.createElement('span', { className: 'rsww-error' },
            (run.blocked.nodeId ? '[' + run.blocked.nodeId + '] ' : '') + (run.blocked.reason || '')
            + (run.blocked.detail ? '\n' + run.blocked.detail : ''))) : null,
        run.summary ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '结论'),
          React.createElement('span', { className: 'rsww-text' }, run.summary)) : null,
        result && result.difficulty ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '分诊'),
          React.createElement('span', { className: 'rsww-text' },
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

    function RunsPage() {
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

      const loadDetail = useCallback(async (runId, silent) => {
        const outcome = await request('run?id=' + encodeURIComponent(runId))
        if (outcome.ok) setDetails((prev) => ({ ...prev, [runId]: outcome.data }))
        else if (!silent) setError(outcome.error)
      }, [])

      useEffect(() => {
        reload()
        if (!autoRefresh) return undefined
        const timer = setInterval(() => { reload(); const id = expandedRef.current; if (id) loadDetail(id, true) }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [autoRefresh, reload, loadDetail])

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

      if (runs === null && !error) return React.createElement('div', { className: 'rsww-root' }, React.createElement('span', { className: 'rsww-head__caption' }, '加载中...'))

      // 分组展示:工作区分组头 + 组内新到旧
      const groups = []
      const byWorkspace = {}
      for (const run of runs || []) {
        const key = run.workspace || ''
        if (!byWorkspace[key]) { byWorkspace[key] = []; groups.push(key) }
        byWorkspace[key].push(run)
      }

      const expandedRun = expandedId ? (details[expandedId] || (runs || []).find((r) => r.runId === expandedId)) : null

      return React.createElement('div', { className: 'rsww-root' },
        React.createElement('div', { className: 'rsww-toolbar' },
          React.createElement(Switch, { checked: autoRefresh, onChange: (e) => {
            const next = e.target.checked
            setAutoRefresh(next)
            try { window.localStorage.setItem(AUTO_REFRESH_KEY, next ? '1' : '0') } catch { /* 存储不可用仅影响偏好记忆 */ }
          }, ariaLabel: '自动刷新', label: '自动刷新' }),
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('button', { className: 'rsww-btn', onClick: reload }, '刷新'),
          React.createElement('button', { className: 'rsww-btn rsww-btn--danger', disabled: !runs || runs.length === 0, onClick: clearAll }, '清空')),
        error ? React.createElement('span', { className: 'rsww-error' }, error) : null,
        runs && runs.length === 0 ? React.createElement(EmptyState, {
          icon: FLOW_GLYPH,
          title: '还没有运行记录',
          hint: '选中任一若水模式发送需求,编排全程与结果会出现在这里。',
        }) : null,
        groups.map((ws) => React.createElement('div', { className: 'rsww-group', key: ws },
          ws ? React.createElement('div', { className: 'rsww-group__head' },
            React.createElement('span', { className: 'rsww-group__title' }, workspaceLabel(ws)),
            React.createElement('span', { className: 'rsww-group__count' }, byWorkspace[ws].length + ' 次运行')) : null,
          byWorkspace[ws].map((run) => React.createElement(React.Fragment, { key: run.runId },
            React.createElement('div', {
              className: 'rsww-card rsww-card--hover' + (expandedId === run.runId ? ' rsww-card--open' : ''),
              onClick: () => toggleRun(run.runId), role: 'button', 'aria-expanded': expandedId === run.runId, tabIndex: 0,
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRun(run.runId) } },
            },
              React.createElement('div', { className: 'rsww-row' },
                React.createElement(StatusBadge, { status: run.status }),
                React.createElement('span', { className: 'rsww-req', title: run.request }, run.request || '(无需求描述)'),
                run.templateId ? React.createElement(Badge, { tone: 'mute' }, run.templateId) : null,
                React.createElement('span', { className: 'rsww-text' }, relativeTime(run.updatedAt || run.startedAt)))),
            expandedId === run.runId && expandedRun
              ? React.createElement(RunDetail, { run: expandedRun, onRemove: () => removeRun(run.runId) })
              : null)))))
    }

    // ── 流程模板:内置 / 自定义分级分组,卡片含释放状态 ─────────────────────────
    // 模板是强流程定义(每步产出契约),AI 编辑入口 = rs_workflow_template 工具;
    // 本页是人工编辑与「更新到 dsh」释放按钮的落点。

    function TemplateEditor({ draft, setDraft, onSave, onCancel, saving, error }) {
      return React.createElement('div', { className: 'rsww-detail' },
        React.createElement('div', { className: 'rsww-row' },
          React.createElement('input', {
            className: 'rsww-input rsww-mono', placeholder: '流程 id(如 news)', value: draft.id || '',
            onChange: (e) => setDraft({ ...draft, id: e.target.value }), 'aria-label': '流程 id',
          }),
          React.createElement('input', {
            className: 'rsww-input', placeholder: '显示名(如 新闻生产)', value: draft.label || '',
            onChange: (e) => setDraft({ ...draft, label: e.target.value }), 'aria-label': '显示名',
          }),
          React.createElement('input', {
            className: 'rsww-input rsww-input--wide', placeholder: '适用场景一句话', value: draft.description || '',
            onChange: (e) => setDraft({ ...draft, description: e.target.value }), 'aria-label': '适用场景',
          })),
        React.createElement('textarea', {
          className: 'rsww-textarea', rows: 18, spellCheck: false,
          placeholder: '流程定义 JSON5(规范见「模板规范」,或让 AI 经 rs_workflow_template 工具生成)',
          value: draft.json5 || '',
          onChange: (e) => setDraft({ ...draft, json5: e.target.value }),
          'aria-label': '流程定义 JSON5',
        }),
        error ? React.createElement('span', { className: 'rsww-error', style: { whiteSpace: 'pre-wrap' } }, error) : null,
        React.createElement('div', { className: 'rsww-row' },
          React.createElement('button', { className: 'rsww-btn rsww-btn--primary', disabled: saving, onClick: onSave }, saving ? '保存中...' : '保存'),
          React.createElement('button', { className: 'rsww-btn', onClick: onCancel }, '取消'),
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('span', { className: 'rsww-text' }, '保存仅写入设置;「更新到 dsh」才生成可选模式')))
    }

    function TemplateCard({ tpl, released, disabled, onEdit, onRelease, onUnrelease, onRemove, busy }) {
      return React.createElement('div', { className: 'rsww-card' },
        React.createElement('div', { className: 'rsww-row' },
          React.createElement('span', { className: 'rsww-req' }, (tpl.label || tpl.id) + (tpl.label ? ' (' + tpl.id + ')' : '')),
          tpl.builtin ? React.createElement(Badge, { tone: 'business' }, '内置') : null,
          disabled ? React.createElement(Badge, { tone: 'warn' }, '已禁用') : null,
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('button', { className: 'rsww-btn', disabled: busy, onClick: onEdit }, '编辑'),
          released
            ? React.createElement('button', { className: 'rsww-btn', disabled: busy, onClick: onUnrelease }, '撤下模式')
            : React.createElement('button', { className: 'rsww-btn rsww-btn--primary', disabled: busy || disabled, onClick: onRelease }, '更新到 dsh'),
          React.createElement('button', { className: 'rsww-btn rsww-btn--danger', disabled: busy, onClick: onRemove }, '删除')),
        tpl.description ? React.createElement('span', { className: 'rsww-tpldesc' }, tpl.description) : null)
    }

    function TemplatesPage() {
      const [templates, setTemplates] = useState(null)
      const [released, setReleased] = useState([])
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(null) // null | {id?, label?, description?, json5}
      const [specOpen, setSpecOpen] = useState(false)
      const [specText, setSpecText] = useState('')
      const [busyId, setBusyId] = useState('')

      const reload = useCallback(async () => {
        const [tpls, rel] = await Promise.all([request('templates'), request('released')])
        if (tpls.ok) { setTemplates(tpls.data.templates || []); setError('') } else setError(tpls.error)
        if (rel.ok) setReleased(rel.data.ids || [])
      }, [])
      useEffect(() => { reload() }, [reload])

      const loadSpec = async () => {
        if (specText) { setSpecOpen((v) => !v); return }
        const outcome = await request('spec')
        if (outcome.ok) { setSpecText(outcome.data.spec || ''); setSpecOpen(true) }
        else setError(outcome.error)
      }

      const save = async () => {
        if (!editing) return
        setBusyId(editing.id || '__new__')
        const outcome = await post('template-save', editing)
        setBusyId('')
        if (!outcome.ok) { setError(outcome.error || '校验失败'); return }
        setEditing(null)
        setError('')
        reload()
      }

      const act = (id, path) => async () => {
        setBusyId(id)
        setError('')
        const outcome = await post(path, { id })
        setBusyId('')
        if (!outcome.ok) { setError(outcome.error); return }
        if (path === 'template-remove' && editing && editing.id === id) setEditing(null)
        reload()
      }

      // 分级:内置模板在前,自定义模板在后;各自成组
      const list = templates || []
      const builtins = list.filter((t) => t.builtin)
      const customs = list.filter((t) => !t.builtin)

      const renderGroup = (title, items) => React.createElement('div', { className: 'rsww-group', key: title },
        React.createElement('div', { className: 'rsww-group__head' },
          React.createElement('span', { className: 'rsww-group__title' }, title),
          React.createElement('span', { className: 'rsww-group__count' }, items.length + ' 个模板')),
        items.map((t) => React.createElement(TemplateCard, {
          key: t.id, tpl: t, busy: busyId === t.id,
          released: released.includes(t.id), disabled: t.enabled === false,
          onEdit: () => setEditing({ ...t }), onRelease: act(t.id, 'release'),
          onUnrelease: act(t.id, 'unrelease'), onRemove: act(t.id, 'template-remove'),
        })))

      return React.createElement('div', { className: 'rsww-root' },
        React.createElement('div', { className: 'rsww-toolbar' },
          React.createElement('span', { className: 'rsww-text' }, '释放后即为模式选择器中可选模式'),
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('button', { className: 'rsww-btn', onClick: loadSpec }, specOpen ? '收起规范' : '模板规范'),
          React.createElement('button', { className: 'rsww-btn rsww-btn--primary', onClick: () => setEditing({ id: '', label: '', description: '', json5: '' }) }, '新建模板')),
        error ? React.createElement('span', { className: 'rsww-error' }, error) : null,
        templates === null && !error ? React.createElement('span', { className: 'rsww-head__caption' }, '加载中...') : null,
        specOpen ? React.createElement('div', { className: 'rsww-detail' },
          React.createElement('span', { className: 'rsww-text rsww-mono' }, specText || '加载中...')) : null,
        editing ? React.createElement(TemplateEditor, {
          draft: editing, setDraft: setEditing, onSave: save, onCancel: () => setEditing(null), saving: busyId === (editing.id || '__new__'), error,
        }) : null,
        templates !== null && list.length === 0 && !editing
          ? React.createElement(EmptyState, {
            icon: FLOW_GLYPH, title: '还没有流程模板',
            hint: '点「新建模板」手写 JSON5,或在任意会话让 AI 经 rs_workflow_template 工具生成。',
          }) : null,
        builtins.length ? renderGroup('内置模板', builtins) : null,
        customs.length ? renderGroup('自定义模板', customs) : null)
    }

    // ── 配置子页:设置命名空间概览(只读,编辑走配置文件) ────────────────────────

    function ConfigPage() {
      const [meta, setMeta] = useState(null)
      const [error, setError] = useState('')
      useEffect(() => {
        let alive = true
        fetch('/api/settings/describe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'rsww-config', method: 'settings/describe', payload: { args: {} } }),
        }).then((r) => r.json()).then((json) => {
          const ns = json && json.result && json.result.value
            ? json.result.value.namespaces.find((n) => n.ns === 'rs-workflow') : null
          if (alive && ns) setMeta(ns.value)
          else if (alive) setError('设置命名空间不可用')
        }).catch((e) => { if (alive) setError(String(e && e.message || e)) })
        return () => { alive = false }
      }, [])
      if (error) return React.createElement('span', { className: 'rsww-error' }, error)
      if (!meta) return React.createElement('span', { className: 'rsww-head__caption' }, '读取配置中...')
      const slotCount = Object.keys(meta.slots || {}).filter((k) => meta.slots[k]).length
      const budgets = meta.budgets
        ? [meta.budgets.reviewRejectBeforeEscalate, meta.budgets.planRejectBeforeBlocked, meta.budgets.emptyOutputRetryLimit, meta.budgets.reportNudgeLimit].join(' / ')
        : '-'
      return React.createElement('div', { className: 'rsww-root' },
        React.createElement('div', { className: 'rsww-card' },
          React.createElement('div', { className: 'rsww-kv' },
            React.createElement('span', { className: 'rsww-kv__label' }, '默认流程模板'),
            React.createElement('span', { className: 'rsww-kv__value' }, meta.workflow ? meta.workflow.defaultTemplate : '-'),
            React.createElement('span', { className: 'rsww-kv__label' }, '并发任务上限'),
            React.createElement('span', { className: 'rsww-kv__value' }, meta.workflow && typeof meta.workflow.maxTasks === 'number' ? meta.workflow.maxTasks : '-'),
            React.createElement('span', { className: 'rsww-kv__label' }, '预算阈值(拒/计划拒/重问/追问)'),
            React.createElement('span', { className: 'rsww-kv__value' }, budgets),
            React.createElement('span', { className: 'rsww-kv__label' }, '已配置工作位'),
            React.createElement('span', { className: 'rsww-kv__value' }, slotCount + ' / 16'))),
        React.createElement('span', { className: 'rsww-tpldesc' },
          '修改工作位模型绑定与预算:设置页右上「打开配置文件」编辑 settings.yaml 的 rs-workflow 段,宿主按命名空间渲染表单。'))
    }

    // 设置分区:唯一入口「若水工作流」,子页 = 运行历史 | 流程模板 | 配置
    const TABS = [
      { key: 'runs', label: '运行历史', render: () => React.createElement(RunsPage) },
      { key: 'templates', label: '流程模板', render: () => React.createElement(TemplatesPage) },
      { key: 'config', label: '配置', render: () => React.createElement(ConfigPage) },
    ]

    function RswwApp() {
      const [tab, setTab] = useState('runs')
      const active = TABS.find((t) => t.key === tab) || TABS[0]
      return React.createElement('div', { className: 'rsww-root' },
        React.createElement('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        React.createElement('div', { className: 'rsww-head' },
          React.createElement('span', { className: 'rsww-head__title' }, '若水工作流'),
          React.createElement('span', { className: 'rsww-head__caption' },
            '强流程编排:模式内用户消息被接管,逐步产出强制校验。')),
        React.createElement('div', { className: 'rsww-tabs', role: 'tablist' },
          TABS.map((t) => React.createElement('button', {
            key: t.key, role: 'tab', 'aria-selected': tab === t.key,
            className: 'rsww-pill' + (tab === t.key ? ' rsww-pill--on' : ''),
            onClick: () => setTab(t.key),
          }, t.label))),
        active.render())
    }

    // ── 会话页签「若水编排」:进度实时视图 ─────────────────────────────────────
    // 条件注入:仅在轮询器发现运行中的编排后才注册页签(无条件常驻页签对无编排
    // 会话是噪音)。run 落定后页签保留,可回看最终结果。

    const VIEW_ID = 'rsww-flow'
    const CHIP_ID = 'rsww-flow-chip'

    function FlowRunCard({ run }) {
      const [detail, setDetail] = useState(null)
      const updates = (detail && Array.isArray(detail.updates) ? detail.updates : null)
        || (Array.isArray(run.updates) ? run.updates : [])
      useEffect(() => {
        let alive = true
        request('run?id=' + encodeURIComponent(run.runId)).then((outcome) => {
          if (alive && outcome.ok) setDetail(outcome.data)
        })
        return () => { alive = false }
      }, [run.runId, run.updatedAt])
      // 需求正文去掉系统注入段(system-reminder 等标签块),只留用户实际输入
      const requestText = String(run.request || '')
        .split(/<\/?system-reminder>/i)[0].trim() || '(见完整记录)'
      return React.createElement('div', { className: 'rsww-card' },
        React.createElement('div', { className: 'rsww-row' },
          React.createElement(StatusBadge, { status: run.status }),
          run.templateId ? React.createElement(Badge, { tone: 'mute' }, run.templateId) : null,
          React.createElement('span', { className: 'rsww-req', title: run.request }, requestText),
          React.createElement('span', { className: 'rsww-spacer' }),
          React.createElement('span', { className: 'rsww-text' }, relativeTime(run.updatedAt || run.startedAt))),
        run.summary ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '结论'),
          React.createElement('span', { className: 'rsww-text' }, run.summary)) : null,
        updates.length ? React.createElement('div', { className: 'rsww-section' },
          React.createElement('span', { className: 'rsww-label' }, '节点进度'),
          React.createElement('ul', { className: 'rsww-steps' }, updates.slice().reverse().map((u, i) =>
            React.createElement('li', { className: 'rsww-step', key: i },
              React.createElement('span', { className: 'rsww-step__node' }, u.nodeId || '-'),
              React.createElement('span', { className: 'rsww-step__sum' },
                (u.status ? '[' + u.status + '] ' : '') + (u.summary || '')))))) : null)
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
      if (error) return React.createElement('div', { className: 'rsww-flow' }, React.createElement('span', { className: 'rsww-error' }, error))
      const list = runs || []
      const running = list.filter((r) => r.status === 'running')
      const settled = list.filter((r) => r.status !== 'running').slice(0, 8)
      return React.createElement('div', { className: 'rsww-flow' },
        React.createElement('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        list.length === 0 ? React.createElement(EmptyState, {
          icon: FLOW_GLYPH, title: '本进程还没有若水编排',
          hint: '选中任一若水模式发送需求后,编排进度会实时出现在这里。',
        }) : null,
        running.length ? React.createElement('div', { className: 'rsww-group' },
          React.createElement('div', { className: 'rsww-group__head' },
            React.createElement('span', { className: 'rsww-group__title' }, '运行中'),
            React.createElement('span', { className: 'rsww-group__count' }, running.length + ' 次')),
          running.map((run) => React.createElement(FlowRunCard, { key: run.runId, run }))) : null,
        settled.length ? React.createElement('div', { className: 'rsww-group' },
          React.createElement('div', { className: 'rsww-group__head' },
            React.createElement('span', { className: 'rsww-group__title' }, '最近完成'),
            React.createElement('span', { className: 'rsww-group__count' }, '近 ' + settled.length + ' 次')),
          settled.map((run) => React.createElement(FlowRunCard, { key: run.runId, run }))) : null)
    }

    // header 状态胶囊:编排运行中时在会话头部常驻可见(对话页签下也能感知进度),
    // 点击展开小面板列出运行中的编排;这是"程序化切换页签无公开 API"下的降级形态。
    function FlowChip({ sessionId }) {
      const [runs, setRuns] = useState([])
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
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
      useEffect(() => { if (live.length === 0) setOpen(false) }, [live.length])
      const closeOnOutside = useCallback((e) => {
        if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
      }, [])
      useEffect(() => {
        if (!open) return undefined
        document.addEventListener('mousedown', closeOnOutside)
        return () => document.removeEventListener('mousedown', closeOnOutside)
      }, [open, closeOnOutside])
      if (live.length === 0) return null
      return React.createElement('div', { ref: rootRef, style: { position: 'relative' } },
        React.createElement('button', {
          className: 'rsww-chip rsww-chip--live', 'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        },
          React.createElement('span', { className: 'rsww-chip__dot' }),
          '若水编排 ' + live.length + ' 运行中'),
        open ? React.createElement('div', { className: 'rsww-float' },
          live.map((run) => React.createElement('div', { className: 'rsww-float__item', key: run.runId },
            React.createElement(StatusBadge, { status: run.status }),
            React.createElement('span', { className: 'rsww-float__req', title: run.request }, run.request || '(无需求描述)'),
            React.createElement('span', { className: 'rsww-float__time' }, relativeTime(run.startedAt)))),
          React.createElement('div', { className: 'rsww-float__item' },
            React.createElement('span', { className: 'rsww-float__time' }, '进度详情见「若水编排」页签'))) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'rs-workflow-board', order: 45, label: '若水工作流' },
            () => React.createElement(RswwApp),
          ))
        // 条件注入编排页签:轮询器发现首个运行中的 run 后注册会话页签与 header
        // 胶囊;两者同生共死于同一个 fiber effect,插件停用即整体清理。
        ctx.effect(() => {
          let disposed = false
          let timer = null
          let registered = false
          const registerUi = () => {
            if (disposed || registered) return
            registered = true
            ctx.slots.inject('conversation.view', () =>
              ctx.slots.register(
                { name: 'conversation.view', id: VIEW_ID, order: 15, label: '若水编排' },
                () => React.createElement(FlowView),
              ))
            ctx.slots.inject('conversation.session.header.actions', () =>
              ctx.slots.register(
                { name: 'conversation.session.header.actions', id: CHIP_ID, order: 15 },
                (props) => React.createElement(FlowChip, props),
              ))
          }
          const poll = async () => {
            try {
              const res = await fetch(API + 'runs')
              if (!res.ok) return
              const json = await res.json()
              const live = (json && Array.isArray(json.runs) ? json.runs : []).some((r) => r.status === 'running')
              if (live) { registerUi(); if (timer) { clearInterval(timer); timer = null } }
            } catch { /* host 未就绪:下轮重试 */ }
          }
          timer = setInterval(poll, REFRESH_MS)
          poll()
          return () => {
            disposed = true
            if (timer) clearInterval(timer)
          }
        }, 'rs-workflow: conditional flow view')
      },
    }
  },
})
