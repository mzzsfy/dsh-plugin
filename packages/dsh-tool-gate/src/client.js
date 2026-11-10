// dsh-tool-gate Client 半区:设置页「工具门」分区(白名单勾选 + enabled 开关)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory});
// 状态与写经 /api/tool-gate/*(state 只读 + allowlist/enabled 写),服务端
// 写落盘后由主行 volatile-update 收敛,前端只回显响应里的新 state。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-tool-gate',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const API = {
      state: '/api/tool-gate/state',
      allowlist: '/api/tool-gate/allowlist',
      enabled: '/api/tool-gate/enabled',
      collapse: '/api/tool-gate/collapse',
    }

    async function api(path, body) {
      const response = await fetch(path, body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    // 色彩槽位:根作用域声明包局部 token,直接引用宿主语义别名,不写 fallback
    // (规范见 DEVELOPMENT/plugin-ui-design.md,字面值在暗色主题漏色)
    const CSS = `
.tg-card { --tg-text: var(--dsw-alias-label-primary); --tg-text-sub: var(--dsw-alias-label-secondary); --tg-text-dim: var(--dsw-alias-label-tertiary); --tg-warn: var(--dsw-alias-state-warn-primary); --tg-danger: var(--dsw-alias-state-error-primary); --tg-border: var(--dsw-alias-border-l2); --tg-bg-muted: var(--dsw-alias-bg-module-platform); --tg-bg-hover: var(--dsw-alias-interactive-bg-hover); --tg-accent: var(--dsw-alias-brand-primary); --tg-mono: var(--ds-font-family-code);
  display: flex; flex-direction: column; gap: 10px; }
.tg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tg-row__spacer { flex: 1; }
.tg-hint { color: var(--tg-text-sub); font-size: 12px; }
.tg-warn { color: var(--tg-warn); font-size: 12px; }
.tg-error { color: var(--tg-danger); font-size: 12px; }
.tg-tools { display: flex; flex-direction: column; border: 1px solid var(--tg-border); border-radius: 8px; overflow: hidden; max-height: 420px; overflow-y: auto; }
.tg-tool-item { border-bottom: 1px solid var(--tg-border); }
.tg-tool-item:last-child { border-bottom: none; }
.tg-tool { display: flex; align-items: center; gap: 10px; padding: 6px 12px; }
.tg-tool:hover { background: var(--tg-bg-hover); }
.tg-tool--off { opacity: 0.55; }
.tg-tool__head { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 0; border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tg-tool__head:focus-visible { outline: 2px solid var(--tg-accent); outline-offset: 2px; border-radius: 6px; }
.tg-tool__name { font-family: var(--tg-mono); font-size: 13px; color: var(--tg-text); overflow-wrap: anywhere; }
.tg-tool__meta { color: var(--tg-text-sub); font-size: 11px; margin-left: auto; white-space: nowrap; }
.tg-tool__chev { flex: none; width: 12px; color: var(--tg-text-dim); font-size: 11px; text-align: center; }
.tg-tool__detail { display: flex; flex-direction: column; gap: 6px; padding: 0 12px 10px 56px; }
.tg-tool__desc { margin: 0; color: var(--tg-text-sub); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.tg-tool__facts { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--tg-text-dim); font-size: 11px; line-height: 1.5; }
.tg-tool__params { display: flex; flex-direction: column; gap: 4px; }
.tg-tool__param { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; font-size: 11px; line-height: 1.5; }
.tg-tool__param-name { font-family: var(--tg-mono); color: var(--tg-text); }
.tg-tool__param-type { font-family: var(--tg-mono); color: var(--tg-text-dim); }
.tg-tool__param-required { color: var(--tg-text-dim); }
.tg-tool__param-desc { flex: 1 1 240px; min-width: 0; color: var(--tg-text-sub); }
.tg-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; position: relative; }
.tg-switch input[type="checkbox"] { position: absolute; opacity: 0; width: 1px; height: 1px; }
.tg-switch__track { width: 34px; height: 20px; border-radius: 999px; background: var(--tg-bg-muted); transition: background 0.15s ease; display: inline-block; position: relative; flex: none; }
.tg-switch__thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: left 0.15s ease; box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent); }
.tg-switch input[type="checkbox"]:checked + .tg-switch__track { background: var(--tg-accent); }
.tg-switch input[type="checkbox"]:checked + .tg-switch__track .tg-switch__thumb { left: 16px; }
.tg-switch input[type="checkbox"]:focus-visible + .tg-switch__track { outline: 2px solid var(--tg-accent); outline-offset: 2px; }
.tg-switch input[type="checkbox"]:disabled + .tg-switch__track { opacity: 0.5; cursor: not-allowed; }
`

    function Switch({ checked, disabled, onChange, label }) {
      return h('label', { className: 'tg-switch' },
        h('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked), 'aria-label': label }),
        h('span', { className: 'tg-switch__track' }, h('span', { className: 'tg-switch__thumb' })))
    }

    function ToolGateApp() {
      const [state, setState] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [expanded, setExpanded] = useState([])

      const reload = () => api(API.state).then(setState).catch((cause) => setError(String(cause.message ?? cause)))

      useEffect(() => {
        let disposed = false
        reload().finally(() => { if (disposed) return })
        return () => { disposed = true }
      }, [])

      const commit = async (promise) => {
        setBusy(true)
        setError(undefined)
        try {
          setState(await promise)
        } catch (cause) {
          setError(String(cause.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      if (state === undefined) {
        return h('div', { className: 'tg-card' }, h('span', { className: 'tg-hint' }, error ?? '加载中…'))
      }

      const toggleTool = (tool, on) => {
        const allowlist = on
          ? [...state.allowlist, tool.name]
          : state.allowlist.filter((name) => name !== tool.name)
        void commit(api(API.allowlist, { allowlist }))
      }

      const toggleExpanded = (name, index) => {
        const opening = !expanded.includes(name)
        setExpanded((current) => (
          current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
        ))
        if (!opening) return
        // 列表自带滚动视口:展开后把详情带入可视区(收起无需滚动)
        setTimeout(() => {
          if (typeof document === 'undefined') return
          document.getElementById(`tg-tool-detail-${index}`)?.scrollIntoView({ block: 'nearest' })
        }, 0)
      }

      const renderTool = (tool, index) => {
        const open = expanded.includes(tool.name)
        const description = tool.description ?? ''
        const layers = tool.layers ?? 0
        const dim = state.enabled && !tool.inAllowlist && !tool.implicit
        const meta = tool.implicit
          ? '折叠入口 · 常驻'
          : !state.enabled
            ? `原状 · ${layers} 层`
            : `${tool.inAllowlist ? '全量注入' : '延迟加载'} · ${layers} 层`
        const facts = [
          `层 ${(tool.layerLabels ?? []).join(' / ')}`,
          `defer ${tool.deferredLayers ?? 0}/${layers}`,
          tool.inAllowlist ? '白名单内' : '白名单外',
        ]
        const params = tool.params ?? []
        return h('div', { className: 'tg-tool-item', key: tool.name },
          h('div', { className: `tg-tool${dim ? ' tg-tool--off' : ''}` },
            h(Switch, {
              checked: tool.inAllowlist,
              disabled: busy || tool.implicit,
              label: `白名单 ${tool.name}`,
              onChange: (on) => toggleTool(tool, on),
            }),
            h('button', {
              type: 'button',
              className: 'tg-tool__head',
              'aria-expanded': open,
              ...(open ? { 'aria-controls': `tg-tool-detail-${index}` } : {}),
              // 悬停即见完整描述(点击展开参数与层明细)
              title: description === '' ? undefined : description,
              onClick: () => toggleExpanded(tool.name, index),
            },
              h('span', { className: 'tg-tool__name' }, tool.name),
              h('span', { className: 'tg-tool__meta' }, meta),
              h('span', { className: 'tg-tool__chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
            )),
          open
            ? h('div', { className: 'tg-tool__detail', id: `tg-tool-detail-${index}` },
                h('p', { className: 'tg-tool__desc' }, description === '' ? '该工具未提供描述。' : description),
                h('div', { className: 'tg-tool__facts' }, facts.map((text, factIndex) => h('span', { key: factIndex }, text))),
                tool.implicit ? h('div', { className: 'tg-tool__facts' }, '折叠入口由工具门常驻注册,不受白名单控制。') : null,
                params.length > 0
                  ? h('div', { className: 'tg-tool__params' },
                      params.map((param) => h('div', { className: 'tg-tool__param', key: param.name },
                        h('span', { className: 'tg-tool__param-name' }, param.name),
                        param.type === '' ? null : h('span', { className: 'tg-tool__param-type' }, param.type),
                        param.required ? h('span', { className: 'tg-tool__param-required' }, '必填') : null,
                        param.description === '' ? null : h('span', { className: 'tg-tool__param-desc' }, param.description))))
                  : h('div', { className: 'tg-tool__facts' }, '无参数'))
            : null)
      }

      return h('div', { className: 'tg-card' },
        h('div', { className: 'tg-row' },
          h(Switch, {
            checked: state.enabled,
            disabled: busy,
            label: '启用工具门',
            onChange: (enabled) => commit(api(API.enabled, { enabled })),
          }),
          h('span', null, '启用工具门'),
          h('span', { className: 'tg-hint' }, '关闭后全部工具恢复注册原状(全量注入),白名单保留')),
        h('div', { className: 'tg-row' },
          h(Switch, {
            checked: state.collapse !== false && state.enabled,
            disabled: busy || !state.enabled,
            label: '降级折叠',
            onChange: (collapse) => commit(api(API.collapse, { collapse })),
          }),
          h('span', null, '降级折叠(第三方路由)'),
          h('span', { className: 'tg-hint' }, state.enabled ? 'DeepSeek 原生路由之外,请求折叠为白名单 + tool_search,模型按需检索定义' : '工具门关闭时不生效')),
        h('div', { className: 'tg-hint' }, '白名单内的工具全量注入模型上下文;其余工具延迟加载(DeepSeek 原生路由走服务端搜索,第三方路由走本地降级折叠)。开关即保存。点击工具行查看完整描述与参数。'),
        state.unknownAllowlisted.length > 0
          ? h('div', { className: 'tg-warn' }, `白名单含未注册工具名(拼错?): ${state.unknownAllowlisted.join(', ')}`)
          : null,
        h('div', { className: 'tg-tools' }, state.tools.map(renderTool)),
        error !== undefined ? h('div', { role: 'alert', className: 'tg-error' }, error) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const NAV_ICON = { '工具门': 'layers' }
        if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
        else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
        else window.__navicIconQueue = [NAV_ICON]
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'tool-gate', order: 83, label: '工具门' },
          () => React.createElement(ToolGateApp),
        ))
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会误收,插件 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-tool-gate')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'tool-gate styles')
      },
    }
  },
})
