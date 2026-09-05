// dsh-toast Client 半区:全局浮出通知 Toast 库,多条并存栈式展示。
// 以 DSH client-modules 自注册格式发布(__ModuleLoader__.load),消费插件经
// dsh.client.external require('@mzzsfy/dsh-toast/client') 使用。本包不声明
// dsh.bundle.patch,不进 profile 插件层;宿主占位条目由消费方 cordis.patch.yml
// 代挂,本包 client 由此进入客户端模块表。
// 渲染容器惰性自举:首次 show 挂载,容器与样式幂等,挂载前清同 id 旧代残留
// (HMR 重载模块后新代自愈,旧代闭包随容器移除失效)。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-toast',
  factory(require) {
    const React = require('react')
    const { useSyncExternalStore } = React
    const { createRoot } = require('react-dom/client')

    // Toast 持续时长与栈上限:展示期定值;突发事件裁剪最旧条目
    const TOAST_HOLD_MS = 4 * 1000
    const TOAST_MAX = 4
    const KINDS = ['info', 'ok', 'error']
    const HOST_ID = 'dsh-toast-host'
    const STYLE_ID = 'dsh-toast-style'

    const CSS = [
      '.dsh-toast-stack { position:fixed; left:50%; top:16px; transform:translateX(-50%); z-index:1100;',
      '  display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none; }',
      '.dsh-toast { pointer-events:auto; background:var(--dsw-alias-toast-bg); color:var(--dsw-alias-label-primary-inverted);',
      '  font:var(--dsw-font-xs-13); padding:8px 14px; border-radius:10px; box-shadow:var(--dsw-shadow-lv2);',
      '  animation:dsh-toast-in 0.18s ease-out; max-width:520px; display:flex; align-items:center; gap:10px; }',
      '.dsh-toast--ok { background:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-label-primary-inverted); }',
      '.dsh-toast--error { background:var(--dsw-alias-state-error-primary); color:#fff; }',
      '.dsh-toast__close { border:0; background:transparent; cursor:pointer; color:inherit;',
      '  font:var(--dsw-font-xs-strong-13); padding:0 2px; opacity:.8; }',
      '.dsh-toast__close:hover { opacity:1; }',
      '@keyframes dsh-toast-in { from { transform:translateY(-8px); opacity:0; } to { transform:translateY(0); opacity:1; } }',
      '@media (prefers-reduced-motion: reduce) { .dsh-toast { animation:none; } }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    // ---- store:模块闭包单例,幂等无状态快照 ----

    let seq = 0
    let items = []
    const listeners = new Set()
    const emit = () => { for (const listener of listeners) listener() }

    function normalizeKind(kind) {
      return KINDS.indexOf(kind) >= 0 ? kind : 'info'
    }

    // 展示期:sticky 常驻不计时;非 sticky 取调用方正值,否则默认
    function resolveHoldMs(opts) {
      const holdMs = opts && opts.holdMs
      return typeof holdMs === 'number' && holdMs > 0 ? holdMs : TOAST_HOLD_MS
    }

    // 幂等移除:未命中不产生新快照,不触发重渲染
    function dismiss(id) {
      const next = items.filter((item) => item.id !== id)
      if (next.length === items.length) return
      items = next
      emit()
    }

    // 入栈即返回单调 id;超上限裁最旧(含 sticky,极端场景下错误提示让位于新通知);
    // 非 sticky 条目入栈即挂自动消失计时,经条目引用持 id,与裁剪无关
    function show(text, opts) {
      if (typeof text !== 'string' || text === '') return null
      const sticky = Boolean(opts && opts.sticky)
      const entry = { id: ++seq, text, kind: normalizeKind(opts && opts.kind), sticky }
      items = items.concat([entry]).slice(-TOAST_MAX)
      emit()
      mount()
      if (!sticky) setTimeout(() => dismiss(entry.id), resolveHoldMs(opts))
      return entry.id
    }

    const source = {
      getSnapshot: () => items,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }

    // ---- 渲染:容器直挂 body,不依赖宿主生命周期 ----

    // 样式内容原位比对:一致跳过,不一致(HMR 新代 CSS 变化)原位替换
    function ensureStyle() {
      const stale = document.getElementById(STYLE_ID)
      if (stale !== null) {
        if (stale.textContent !== CSS) stale.textContent = CSS
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // 容器自愈:本代容器在场即幂等;否则清理一切旧容器(本代被外部移除的、
    // HMR 上一代残留的),逐个卸载 React root(detached 树不再续渲染)后移除重建
    let root = null
    let host = null
    function mount() {
      if (root !== null && document.getElementById(HOST_ID) === host) return
      for (const stale of new Set([host, document.getElementById(HOST_ID)])) {
        if (stale === null) continue
        if (stale.__toastRoot !== undefined) stale.__toastRoot.unmount()
        stale.remove()
      }
      ensureStyle()
      host = document.createElement('div')
      host.id = HOST_ID
      document.body.appendChild(host)
      root = createRoot(host)
      host.__toastRoot = root
      root.render(React.createElement(ToastHost))
    }

    function ToastHost() {
      const current = useSyncExternalStore(source.subscribe, source.getSnapshot)
      return h('div', { className: 'dsh-toast-stack' },
        current.map((item) => h(ToastItem, { key: item.id, item })),
      )
    }

    function ToastItem(props) {
      const item = props.item
      return h('div', { className: 'dsh-toast dsh-toast--' + item.kind, role: 'alert' },
        h('span', null, item.text),
        item.sticky
          ? h('button', { className: 'dsh-toast__close', onClick: () => dismiss(item.id) }, '知道了')
          : null,
      )
    }

    return {
      show,
      dismiss,
      mount,
      __test: { show, dismiss, source, normalizeKind, resolveHoldMs, getItems: () => items },
    }
  },
})
