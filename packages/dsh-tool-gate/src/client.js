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

    const HEAD_HINT = '白名单内的工具全量注入模型上下文,其余按需检索;开关即保存,点击工具行查看完整描述与参数。'

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
.tg-panel { --tg-accent: var(--dsw-alias-brand-primary); --tg-accent-deep: var(--dsw-alias-button-primary-hover); --tg-accent-wash: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); --tg-ok: var(--dsw-alias-state-success-primary); --tg-warn: var(--dsw-alias-state-warn-primary); --tg-danger: var(--dsw-alias-state-error-primary); --tg-danger-wash: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); --tg-text: var(--dsw-alias-label-primary); --tg-text-sub: var(--dsw-alias-label-secondary); --tg-text-dim: var(--dsw-alias-label-tertiary); --tg-bg: var(--dsw-alias-bg-layer-1); --tg-bg-sub: var(--dsw-alias-bg-layer-2); --tg-bg-muted: var(--dsw-alias-bg-module-platform); --tg-card: var(--dsw-alias-bg-layer-1); --tg-card-border: var(--dsw-alias-border-l2); --tg-border: var(--dsw-alias-border-l2); --tg-border-strong: var(--dsw-alias-border-l3); --tg-hover: var(--dsw-alias-interactive-bg-hover); --tg-hover-danger: var(--dsw-alias-interactive-bg-hover-danger); --tg-skeleton: var(--dsw-alias-bg-skeleton); --tg-radius-sm: var(--dsw-radius-sm); --tg-radius-md: var(--dsw-radius-md); --tg-radius-lg: var(--dsw-radius-lg); --tg-mono: var(--ds-font-family-code);
  display: flex; flex-direction: column; gap: 16px; color: var(--tg-text); font-size: 14px; line-height: 22px; }
