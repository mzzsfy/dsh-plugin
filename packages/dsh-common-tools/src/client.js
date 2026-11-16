// dsh-common-tools Client 半区:全家桶共享的浏览器推送总线订阅协议 + 全局浮出通知。
// - bus:按插件空间复用单条 WebSocket,支持订阅与推送(host 半区由消费插件
//   执行 setupCommonTools 激活,版本接管对 client 透明,机制见 host.js)。
// - toast:全局浮出通知,多条并存栈式展示。
// 本包是普通 npm 依赖而非插件:client 由每个消费插件 cordis.patch.yml 自带的
// 装载行进客户端模块表,宿主按包名合并成单份,插件管理不可见;消费方经
// external require('@mzzsfy/dsh-common-tools/client') 使用。
// 版本协商:连接首帧报 hello,host 回支持的协议集;不认识 hello 的旧 host 会关
// 连接,客户端据此降级为不报版本的老帧模式重连一次;协议无交集则停用总线并告警。
// toast 渲染容器惰性自举:首次 show 挂载,容器与样式幂等,挂载前清同 id 旧代残留。
// 容器带代际标记:HMR 旧代闭包再调 mount 时发现在位容器属更新代际即退避,
// 不拆新代容器;旧代迟到通知不可见(一次性告警),刷新页面恢复。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-common-tools',
  factory(require) {
    const React = require('react')
    const { useSyncExternalStore, useEffect, useLayoutEffect, useCallback, useRef, useState } = React
    const { createRoot } = require('react-dom/client')
    // 宿主模块表不保证提供 react-dom 主入口:缺失时提示降级为原地渲染(仍可见,失去 portal)
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    // 与 package.json 同锁(仓库测试守):hello 首帧上报,也是消费方读取的版本面
    const VERSION = '0.5.3'
    // 帧协议版本:改动帧集合即递增,host 回支持集,无交集即停用总线。
    // browser 单文件模块不能 import src/protocol.mjs,字面量与该文件同值由
    // test/protocol.test.mjs 锁;单边抬高会让本端协商无交集、静默停用总线
    const PROTOCOL = 1

    // Toast 持续时长与栈上限:展示期定值;突发事件裁剪最旧条目
    const TOAST_HOLD_MS = 4 * 1000
    // setTimeout 延迟的规范钳位上界:超出即被浏览器钳到上界本身(约 24.8 天),
    // 非 sticky 条目将近乎永久驻留且无关闭按钮,超界值一律回落默认
    const HOLD_MS_MAX = 2 ** 31 - 1
    const TOAST_MAX = 4
    const KINDS = ['info', 'ok', 'warn', 'error']
    // 形态值域:消费方按 appearance 选择视觉形态,未知值回落默认 toast
    const APPEARANCES = ['toast', 'panel', 'minimal', 'accent', 'progress']
    // 状态图标内轮廓:同一 16px 圆里换笔画,配合 --dct-tone 的四种语义色区分事件
    const ICON_PATHS = {
      info: 'M8 7.2v4.4M8 5v.1',
      ok: 'M5.2 8.2l2 2 3.6-4',
      warn: 'M8 4.8v3.8M8 11v.1',
      error: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8',
    }
    const HOST_ID = 'dsh-common-tools-toast-host'
    const STYLE_ID = 'dsh-common-tools-toast-style'
    // 层级假设的显式化:承诺"高于设置全屏层"绑定此值,宿主层级调整时回归核对
    const TOAST_Z_INDEX = 1100
    // 悬浮提示与 toast 同层:都需高于设置全屏层,且互不遮挡(提示在内容区,toast 在顶部)
    const TIP_Z_INDEX = 1100

    // 视觉令牌层:色彩、圆角、阴影一律经 --dct-* 引宿主语义别名,规则内不写裸色与 fallback;
    // 状态色只经左侧边框、accent 浅底与倒计时底部进度条表达,不覆盖文案颜色,避免状态底色与文字对比失效。
    // 尺码对齐宿主原生 toast(dsh-web-frontend ._toast_):14/22、radius-lg、padding 12/16、
    // max-width 640/48、内部 gap 10、top 40;插件只多加状态色边与关闭按钮。
    // 形态(toast/panel/minimal/accent/progress)只改视觉密度与强调方式,不改堆叠位置与文案结构。
    const CSS = [
      '.dsh-toast-stack { position:fixed; left:50%; top:40px; transform:translateX(-50%); z-index:' + TOAST_Z_INDEX + ';',
      '  display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none;',
      '  --dct-bg:var(--dsw-alias-toast-bg); --dct-label:var(--dsw-alias-toast-label);',
      '  --dct-panel-bg:var(--dsw-alias-bg-layer-1); --dct-text:var(--dsw-alias-label-primary);',
      '  --dct-border:var(--dsw-alias-border-l2);',
      '  --dct-ok:var(--dsw-alias-state-success-primary); --dct-danger:var(--dsw-alias-state-error-primary);',
      '  --dct-warn:var(--dsw-alias-state-warn-primary); --dct-accent:var(--dsw-alias-brand-primary);',
      '  --dct-hover:var(--dsw-alias-interactive-bg-hover); --dct-focus:var(--dsw-alias-state-business-primary);',
      '  --dct-radius-sm:var(--dsw-radius-sm); --dct-radius-md:var(--dsw-radius-md); --dct-radius-lg:var(--dsw-radius-lg);',
      '  --dct-shadow:var(--dsw-shadow-lv3); }',
      '.dsh-toast { pointer-events:auto; box-sizing:border-box; display:flex; align-items:safe center; gap:10px;',
      '  width:max-content; max-width:min(640px, calc(100vw - 48px)); max-height:60vh; overflow:auto; overflow-wrap:anywhere;',
      '  padding:12px 16px; border:0; border-inline-start:4px solid transparent;',
      '  border-radius:var(--dct-radius-lg); box-shadow:var(--dct-shadow);',
      '  background:var(--dct-bg); color:var(--dct-label);',
      '  font-family:inherit; font-size:14px; line-height:22px;',
      '  --dct-tone:var(--dct-accent); --dct-hold-ms:' + TOAST_HOLD_MS + 'ms;',
      '  animation:dsh-toast-in 0.18s ease-out; }',
      '.dsh-toast--panel { background:var(--dct-panel-bg); color:var(--dct-text); border:1px solid var(--dct-border); border-inline-start-width:4px; }',
      '.dsh-toast--info { --dct-tone:var(--dct-accent); }',
      '.dsh-toast--ok { --dct-tone:var(--dct-ok); border-inline-start-color:var(--dct-tone); }',
      '.dsh-toast--warn { --dct-tone:var(--dct-warn); border-inline-start-color:var(--dct-tone); }',
      '.dsh-toast--error { --dct-tone:var(--dct-danger); border-inline-start-color:var(--dct-tone); }',
      // 极简细条:无阴影无描边,只留 2px 状态竖线,字号与留白各降一档,和卡片类形态拉开密度差
      '.dsh-toast--minimal { background:var(--dct-panel-bg); color:var(--dct-text); box-shadow:none;',
      '  border:0; border-inline-start:2px solid var(--dct-tone); border-radius:var(--dct-radius-sm);',
      '  font-size:12px; line-height:18px; padding:6px 10px; gap:6px; max-width:min(480px, calc(100vw - 48px)); }',
      // 状态强调:状态色 14% 掺入面板底并整圈描边,图标换成状态色徽章,不靠左侧竖线
      '.dsh-toast--accent { background:color-mix(in srgb, var(--dct-tone) 14%, var(--dct-panel-bg)); color:var(--dct-text);',
      '  border:1px solid var(--dct-tone); border-radius:var(--dct-radius-md); font-weight:500; }',
      '.dsh-toast--accent .dsh-toast__icon { width:24px; height:24px; margin-top:0; border-radius:var(--dct-radius-sm);',
      '  background:color-mix(in srgb, var(--dct-tone) 12%, transparent); }',
      // 倒计时:面板形态 + 底部状态色进度条,左侧不再重复状态色;消退动画只挂在带展示期的 countdown 修饰类上,
      // 展示期由消费方 holdMs 经内联 --dct-hold-ms 传入,常驻条目停在满格
      '.dsh-toast--progress { background-color:var(--dct-panel-bg); color:var(--dct-text); border:1px solid var(--dct-border);',
      '  border-radius:var(--dct-radius-md);',
      '  background-image:linear-gradient(var(--dct-tone), var(--dct-tone)); background-repeat:no-repeat;',
      '  background-position:left bottom; background-size:100% 3px; }',
      '.dsh-toast--countdown { animation:dsh-toast-in 0.18s ease-out, dsh-toast-drain var(--dct-hold-ms) linear forwards; }',
      '.dsh-toast--click { cursor:pointer; }',
      '.dsh-toast__text { white-space:pre-line; min-width:0; }',
      // 图标是形态的主要区分点:面板/强调/倒计时带图标,原生浮条与极简细条不显示
      '.dsh-toast__icon { flex:none; align-self:flex-start; margin-top:3px; display:inline-flex; align-items:center; justify-content:center; color:var(--dct-tone); }',
      '.dsh-toast--toast .dsh-toast__icon, .dsh-toast--minimal .dsh-toast__icon { display:none; }',
      '.dsh-toast__close { flex:none; display:inline-flex; align-items:center; min-height:24px;',
      '  border:0; background:transparent; color:inherit; cursor:pointer;',
      '  font-family:inherit; font-size:14px; font-weight:500; line-height:22px; padding:0 8px;',
      '  border-radius:var(--dct-radius-sm); }',
      '.dsh-toast__close:hover { background:var(--dct-hover); }',
      '.dsh-toast__close:focus-visible { outline:2px solid var(--dct-focus); outline-offset:2px; }',
      '@keyframes dsh-toast-in { from { transform:translateY(-8px); opacity:0; } to { transform:translateY(0); opacity:1; } }',
      '@keyframes dsh-toast-drain { from { background-size:100% 3px; } to { background-size:0% 3px; } }',
      // 减弱动态:下方 .dsh-toast 的 animation:none 按源序覆盖倒计时动画,进度条停在满格
      '@media (prefers-reduced-motion: reduce) { .dsh-toast { animation:none; } }',
      // 通用悬浮提示:定位与视觉迁移自 dsh-usage-dash 的 .ud-tip(1:1 同构,类名改 dct-)
      // 提示 portal 到 body,不在 .dsh-toast-stack 内,故令牌自带于规则上,不依赖 toast 作用域
      '.dct-tip { --dct-tip-bg:var(--dsw-alias-bg-layer-2); --dct-tip-border:var(--dsw-alias-border-l2);',
      '  --dct-tip-radius:var(--dsw-radius-md); --dct-tip-shadow:var(--dsw-shadow-lv3);',
      '  --dct-tip-text:var(--dsw-alias-label-primary); --dct-tip-text-sub:var(--dsw-alias-label-secondary);',
      '  position:fixed; z-index:' + TIP_Z_INDEX + '; pointer-events:none; box-sizing:border-box;',
      '  border:1px solid var(--dct-tip-border); border-radius:var(--dct-tip-radius); background:var(--dct-tip-bg);',
      '  box-shadow:var(--dct-tip-shadow); color:var(--dct-tip-text); font-size:12px; line-height:1.5; padding:10px 12px;',
      '  max-width:min(420px, calc(100vw - 24px)); max-height:60vh; overflow:auto; font-variant-numeric:tabular-nums;',
      '  opacity:0; transition:opacity .12s ease-out; }',
      '.dct-tip--on { opacity:1; }',
      '@media (prefers-reduced-motion: reduce) { .dct-tip { transition:none; } }',
      '.dct-tip-arrow { position:absolute; width:8px; height:8px; background:var(--dct-tip-bg); border:1px solid var(--dct-tip-border); transform:rotate(45deg); pointer-events:none; }',
      '.dct-tip-arrow--top { bottom:-5px; border-top:0; border-left:0; }',
      '.dct-tip-arrow--bottom { top:-5px; border-bottom:0; border-right:0; }',
      '.dct-tip-title { font-weight:600; font-size:12px; color:var(--dct-tip-text); margin-bottom:8px; }',
      '.dct-tip-text { color:var(--dct-tip-text-sub); line-height:1.5; max-width:360px; }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    // ---- toast store:模块闭包单例,幂等无状态快照 ----

    let seq = 0
    let items = []
    const listeners = new Set()
    const emit = () => { for (const listener of listeners) listener() }

    function normalizeKind(kind) {
      return KINDS.indexOf(kind) >= 0 ? kind : 'info'
    }

    function normalizeAppearance(appearance) {
      return APPEARANCES.indexOf(appearance) >= 0 ? appearance : 'toast'
    }

    // 展示期:sticky 常驻不计时;非 sticky 取调用方有限正值,否则默认
    // (Infinity / 超钳位上界的值经浏览器 WebIDL 钳为约 24.8 天,近乎永久驻留,
    // 与展示期意图相反,必须拦;Node 语义才是溢出钳 1ms,勿混)
    function resolveHoldMs(opts) {
      const holdMs = opts && opts.holdMs
      return typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0 && holdMs <= HOLD_MS_MAX ? holdMs : TOAST_HOLD_MS
    }

    // 幂等移除:未命中零分配早退;命中先撤销自动消失计时,不入滞留空转
    function dismiss(id) {
      const item = items.find((entry) => entry.id === id)
      if (item === undefined) return
      if (item.timer !== undefined) {
        clearTimeout(item.timer)
        item.timer = undefined
      }
      items = items.filter((entry) => entry.id !== id)
      emit()
    }

    const clearTimer = (entry) => {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
    }

    // 入栈即返回单调 id;超上限裁最旧(含 sticky,极端场景下错误提示让位于新通知),
    // 被裁条目的自动消失计时同步撤销;非 sticky 条目入栈即挂自动消失计时。
    // 展示期记在条目上:倒计时形态按同一时长驱动进度条,视觉与自动消失同源
    function show(text, opts) {
      if (typeof text !== 'string' || text.trim() === '') return null
      const sticky = Boolean(opts && opts.sticky)
      const onClick = typeof (opts && opts.onClick) === 'function' ? opts.onClick : undefined
      const appearance = normalizeAppearance(opts?.appearance)
      const holdMs = sticky ? undefined : resolveHoldMs(opts)
      const entry = { id: ++seq, text, kind: normalizeKind(opts && opts.kind), appearance, holdMs, sticky, onClick, timer: undefined }
      const merged = items.concat(entry)
      if (merged.length > TOAST_MAX) {
        for (const dropped of merged.slice(0, merged.length - TOAST_MAX)) clearTimer(dropped)
      }
      items = merged.slice(-TOAST_MAX)
      emit()
      // 挂载失败不抛给消费方:条目已在 store,后续 show 的自愈重建会补展示
      try {
        mount()
      } catch (error) {
        console.warn('dsh-common-tools(toast): 容器挂载失败,待下次触发自愈: ' + (error instanceof Error ? error.message : String(error)))
      }
      if (!sticky) entry.timer = setTimeout(() => dismiss(entry.id), holdMs)
      return entry.id
    }

    const toastSource = {
      getSnapshot: () => items,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }

    // ---- toast 渲染:容器直挂 body,不依赖宿主生命周期 ----

    // 样式内容原位比对:一致跳过,不一致(HMR 新代 CSS 变化)原位替换;
    // 在位节点无论新旧一律幂等补 data-plugin,防历史代残留缺标记被宿主 claimStyles 误归属
    function ensureStyle() {
      const stale = document.getElementById(STYLE_ID)
      if (stale !== null) {
        if (stale.textContent !== CSS) stale.textContent = CSS
        stale.setAttribute('data-plugin', '@mzzsfy/dsh-common-tools')
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
      style.setAttribute('data-plugin', '@mzzsfy/dsh-common-tools')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // 代际标记:window 级自增,旧代闭包经共享载体比对在位容器代际决定接管或退避
    const GEN = (window.__dshToolsToastGen = (window.__dshToolsToastGen || 0) + 1)

    // 容器自愈:本代容器在场即幂等(样式顺带自愈);在位容器属更新代际则本代
    // 退避不动 DOM(一次性告警,迟到通知静默蒸发是排障盲区);否则清理旧容器
    // (本代被外部移除的、HMR 上一代残留的、无归属标记的外部同 id 节点),
    // 逐个卸载 React root(detached 树不再续渲染)后移除重建
    let root = null
    let host = null
    let retireWarned = false
    function mount() {
      const inPlace = document.getElementById(HOST_ID)
      if (root !== null && inPlace === host) {
        ensureStyle()
        return
      }
      if (inPlace !== null && inPlace.__toastGen !== undefined && inPlace.__toastGen > GEN) {
        if (!retireWarned) {
          retireWarned = true
          console.warn('dsh-common-tools(toast): 本代已退役(在位容器属更新代际),本次通知不可见,请刷新页面恢复')
        }
        return
      }
      for (const stale of new Set([host, inPlace])) {
        if (stale === null) continue
        if (stale.__toastRoot !== undefined) stale.__toastRoot.unmount()
        else console.warn('dsh-common-tools(toast): 移除无归属标记的同 id 容器(外部或其他代际残留)')
        stale.remove()
      }
      ensureStyle()
      host = document.createElement('div')
      host.id = HOST_ID
      document.body.appendChild(host)
      root = createRoot(host)
      host.__toastRoot = root
      host.__toastGen = GEN
      root.render(React.createElement(ToastHost))
    }

    function ToastHost() {
      const current = useSyncExternalStore(toastSource.subscribe, toastSource.getSnapshot)
      return h('div', { className: 'dsh-toast-stack' },
        current.map((item) => h(ToastItem, { key: item.id, item })),
      )
    }

    function ToastItem(props) {
      const item = props.item
      // 携带 onClick 的条目整卡可点:触发回调并消失;「知道了」按钮先阻断冒泡,
      // 显式关闭不得连带触发直达动作
      const activate = item.onClick === undefined
        ? undefined
        : () => { dismiss(item.id); item.onClick() }
      // 倒计时形态把本条展示期交给 CSS 动画,其余形态不挂内联样式;常驻条目无展示期,不加修饰类
      const countdown = item.appearance === 'progress' && item.holdMs !== undefined
      const style = countdown ? { '--dct-hold-ms': item.holdMs + 'ms' } : undefined
      return h('div', {
        className: 'dsh-toast dsh-toast--' + item.kind + ' dsh-toast--' + item.appearance + (countdown ? ' dsh-toast--countdown' : '') + (activate !== undefined ? ' dsh-toast--click' : ''),
        role: 'alert',
        style,
        onClick: activate,
      },
        h('span', { className: 'dsh-toast__icon', 'aria-hidden': 'true' },
          h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
            h('circle', { cx: 8, cy: 8, r: 6.2 }),
            h('path', { d: ICON_PATHS[item.kind] }))),
        h('span', { className: 'dsh-toast__text' }, item.text),
        item.sticky
          ? h('button', {
              className: 'dsh-toast__close',
              onClick: (event) => { event.stopPropagation(); dismiss(item.id) },
            }, '知道了')
          : null,
      )
    }

    // ---- bus:页面共享连接,插件即通道 ----

    const BUS_ROUTE = '/api/bus/ws'
    const MAX_BYTES = 1024 * 1024
    const RETRY_MIN_MS = 1000
    const RETRY_MAX_MS = 30 * 1000
    const CONNECT_TIMEOUT_MS = 10 * 1000
    // 旧 host 收到未知帧即关连接:hello 发出后在此窗内被关即判定为老帧模式
    const HELLO_GRACE_MS = 3000
    // UTF-8 字节长按协议消息计算:编码器单例复用,避免每帧 new TextEncoder
    const TEXT_ENCODER = new TextEncoder()
    const busState = (window.__dshCommonToolsBus ??= {
      socket: null, owners: new Set(), subscriptions: new Set(), ready: new Set(), retry: null, timeout: null, attempts: 0, revision: 0, closing: false,
      // hello: idle 未探测 / sent 已发待回 / ok 已协商 / legacy 旧 host 无需探测 / unsupported 协议无交集
      hello: 'idle', helloAt: 0,
    })
    // 旧代际 client 建过的页级状态没有 hello 字段:补齐后本代才能协商
    busState.hello ??= 'idle'
    busState.helloAt ??= 0

    function requireName(value, label) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('common-tools: ' + label + ' 必须为非空字符串')
      return value
    }

    function invoke(subscription, method, args) {
      if (!busState.subscriptions.has(subscription)) return
      const callback = method === 'onChange' ? subscription.listener : subscription.onReset
      if (typeof callback !== 'function') return
      const warn = error => console.warn('dsh-common-tools(bus): ' + method + ' 回调异常: ' + String(error))
      try { Promise.resolve(callback(...args)).catch(warn) } catch (error) { warn(error) }
    }

    // 根 payload 可序列化判定:帧对象由本模块构造,根 payload 是唯一业务键,其余
    // 键值不受调用方控制;JSON.stringify 丢弃 undefined/函数/Symbol 值后根 payload
    // 键不出现,故复用生成文本判定即可,不解析整帧(发送热路径)。不变量:根 payload
    // 在文本中以 `"payload":` 出现当且仅当它被真正序列化。
    function assertSerializablePayload(value, text) {
      if (Object.hasOwn(value, 'payload') && !text.includes('"payload":')) {
        throw new TypeError('common-tools: payload 必须可序列化为 JSON')
      }
    }

    function send(frame) {
      const text = JSON.stringify(frame)
      assertSerializablePayload(frame, text)
      if (TEXT_ENCODER.encode(text).length + busState.socket.bufferedAmount > MAX_BYTES) {
        throw new Error('common-tools: 消息或发送积压超过上限')
      }
      busState.socket.send(text)
    }

    function syncPlugins() {
      if (busState.closing || busState.socket?.readyState !== WebSocket.OPEN) return
      const plugins = [...new Set([...busState.subscriptions].map(subscription => subscription.plugin))]
      const revision = busState.revision + 1
      send({ type: 'subscribe', plugins, revision })
      busState.revision = revision
    }

    // 官方连接层是唯一合法的页面连接基址来源:DSH Desktop 的 dsh-app:// 源下自建
    // URL 会继承自定义协议,WebSocket 构造即抛;connection.openWebSocket 取壳注入的
    // 传输基址(__DSH_TRANSPORT__.streamBaseUrl),桌面端与远程访问同一条路径
    function openBusSocket() {
      const connection = busState.connection
      if (typeof connection?.openWebSocket === 'function') return connection.openWebSocket(BUS_ROUTE)
      const url = new URL(BUS_ROUTE, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      return new WebSocket(url.href)
    }

    function connectBus() {
      // 协议无交集是页级判决:任何 owner 后到挂载都不得重探连接
      if (busState.hello === 'unsupported') return
      let socket
      try {
        socket = openBusSocket()
      } catch (error) {
        // 构造即失败(自定义协议源无 WebSocket 代理等)不得抛出杀插件:
        // 总线停用并留一次可观测告警,消费方据此启用自有兜底
        busState.hello = 'unsupported'
        console.warn('dsh-common-tools(bus): 页面连接不可用(' + String(error?.message ?? error) + '), 总线停用')
        return
      }
      busState.socket = socket
      busState.timeout = setTimeout(() => socket.close(), CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        if (busState.socket !== socket) return
        if (busState.hello === 'idle') {
          busState.hello = 'sent'
          busState.helloAt = Date.now()
          try { socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, version: VERSION })) } catch { /* 老 host 关连接在 onclose 兜 */ }
        }
        syncPlugins()
      }
      socket.onerror = () => socket.close()
      socket.onclose = event => {
        if (busState.socket !== socket) return
        clearTimeout(busState.timeout)
        busState.socket = null
        busState.closing = false
        if (busState.hello === 'unsupported') return
        // 旧 host 把未知帧判为非法帧并以 1008 关闭:本页保持老帧模式;其余关闭(超时/抖动/重启)回 idle 重试协商
        if (busState.hello === 'sent') {
          const rejected = event?.code === 1008 && Date.now() - busState.helloAt <= HELLO_GRACE_MS
          busState.hello = rejected ? 'legacy' : 'idle'
        }
        busState.ready.clear()
        for (const subscription of busState.subscriptions) subscription.ready = false
        if (busState.owners.size === 0) return
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(busState.attempts++, 5))
        busState.retry = setTimeout(() => { busState.retry = null; connectBus() }, delay * (0.5 + Math.random() / 2))
      }
      socket.onmessage = event => {
        if (busState.socket !== socket) return
        let frame
        try { frame = JSON.parse(event.data) } catch { return }
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'hello') {
          const protocols = Array.isArray(frame.protocols) ? frame.protocols : []
          if (protocols.includes(PROTOCOL)) { busState.hello = 'ok'; return }
          busState.hello = 'unsupported'
          console.warn('dsh-common-tools(bus): 帧协议不兼容(本端 ' + PROTOCOL + ', 宿主 ' + (protocols.join('/') || '未知') + '), 总线停用')
          socket.close()
          return
        }
        if (frame.type === 'ready' && frame.revision === busState.revision && Array.isArray(frame.plugins)
          && frame.plugins.every(plugin => typeof plugin === 'string' && plugin.trim() !== '')) {
          clearTimeout(busState.timeout)
          busState.attempts = 0
          busState.ready = new Set(frame.plugins)
          for (const subscription of [...busState.subscriptions]) {
            if (subscription.ready || !busState.ready.has(subscription.plugin)) continue
            subscription.ready = true
            invoke(subscription, 'onReset', [])
          }
          return
        }
        if (frame.type !== 'message' || typeof frame.plugin !== 'string' || !Object.hasOwn(frame, 'payload')) return
        for (const subscription of [...busState.subscriptions]) {
          if (subscription.ready && subscription.plugin === frame.plugin) {
            invoke(subscription, 'onChange', [frame.payload])
          }
        }
      }
    }

    function setupCommonTools(ctx) {
      const plugin = requireName(ctx?.fiber?.entry?.options?.name, 'ctx.fiber.entry.options.name')
      const owner = { plugin, subscriptions: new Set() }
      // 页面级共享连接只认一个基址:取首个可用 owner 的官方连接服务
      const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
      if (connection !== undefined && busState.connection === undefined) busState.connection = connection
      const assertActive = () => {
        if (!busState.owners.has(owner)) throw new Error('common-tools: 插件已卸载')
      }
      const stop = subscription => {
        owner.subscriptions.delete(subscription)
        if (!busState.subscriptions.delete(subscription)) return
        if (![...busState.subscriptions].some(item => item.plugin === plugin)) busState.ready.delete(plugin)
      }
      const sync = () => { try { syncPlugins() } catch { busState.socket?.close() } }
      ctx.effect(() => {
        busState.owners.add(owner)
        try {
          if (busState.socket === null && busState.retry === null) connectBus()
        } catch (error) { busState.owners.delete(owner); throw error }
        return () => {
          if (!busState.owners.delete(owner)) return
          for (const subscription of [...owner.subscriptions]) stop(subscription)
          if (busState.owners.size > 0) { sync(); return }
          clearTimeout(busState.retry)
          clearTimeout(busState.timeout)
          busState.retry = null
          busState.ready.clear()
          busState.attempts = 0
          const socket = busState.socket
          if (socket) {
            busState.closing = true
            socket.onopen = socket.onmessage = null
            socket.close()
          }
        }
      }, 'common-tools WS 生命周期')
      return {
        subscribe(listener, { onReset } = {}) {
          assertActive()
          if (typeof listener !== 'function') throw new TypeError('common-tools: listener 必须为函数')
          const subscription = { plugin, listener, onReset, ready: false }
          owner.subscriptions.add(subscription)
          busState.subscriptions.add(subscription)
          try {
            if (busState.ready.has(plugin)) {
              subscription.ready = true
              invoke(subscription, 'onReset', [])
            } else syncPlugins()
          } catch (error) { stop(subscription); throw error }
          return () => {
            if (!busState.subscriptions.has(subscription)) return
            stop(subscription)
            sync()
          }
        },
        publish(payload = null) {
          assertActive()
          if (busState.closing || busState.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('common-tools: 连接未就绪')
          }
          send({ type: 'publish', plugin, payload })
        },
      }
    }

    const SNAPSHOT_INTERVAL_MS = 1000
    function createSnapshotRefresh(load) {
      let active = true, inflight = false, dirty = false, timer = null, nextAt = 0
      const refresh = () => {
        if (!active) return
        dirty = true
        if (inflight || timer !== null) return
        const delay = nextAt - Date.now()
        if (delay > 0) { timer = setTimeout(() => { timer = null; refresh() }, delay); return }
        dirty = false
        inflight = true
        nextAt = Date.now() + SNAPSHOT_INTERVAL_MS
        let pending
        try { pending = load() } catch (error) { pending = Promise.reject(error) }
        Promise.resolve(pending).catch(error => console.warn('dsh-common-tools: 快照刷新失败:', error)).finally(() => {
          inflight = false
          if (dirty && active) refresh()
        })
      }
      return { refresh, dispose() { active = false; dirty = false; clearTimeout(timer); timer = null } }
    }

    // ---- 通用悬浮提示 ----
    // 定位与视觉 1:1 迁移自 dsh-usage-dash 的 Tooltip/.ud-tip:锚点支持指针跟随
    // (point)与元素矩形(rect),越界换侧、夹取进边界;消费方只给 anchor 与内容。
    const TIP_GAP_PX = 8
    const TIP_POINTER_OFFSET_PX = 14
    const TIP_MARGIN_PX = 8
    const TIP_ARROW_MIN_INSET_PX = 12
    const TIP_SIDE_TOP = 'top'
    const TIP_SIDE_BOTTOM = 'bottom'
    const TIP_SHOW_DELAY_MS = 80
    const TIP_HIDE_DELAY_MS = 60
    const clampValue = (value, min, max) => Math.max(min, Math.min(value, max))

    function tipPlacement(anchor, tipSize, bounds, options = {}) {
      if (!anchor || !tipSize) return null
      if (!(tipSize.width > 0) || !(tipSize.height > 0)) return null
      const gap = options.gap ?? TIP_GAP_PX
      const margin = options.margin ?? TIP_MARGIN_PX
      const minLeft = bounds.left + margin
      const maxLeft = Math.max(minLeft, bounds.right - margin - tipSize.width)
      const minTop = bounds.top + margin
      const maxTop = Math.max(minTop, bounds.bottom - margin - tipSize.height)
      const arrowInset = Math.min(TIP_ARROW_MIN_INSET_PX, tipSize.width / 2)
      if (anchor.kind === 'point') {
        const offset = options.offset ?? TIP_POINTER_OFFSET_PX
        const rightLeft = anchor.x + offset
        const leftLeft = anchor.x - offset - tipSize.width
        const belowTop = anchor.y + offset
        const aboveTop = anchor.y - offset - tipSize.height
        const left = rightLeft + tipSize.width <= bounds.right - margin
          ? rightLeft
          : clampValue(leftLeft, minLeft, maxLeft)
        const side = belowTop + tipSize.height <= bounds.bottom - margin ? TIP_SIDE_BOTTOM : TIP_SIDE_TOP
        const top = clampValue(side === TIP_SIDE_BOTTOM ? belowTop : aboveTop, minTop, maxTop)
        // 指针在提示外侧,箭头无从指向锚点,跟随模式不画箭头
        return { left, top, side, arrowX: null }
      }
      if (!(anchor.width > 0) || !(anchor.height > 0)) return null
      const centerX = anchor.left + anchor.width / 2
      const left = clampValue(centerX - tipSize.width / 2, minLeft, maxLeft)
      const aboveTop = anchor.top - gap - tipSize.height
      const belowTop = anchor.top + anchor.height + gap
      const aboveFits = aboveTop >= minTop
      const belowFits = belowTop <= maxTop
      let side = options.prefer ?? TIP_SIDE_TOP
      if (side === TIP_SIDE_TOP && !aboveFits) side = TIP_SIDE_BOTTOM
      else if (side === TIP_SIDE_BOTTOM && !belowFits) side = TIP_SIDE_TOP
      // 两侧都放不下:取空间更大的一侧,再由夹取进边界
      if (!aboveFits && !belowFits) {
        side = (anchor.top - bounds.top) >= (bounds.bottom - (anchor.top + anchor.height))
          ? TIP_SIDE_TOP
          : TIP_SIDE_BOTTOM
      }
      const top = clampValue(side === TIP_SIDE_TOP ? aboveTop : belowTop, minTop, maxTop)
      const arrowX = clampValue(centerX - left, arrowInset, tipSize.width - arrowInset)
      return { left, top, side, arrowX }
    }

    // 定位度量缓存:面板查询、边界矩形与提示尺寸只在会话开始/布局变化时重算,
    // 指针移动全部命中缓存,避免每次 mousemove 做全文档查询与强制布局。
    function createTipMetrics(panelSelector) {
      let panel = null
      let bounds = null
      let size = null
      // 面板元素解析单点:面板被移除/替换后下次取用时重查,ResizeObserver 也观察它
      const panelElement = () => {
        if (panel === null || panel.isConnected === false) {
          panel = panelSelector && typeof document !== 'undefined' ? document.querySelector(panelSelector) : null
        }
        return panel
      }
      return {
        selector: panelSelector,
        panelElement,
        measure(tip, fresh = false) {
          if (!fresh && size !== null) return size
          const next = { width: tip.offsetWidth, height: tip.offsetHeight }
          size = size !== null && size.width === next.width && size.height === next.height ? size : next
          return size
        },
        panelBounds(fresh = false) {
          if (!fresh && bounds !== null) return bounds
          const element = panelElement()
          const rect = element ? element.getBoundingClientRect() : null
          if (rect && rect.width > 0) {
            // 面板可能比视口大或部分滚出视口:夹取边界必须同时受视口约束,
            // 否则提示会落在面板可见区域之外
            bounds = {
              left: Math.max(rect.left, 0),
              top: Math.max(rect.top, 0),
              right: Math.min(rect.right, window.innerWidth),
              bottom: Math.min(rect.bottom, window.innerHeight),
            }
          } else {
            bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
          }
          return bounds
        },
      }
    }

    // ResizeObserver 可能缺失(旧 WebView/测试夹具):缺失时退化为窗口 resize 与内容变化重测
    function createTipResizeObserver(callback) {
      return typeof ResizeObserver === 'function' ? new ResizeObserver(callback) : null
    }

    function Tooltip({ anchor, children, panelSelector }) {
      const tipRef = useRef(null)
      const metricsRef = useRef(null)
      const [pos, setPos] = useState(null)
      const [shown, setShown] = useState(false)
      const hasContent = children != null && (!Array.isArray(children) || children.length > 0)
      const active = Boolean(anchor && hasContent)
      const pointerMode = anchor?.kind === 'point'
      if (metricsRef.current === null || metricsRef.current.selector !== panelSelector) {
        metricsRef.current = createTipMetrics(panelSelector)
      }
      // 提示可能先于任何 toast 出现:样式注入不能依赖 toast mount;
      // 用 layout effect 在首帧绘制前注入,避免首次 hover 无样式一闪
      useLayoutEffect(() => {
        ensureStyle()
      }, [])
      useEffect(() => {
        const timer = setTimeout(() => setShown(active), active ? TIP_SHOW_DELAY_MS : TIP_HIDE_DELAY_MS)
        return () => clearTimeout(timer)
      }, [active])
      const placeAt = useCallback((at, fresh = false) => {
        const tip = tipRef.current
        if (!tip || !at) return
        const metrics = metricsRef.current
        const next = tipPlacement(at, metrics.measure(tip, fresh), metrics.panelBounds(fresh))
        setPos((prev) => (prev && next && prev.left === next.left && prev.top === next.top
          && prev.side === next.side && prev.arrowX === next.arrowX ? prev : next))
      }, [])
      const place = useCallback((fresh) => placeAt(anchor, fresh === true), [placeAt, anchor])
      useLayoutEffect(() => {
        place(true)
      }, [place, shown, children])
      // 指针模式由 mousemove 直接定位:同一元素内移动也跟手,位置经度量缓存复用
      useEffect(() => {
        if (!pointerMode) return undefined
        const onMove = (event) => placeAt({ kind: 'point', x: event.clientX, y: event.clientY })
        window.addEventListener('mousemove', onMove)
        return () => window.removeEventListener('mousemove', onMove)
      }, [pointerMode, placeAt])
      // 滚动与缩放只接一处定位监听;元素锚点是快照,滚动即失效,收起即可,不做无用定位
      useEffect(() => {
        if (!anchor) return undefined
        const onResize = () => place(true)
        const onScroll = pointerMode ? () => place(true) : () => setShown(false)
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          window.removeEventListener('resize', onResize)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [place, anchor, pointerMode])
      // 提示节点可能随 active 切换或内容替换重建:每次渲染重连观察器,
      // 确保新节点与面板节点都被观察,而不是只观察首次 effect 时的旧节点
      useEffect(() => {
        if (!anchor) return undefined
        const observer = createTipResizeObserver(() => place(true))
        if (!observer) return undefined
        if (tipRef.current) observer.observe(tipRef.current)
        const panel = metricsRef.current.panelElement()
        if (panel) observer.observe(panel)
        return () => observer.disconnect()
      })
      const visible = shown && pos !== null && active
      if (!active) return null
      const box = h('div', {
        className: 'dct-tip' + (visible ? ' dct-tip--on' : ''),
        ref: tipRef,
        style: { left: pos ? pos.left : 0, top: pos ? pos.top : 0 },
      }, [
        active ? children : null,
        visible && pos.arrowX !== null
          ? h('i', { key: 'arrow', className: `dct-tip-arrow dct-tip-arrow--${pos.side}`, style: { left: pos.arrowX } })
          : null,
      ])
      return createPortal && typeof document !== 'undefined' && document.body
        ? createPortal(box, document.body)
        : box
    }

    return {
      apply() {},
      VERSION,
      createSnapshotRefresh,
      tipPlacement,
      Tooltip,
      toast: {
        show,
        dismiss,
        mount,
        // 非公开 API,仅供本包测试驱动 store 消费,无兼容承诺,消费方禁用
        __test: { show, dismiss, toastSource, normalizeKind, resolveHoldMs, getItems: () => items.slice() },
      },
      setupCommonTools,
    }
  },
})
