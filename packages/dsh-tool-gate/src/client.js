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

    const CSS = `
.tg-card { display: flex; flex-direction: column; gap: 10px; }
.tg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tg-row__spacer { flex: 1; }
.tg-hint { color: var(--dsh-text-secondary, #7a7f8a); font-size: 12px; }
.tg-warn { color: #d9a13b; font-size: 12px; }
.tg-error { color: #d4553f; font-size: 12px; }
.tg-tools { display: flex; flex-direction: column; border: 1px solid var(--dsh-border, #e3e5e8); border-radius: 8px; overflow: hidden; max-height: 420px; overflow-y: auto; }
.tg-tool { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--dsh-border, #e3e5e8); }
.tg-tool:last-child { border-bottom: none; }
.tg-tool--off { opacity: 0.55; }
.tg-tool__name { font-family: monospace; font-size: 13px; }
.tg-tool__meta { color: var(--dsh-text-secondary, #7a7f8a); font-size: 11px; margin-left: auto; }
.tg-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; position: relative; }
.tg-switch input[type="checkbox"] { position: absolute; opacity: 0; width: 1px; height: 1px; }
.tg-switch__track { width: 34px; height: 20px; border-radius: 10px; background: var(--dsh-border, #c8cbd0); transition: background 0.15s ease; display: inline-block; position: relative; flex: none; }
.tg-switch__thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 0.15s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
.tg-switch input[type="checkbox"]:checked + .tg-switch__track { background: var(--dsh-primary, #4d6bfe); }
.tg-switch input[type="checkbox"]:checked + .tg-switch__track .tg-switch__thumb { left: 16px; }
.tg-switch input[type="checkbox"]:focus-visible + .tg-switch__track { outline: 2px solid var(--dsh-primary, #4d6bfe); outline-offset: 2px; }
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
        h('div', { className: 'tg-hint' }, '白名单内的工具全量注入模型上下文;其余工具延迟加载(DeepSeek 原生路由走服务端搜索,第三方路由走本地降级折叠)。开关即保存。'),
        state.unknownAllowlisted.length > 0
          ? h('div', { className: 'tg-warn' }, `白名单含未注册工具名(拼错?): ${state.unknownAllowlisted.join(', ')}`)
          : null,
        h('div', { className: 'tg-tools' },
          state.tools.map((tool) => h('div', { className: `tg-tool${state.enabled && !tool.inAllowlist && !tool.implicit ? ' tg-tool--off' : ''}`, key: tool.name },
            h(Switch, {
              checked: tool.inAllowlist,
              disabled: busy || tool.implicit,
              label: `白名单 ${tool.name}`,
              onChange: (on) => toggleTool(tool, on),
            }),
            h('span', { className: 'tg-tool__name' }, tool.name),
            h('span', { className: 'tg-tool__meta' },
              tool.implicit
                ? '折叠入口(常驻)'
                : (tool.layers > 1 ? `${tool.layers} 层 · defer ${tool.deferredLayers}` : (tool.deferredLayers > 0 ? 'defer' : '全量')))))),
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