.tg-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.tg-head__hint { color: var(--tg-text-sub); font-size: 13px; line-height: 20px; }
.tg-card { display: flex; flex-direction: column; padding: 20px; background: var(--tg-card); border: .5px solid var(--tg-card-border); border-radius: var(--tg-radius-md); }
.tg-card__head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; }
.tg-card__title { font-weight: 600; font-size: 14px; line-height: 22px; color: var(--tg-text); }
.tg-card__meta { margin-left: auto; color: var(--tg-text-dim); font-size: 12px; line-height: 18px; }
.tg-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; padding: 12px 0; border-top: .5px solid var(--tg-border); }
.tg-field__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tg-field__label { color: var(--tg-text); font-size: 14px; line-height: 22px; }
.tg-field__hint { color: var(--tg-text-sub); font-size: 13px; line-height: 20px; }
.tg-field__control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }
.tg-table { display: flex; flex-direction: column; max-height: 420px; overflow-y: auto; }
.tg-thead { position: sticky; top: 0; z-index: 1; display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; align-items: center; padding: 8px 0; background: var(--tg-card); border-top: .5px solid var(--tg-border); color: var(--tg-text-dim); font-size: 12px; line-height: 18px; }
.tg-thead__cols { display: grid; grid-template-columns: minmax(0, 1fr) 112px 20px; gap: 8px; align-items: center; }
.tg-thead__right { text-align: right; }
.tg-tool-item { border-top: .5px solid var(--tg-border); }
.tg-tool-item:hover { background: var(--tg-hover); }
.tg-tool { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; align-items: center; min-height: 40px; }
.tg-tool--off .tg-tool__name { color: var(--tg-text-sub); }
.tg-tool__head { display: grid; grid-template-columns: minmax(0, 1fr) 112px 20px; gap: 8px; align-items: center; width: 100%; min-height: 40px; padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tg-tool__head:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: var(--tg-radius-sm); }
.tg-tool__name { min-width: 0; font-family: var(--tg-mono); font-size: 14px; line-height: 22px; color: var(--tg-text); overflow-wrap: anywhere; }
.tg-tool__meta { min-width: 0; color: var(--tg-text-sub); font-size: 12px; line-height: 18px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tg-tool__chev { color: var(--tg-text-dim); font-size: 14px; line-height: 22px; text-align: center; }
.tg-tool__detail { display: flex; flex-direction: column; gap: 8px; padding: 0 0 12px 46px; }
.tg-tool__desc { margin: 0; color: var(--tg-text-sub); font-size: 13px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tg-tool__facts { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--tg-text-dim); font-size: 12px; line-height: 18px; }
.tg-tool__params { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: .5px solid var(--tg-border); }
.tg-tool__param { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 12px; line-height: 18px; }
.tg-tool__param-name { font-family: var(--tg-mono); color: var(--tg-text); }
.tg-tool__param-type { font-family: var(--tg-mono); color: var(--tg-text-dim); }
.tg-tool__param-required { color: var(--tg-warn); }
.tg-tool__param-desc { flex: 1 1 240px; min-width: 0; color: var(--tg-text-sub); }
.tg-warn { padding: 8px 0; color: var(--tg-warn); font-size: 12px; line-height: 18px; }
.tg-error { padding: 8px 0 0; color: var(--tg-danger); font-size: 12px; line-height: 18px; }
.tg-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; }
.tg-skeleton__row { height: 16px; border-radius: var(--tg-radius-sm); background: var(--tg-skeleton); }
.tg-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; min-height: 36px; cursor: pointer; }
.tg-switch input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; }
.tg-switch__track { position: relative; flex: none; width: 34px; height: 19px; box-sizing: border-box; border-radius: 999px; background: var(--tg-bg-muted); border: 1px solid var(--tg-border); transition: background .15s, border-color .15s; }
.tg-switch__thumb { position: absolute; top: 50%; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--tg-text-dim); transform: translateY(-50%); transition: left .15s, background .15s; }
.tg-switch:hover .tg-switch__track { border-color: var(--tg-accent); }
.tg-switch input[type="checkbox"]:checked + .tg-switch__track { background: var(--tg-accent); border-color: var(--tg-accent); }
.tg-switch input[type="checkbox"]:checked + .tg-switch__track .tg-switch__thumb { left: 17px; background: var(--tg-bg); }
.tg-switch input[type="checkbox"]:focus-visible + .tg-switch__track { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.tg-switch input[type="checkbox"]:disabled + .tg-switch__track { opacity: .5; cursor: not-allowed; }
@media (max-width: 640px) {
  .tg-card { padding: 16px; }
  .tg-thead { display: none; }
  .tg-tool__head { grid-template-columns: minmax(0, 1fr) auto; }
  .tg-tool__chev { display: none; }
  .tg-tool__detail { padding-left: 12px; }
}
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
        return h('div', { className: 'tg-panel' },
          h('div', { className: 'tg-head' }, h('span', { className: 'tg-head__hint' }, error !== undefined ? '状态读取失败,可刷新页面重试。' : '正在读取工具门状态…')),
          h('div', { className: 'tg-card' },
            h('div', { className: 'tg-skeleton', 'aria-busy': 'true' },
              [0, 1, 2].map((index) => h('div', { className: 'tg-skeleton__row', key: index })))),
          error !== undefined ? h('div', { role: 'alert', className: 'tg-error' }, error) : null)
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

      // 设置行:左标题 + 说明,右控件;说明常驻,不塞进 title 属性
      const field = (label, hint, control) => h('div', { className: 'tg-field' },
        h('div', { className: 'tg-field__text' },
          h('span', { className: 'tg-field__label' }, label),
          h('span', { className: 'tg-field__hint' }, hint)),
        h('div', { className: 'tg-field__control' }, control))

      const renderTool = (tool, index) => {
        const open = expanded.includes(tool.name)
        const description = tool.description ?? ''
        const layers = tool.layers ?? 0
        const dim = state.enabled && !tool.inAllowlist && !tool.implicit
        const meta = tool.implicit
          ? '折叠入口 · 常驻'
          : !state.enabled
            ? '原状'
            : tool.inAllowlist ? '全量注入' : '延迟加载'
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

      return h('div', { className: 'tg-panel' },
        h('div', { className: 'tg-head' }, h('span', { className: 'tg-head__hint' }, HEAD_HINT)),
        h('div', { className: 'tg-card' },
          h('div', { className: 'tg-card__head' }, h('span', { className: 'tg-card__title' }, '行为')),
          field('启用工具门', '关闭后全部工具恢复注册原状(全量注入),白名单保留', h(Switch, {
            checked: state.enabled,
            disabled: busy,
            label: '启用工具门',
            onChange: (enabled) => commit(api(API.enabled, { enabled })),
          })),
          field('降级折叠(第三方路由)', state.enabled ? 'DeepSeek 原生路由之外,请求折叠为白名单 + tool_search,模型按需检索定义' : '工具门关闭时不生效', h(Switch, {
            checked: state.collapse !== false && state.enabled,
            disabled: busy || !state.enabled,
            label: '降级折叠',
            onChange: (collapse) => commit(api(API.collapse, { collapse })),
          }))),
        h('div', { className: 'tg-card' },
          h('div', { className: 'tg-card__head' },
            h('span', { className: 'tg-card__title' }, '白名单'),
            h('span', { className: 'tg-card__meta' }, `已选 ${state.allowlist.length} 项 · 共 ${state.tools.length} 项`)),
          state.unknownAllowlisted.length > 0
            ? h('div', { className: 'tg-warn' }, `白名单含未注册工具名(拼错?): ${state.unknownAllowlisted.join(', ')}`)
            : null,
          h('div', { className: 'tg-table' },
            h('div', { className: 'tg-thead' },
              h('span', { 'aria-hidden': 'true' }),
              h('div', { className: 'tg-thead__cols' },
                h('span', null, '工具'),
                h('span', { className: 'tg-thead__right' }, '策略'),
                h('span', { 'aria-hidden': 'true' }))),
            state.tools.map(renderTool))),
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
