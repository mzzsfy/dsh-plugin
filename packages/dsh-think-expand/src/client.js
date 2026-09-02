// 思考自动展开 Client 半区:纯前端 DOM 插件,流式思考自动展开最新一条。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 的模块表解析。
// 纯逻辑段在 LOGIC 标记之间,与 src/logic.mjs 保持同源,由 parity 测试保证。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-think-expand',
  factory(require) {
    const React = require('react')
    const { useState, useCallback } = React

    // ---- 官方 DOM 字面量标识(快照源码核实,不随 CSS Modules 哈希化) ----

    const SELECTOR_SCROLL = '[data-conversation-scroll]'
    const SELECTOR_ROW = '[data-variant="think"]'
    const SELECTOR_HEAD = '[data-disclosure-row]'
    // body 类名经 CSS Modules 哈希带前缀(如 QWLzlG_thinkBody),按子串匹配
    const SELECTOR_BODY = '[class*="thinkBody"]'
    const ATTR_STATE = 'data-state'
    const ATTR_EXPANDED = 'aria-expanded'

    // ---- 配置常量 ----

    const OBSERVER_OPTIONS = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [ATTR_EXPANDED, ATTR_STATE],
    }
    const DEBOUNCE_MS = 50
    // 与 Host 半区 settings.register 的命名空间一致
    const SETTINGS_NS = 'think-expand'
    // localStorage 迁移:旧版本开关存这里,首次读到即迁入 Host settings
    const LEGACY_STORAGE_KEY = 'dsh-think-expand:settings'
    const SETTING_OFF = 'off'

    /* LOGIC-BEGIN */
    // 纯逻辑层:与 src/logic.mjs 同源实现,禁止只改其一。

    // 已见文本 Map 容量上限,超出按插入序裁剪最旧条目(手动/已读标记增长有界)。
    const SEEN_MAP_CAP = 10 * 20

    function hashText(text) {
      let h = 5381
      for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
      return (h >>> 0).toString(16)
    }

    function capMap(map, cap = SEEN_MAP_CAP) {
      while (map.size > cap) {
        const oldest = map.keys().next()
        if (oldest.done) break
        map.delete(oldest.value)
      }
      return map
    }

    // 观察器重挂判定:已观察节点为空或与当前容器不一致(容器被重建)即需重挂,
    // 旧观察器 disconnect,避免 detached 节点泄漏与观察永久失效。
    function needsReattach(observed, current) {
      return observed === null || observed !== current
    }

    // 行状态字面量,与官方 ReasoningRow 的 data-state 一致。
    const STATE_RUNNING = 'running'
    const STATE_OK = 'ok'

    // 前缀匹配:空串 seen 会命中任意行,视为无匹配。
    function prefixOf(seen, text) {
      return seen.length > 0 && text.length >= seen.length && text.startsWith(seen)
    }

    function findSeenKey(map, text) {
      for (const [key, seen] of map) {
        if (prefixOf(seen, text)) return key
      }
      return null
    }

    function isCurrent(registry, text) {
      return registry.current !== null && prefixOf(registry.current.seen, text)
    }

    function putSeen(map, text) {
      map.set(hashText(text), text)
      capMap(map)
    }

    function createRegistry() {
      return { marks: new Map(), manual: new Map(), read: new Map(), current: null }
    }

    function findRow(registry, rows, seen) {
      return rows.findIndex((row) => row.headable && prefixOf(seen, row.bodyText))
    }

    // 打开会话/刷新:展开最后一条可识别思考行,其余保持收起。
    // 仅依据内建字段(data-state / aria-expanded)判定,不依赖正文挂载;
    // 存在运行行(流式接管)或其他展开行(用户手动意图)时不干预。
    function planFinal(rows) {
      const actions = []
      if (rows.some((row) => row.headable && row.state === STATE_RUNNING)) return { actions }
      let last = -1
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].headable) {
          last = index
          break
        }
      }
      if (last < 0) return { actions }
      for (let index = 0; index < rows.length; index += 1) {
        if (index !== last && rows[index].headable && rows[index].expanded) return { actions }
      }
      if (!rows[last].expanded) actions.push({ index: last, kind: 'expand' })
      return { actions }
    }

    // 行结构:{ headable, state, bodyText, expanded }。headable=false 表示识别失败,永不干预。
    // 返回 { actions: [{ index, kind: 'expand' | 'collapse' }] },registry 原位更新。
    function plan(registry, rows) {
      const actions = []

      // 手动行识别:已展开但无插件标记且非当前行 → 手动集合,此后永不干预;
      // 手动意图出现即收起当前插件行(至多一条展开)。
      // 仅判定 ok 行:running 行的展开/归属由流式路径管理。
      for (const row of rows) {
        if (!row.headable || !row.expanded || row.state !== STATE_OK) continue
        if (findSeenKey(registry.marks, row.bodyText) !== null) continue
        if (isCurrent(registry, row.bodyText)) continue
        if (findSeenKey(registry.manual, row.bodyText) === null) {
          putSeen(registry.manual, row.bodyText)
          if (registry.current !== null) {
            const currentIndex = findRow(registry, rows, registry.current.seen)
            const currentRow = currentIndex >= 0 ? rows[currentIndex] : null
            if (currentRow !== null && currentRow.expanded) actions.push({ index: currentIndex, kind: 'collapse' })
            registry.marks.delete(registry.current.hash)
            registry.current = null
          }
        }
      }

      if (registry.current !== null) {
        const index = findRow(registry, rows, registry.current.seen)
        if (index < 0 || !rows[index].expanded) {
          putSeen(registry.read, registry.current.seen)
          registry.marks.delete(registry.current.hash)
          registry.current = null
        }
      }

      const running = []
      rows.forEach((row, index) => {
        if (row.headable && row.state === STATE_RUNNING) running.push(index)
      })
      if (running.length !== 1) return { actions }
      const targetIndex = running[0]
      const target = rows[targetIndex]

      if (findSeenKey(registry.manual, target.bodyText) !== null) return { actions }
      if (findSeenKey(registry.read, target.bodyText) !== null) return { actions }
      if (isCurrent(registry, target.bodyText)) return { actions }

      if (registry.current !== null) {
        const oldIndex = findRow(registry, rows, registry.current.seen)
        const oldHash = registry.current.hash
        const oldIsManual = registry.manual.has(oldHash)
        const old = oldIndex >= 0 ? rows[oldIndex] : null
        if (!oldIsManual && old !== null && old.expanded) actions.push({ index: oldIndex, kind: 'collapse' })
        registry.marks.delete(oldHash)
        registry.current = null
      }

      if (!target.expanded) actions.push({ index: targetIndex, kind: 'expand' })
      // 正文未挂载时仅展开不登记,空串 seen 会污染全部前缀匹配;正文挂载后下轮补登记
      if (target.bodyText !== '') {
        const seen = target.bodyText
        registry.current = { hash: hashText(seen), seen }
        putSeen(registry.marks, seen)
      }
      return { actions }
    }

    function teardown(registry, rows) {
      const actions = []
      if (registry.current !== null) {
        const index = findRow(registry, rows, registry.current.seen)
        if (index >= 0 && rows[index].expanded) actions.push({ index, kind: 'collapse' })
      }
      registry.marks.clear()
      registry.manual.clear()
      registry.read.clear()
      registry.current = null
      return { actions }
    }
    /* LOGIC-END */

    // ---- 设置开关:权威值在 Host settings(think-expand.enabled),默认开 ----

    // 旧版本开关存 localStorage,非 off(含无键)按开迁移;迁移读后即清旧键
    function readLegacyEnabled() {
      try {
        const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
        if (raw === null) return null
        window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        return raw !== SETTING_OFF
      } catch {
        return null
      }
    }

    function scopeEnabled(scope) {
      const snapshot = scope.getSnapshot()
      if (snapshot === null || snapshot.value === undefined || snapshot.value === null) return null
      const enabled = snapshot.value.enabled
      return typeof enabled === 'boolean' ? enabled : true
    }

    // ---- DOM 控制器:识别行、执行展开/收起、MutationObserver 接线 ----

    let registry = createRegistry()
    let containerObserver = null
    let bodySentinel = null
    let observedContainer = null
    let debounceTimer = null
    // 容器就绪/重建后待执行的一次性"展开最后一条";
    // finalExpandedEl/finalPendingRegister 追踪已展开行,落定后登记进 registry
    let pendingFinal = false
    let finalExpandedEl = null
    let finalPendingRegister = false

    function describeRow(el) {
      const head = el.querySelector(SELECTOR_HEAD)
      const state = el.getAttribute(ATTR_STATE)
      const body = el.querySelector(SELECTOR_BODY)
      const headable = head !== null && (state === STATE_RUNNING || state === STATE_OK)
      return {
        el,
        headable,
        state,
        bodyText: body !== null ? body.textContent || '' : '',
        expanded: head !== null && head.getAttribute(ATTR_EXPANDED) === 'true',
      }
    }

    // 执行动作并返回被点击的行元素(未触发点击返回 null)
    function applyAction(described, action) {
      const row = described[action.index]
      if (!row || !row.headable) return null
      const head = row.el.querySelector(SELECTOR_HEAD)
      if (head === null) return null
      if (head.getAttribute(ATTR_EXPANDED) !== String(action.kind === 'expand')) {
        head.click()
        return row.el
      }
      return null
    }

    function scan() {
      const container = document.querySelector(SELECTOR_SCROLL)
      if (container === null) return 0
      const described = Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)
      const rows = described.map(({ headable, state, bodyText, expanded }) =>
        ({ headable, state, bodyText, expanded }))
      for (const action of plan(registry, rows).actions) applyAction(described, action)
      return described.length
    }

    // 展开动作落定后登记当前行,使 plan() 识别为插件展开而非手动意图;
    // 行已收起(用户抢先)则放弃登记
    function registerFinal() {
      if (!finalPendingRegister) return
      finalPendingRegister = false
      if (finalExpandedEl === null || !finalExpandedEl.isConnected) return
      const described = describeRow(finalExpandedEl)
      if (!described.expanded) return
      if (described.bodyText === '') {
        finalPendingRegister = true
        return
      }
      registry.current = { hash: hashText(described.bodyText), seen: described.bodyText }
      putSeen(registry.marks, described.bodyText)
    }

    // 容器就绪/重建后执行一次:展开最后一条;
    // 行集为空或全部识别失败(渲染/水合瞬态)则保持挂起,等待后续变更重试
    function tryPlanFinal() {
      const container = document.querySelector(SELECTOR_SCROLL)
      if (container === null) return
      const described = Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)
      if (!described.some((row) => row.headable)) return
      pendingFinal = false
      const rows = described.map(({ headable, state, bodyText, expanded }) =>
        ({ headable, state, bodyText, expanded }))
      for (const action of planFinal(rows).actions) {
        const clicked = applyAction(described, action)
        if (clicked !== null) {
          finalExpandedEl = clicked
          finalPendingRegister = true
        }
      }
    }

    function scheduleScan() {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        registerFinal()
        if (scan() === 0) pendingFinal = true
        else if (pendingFinal) tryPlanFinal()
      }, DEBOUNCE_MS)
    }

    // 容器身份变化(会话切换节点替换)由 body 哨兵捕获:容器自身被移除不在
    // 容器观察器的子树范围内,哨兵是唯一能发现替换的入口
    function ensureAttached() {
      const container = document.querySelector(SELECTOR_SCROLL)
      if (container === null) return
      if (needsReattach(observedContainer, container)) attach(container)
    }

    // 从 body 等待观察切换为容器子树观察,并记录已观察节点。
    // 会话切换不继承标记,registry 重建
    function attach(container) {
      if (containerObserver !== null) containerObserver.disconnect()
      containerObserver = new MutationObserver(scheduleScan)
      containerObserver.observe(container, OBSERVER_OPTIONS)
      observedContainer = container
      registry = createRegistry()
      finalExpandedEl = null
      finalPendingRegister = false
      pendingFinal = true
      scan()
      if (pendingFinal) tryPlanFinal()
    }

    // body 哨兵常驻,监视容器出现与身份变化;发现容器即挂载子树观察。
    function start() {
      if (bodySentinel !== null) return
      bodySentinel = new MutationObserver(ensureAttached)
      bodySentinel.observe(document.body, OBSERVER_OPTIONS)
      ensureAttached()
    }

    // 开关关闭:断开观察,收起全部由本插件展开的行,清空标记。
    function stop() {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (containerObserver !== null) {
        containerObserver.disconnect()
        containerObserver = null
        observedContainer = null
      }
      if (bodySentinel !== null) {
        bodySentinel.disconnect()
        bodySentinel = null
      }
      const container = document.querySelector(SELECTOR_SCROLL)
      const described = container === null
        ? []
        : Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)
      const rows = described.map(({ headable, state, bodyText, expanded }) =>
        ({ headable, state, bodyText, expanded }))
      for (const action of teardown(registry, rows).actions) applyAction(described, action)
      pendingFinal = false
      finalExpandedEl = null
      finalPendingRegister = false
    }

    // ---- 设置面板:"插件配置"卡片,形态复刻官方 PluginCard(默认收起,头部展开) ----

    const CARD_PREFIX = 'te-card'
    const CHEVRON_PATH = 'M3.5 5.75 7 9.25l3.5-3.5'

    function ensureCardStyle() {
      if (document.getElementById('dsh-think-expand-card') !== null) return
      const tag = document.createElement('style')
      tag.id = 'dsh-think-expand-card'
      tag.textContent = '.' + CARD_PREFIX + '{border:1px solid var(--dsw-alias-border-l2);'
        + 'background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}'
        + ' .' + CARD_PREFIX + ':hover{border-color:var(--dsw-alias-label-dimmed)}'
        + ' .' + CARD_PREFIX + '-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}'
        + ' .' + CARD_PREFIX + '__header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;'
        + 'cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}'
        + ' .' + CARD_PREFIX + '__header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}'
        + ' .' + CARD_PREFIX + '__head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}'
        + ' .' + CARD_PREFIX + '__name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}'
        + ' .' + CARD_PREFIX + '__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}'
        + ' .' + CARD_PREFIX + '__chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}'
        + ' .' + CARD_PREFIX + '__chevron-open{transform:rotate(180deg)}'
        + ' .' + CARD_PREFIX + '__body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px}'
        + ' .' + CARD_PREFIX + '__row{display:flex;align-items:center;gap:8px;font-size:13px;line-height:1.5}'
        + ' .' + CARD_PREFIX + '__row input:disabled{cursor:not-allowed}'
      document.head.appendChild(tag)
    }

    function ChevronIcon({ open }) {
      return React.createElement('svg', {
        className: CARD_PREFIX + '__chevron' + (open ? ' ' + CARD_PREFIX + '__chevron-open' : ''),
        width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none',
        'aria-hidden': true,
      }, React.createElement('path', {
        d: CHEVRON_PATH, stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function ThinkExpandCard({ scope }) {
      const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
      const subscribe = useCallback(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])
      React.useEffect(subscribe, [subscribe])
      const [open, setOpen] = useState(false)
      const enabled = scopeEnabled(scope)
      const writable = snapshot !== null && snapshot.writable
      const onToggle = useCallback((event) => {
        void scope.set('enabled', event.target.checked).catch(() => {})
      }, [scope])
      ensureCardStyle()
      const title = '思考自动展开'
      return React.createElement(
        'li',
        { className: CARD_PREFIX + (open ? ' ' + CARD_PREFIX + '-open' : '') },
        React.createElement('button', {
          type: 'button',
          className: CARD_PREFIX + '__header',
          'aria-expanded': open,
          'aria-label': (open ? '收起设置' : '展开设置') + ':' + title,
          onClick: () => setOpen(!open),
        },
        React.createElement('span', { className: CARD_PREFIX + '__head-text' },
          React.createElement('span', { className: CARD_PREFIX + '__name' }, title),
          React.createElement('span', { className: CARD_PREFIX + '__desc' },
            '流式回复时自动展开最新一条思考行,手动操作优先')),
        React.createElement(ChevronIcon, { open })),
        open ? React.createElement('div', { className: CARD_PREFIX + '__body' },
          React.createElement('label', { className: CARD_PREFIX + '__row' },
            React.createElement('input', {
              type: 'checkbox',
              checked: enabled === true,
              disabled: !writable || enabled === null,
              onChange: onToggle,
            }),
            enabled === null ? '设置读取中…' : '流式思考自动展开最新一条'),
        ) : null,
      )
    }

    // 开关状态驱动启停:开关变化即动态启停,页面加载后按 Host 值冷启动。
    function applyEnabled(enabled) {
      if (enabled) start()
      else stop()
    }

    // 初次启动:等 scope ready 后迁移旧 localStorage 值,再按 Host 值启停;
    // 远程只读部署(memory 模式)scope 永不 ready,按默认开运行
    function bootstrap(scope) {
      let migrated = false
      const sync = () => {
        const snapshot = scope.getSnapshot()
        if (snapshot === null) return
        if (snapshot.status === 'unavailable') {
          applyEnabled(true)
          return
        }
        if (snapshot.status !== 'ready') return
        if (!migrated) {
          migrated = true
          const legacy = readLegacyEnabled()
          if (legacy !== null && scopeEnabled(scope) !== legacy) {
            scope.set('enabled', legacy).catch(() => {})
          }
        }
        applyEnabled(scopeEnabled(scope) !== false)
      }
      scope.subscribe(sync)
      sync()
    }

    return {
      inject: ['slots', 'settingsScope'],
      apply(ctx) {
        const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS })
        bootstrap(scope)
        ctx.slots.inject('settings.plugin.item', () =>
          ctx.slots.register(
            { name: 'settings.plugin.item', key: SETTINGS_NS },
            () => React.createElement(ThinkExpandCard, { scope }),
          ))
      },
    }
  },
})
