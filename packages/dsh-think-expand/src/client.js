// 思考自动展开 Client 半区:纯前端 DOM 插件,流式思考自动展开最新一条。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 的模块表解析。
// 纯逻辑段在 LOGIC 标记之间,与 src/logic.mjs 保持同源,由 parity 测试保证。

window.__ModuleLoader__.load({
  id: 'dsh-think-expand',
  factory(require) {
    const React = require('react')
    const { useState, useCallback } = React

    // ---- 官方 DOM 字面量标识(快照源码核实,不随 CSS Modules 哈希化) ----

    const SELECTOR_SCROLL = '[data-conversation-scroll]'
    const SELECTOR_ROW = '[data-variant="think"]'
    const SELECTOR_HEAD = '[data-disclosure-row]'
    const SELECTOR_BODY = '.thinkBody'
    const ATTR_STATE = 'data-state'
    const ATTR_EXPANDED = 'aria-expanded'

    // ---- 配置常量 ----

    const OBSERVER_OPTIONS = { childList: true, subtree: true }
    const DEBOUNCE_MS = 50
    const STORAGE_KEY = 'dsh-think-expand:settings'
    const SETTING_ON = 'on'
    const SETTING_OFF = 'off'
    const SLOT_ID = 'think-expand'
    // turn-notify 设置段占 41,本插件让位排后
    const SLOT_ORDER = 41 + 1
    const SLOT_LABEL = '思考自动展开'

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

    function prefixOf(seen, text) {
      return text.length >= seen.length && text.startsWith(seen)
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

    // 行结构:{ headable, state, bodyText, expanded }。headable=false 表示识别失败,永不干预。
    // 返回 { actions: [{ index, kind: 'expand' | 'collapse' }] },registry 原位更新。
    function plan(registry, rows) {
      const actions = []

      for (const row of rows) {
        if (!row.headable || !row.expanded) continue
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
      const seen = target.bodyText
      registry.current = { hash: hashText(seen), seen }
      putSeen(registry.marks, seen)
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

    // ---- 设置开关:单个 localStorage 键,默认开 ----

    function readEnabled() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== SETTING_OFF
      } catch {
        return true
      }
    }

    function writeEnabled(enabled) {
      try {
        window.localStorage.setItem(STORAGE_KEY, enabled ? SETTING_ON : SETTING_OFF)
      } catch {
        // 存储不可用时开关仍然生效于当前页面生命周期
      }
    }

    // ---- DOM 控制器:识别行、执行展开/收起、MutationObserver 接线 ----

    const registry = createRegistry()
    let observer = null
    let observedContainer = null
    let debounceTimer = null

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

    function applyAction(described, action) {
      const row = described[action.index]
      if (!row || !row.headable) return
      const head = row.el.querySelector(SELECTOR_HEAD)
      if (head === null) return
      if (head.getAttribute(ATTR_EXPANDED) !== String(action.kind === 'expand')) head.click()
    }

    function scan() {
      const container = document.querySelector(SELECTOR_SCROLL)
      if (container === null) return
      const described = Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)
      const rows = described.map(({ headable, state, bodyText, expanded }) =>
        ({ headable, state, bodyText, expanded }))
      for (const action of plan(registry, rows).actions) applyAction(described, action)
    }

    function scheduleScan() {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const container = document.querySelector(SELECTOR_SCROLL)
        if (container === null) return
        // 容器被重建:旧观察器挂在 detached 节点上,disconnect 后重挂当前容器
        if (needsReattach(observedContainer, container)) attach(container)
        scan()
      }, DEBOUNCE_MS)
    }

    // 从 body 等待观察切换为容器子树观察,并记录已观察节点。
    function attach(container) {
      if (observer !== null) observer.disconnect()
      observer = new MutationObserver(scheduleScan)
      observer.observe(container, OBSERVER_OPTIONS)
      observedContainer = container
      scan()
    }

    // 容器就绪前挂 body 观察等待;就绪后切换为容器子树观察。
    function start() {
      if (observer !== null) return
      observer = new MutationObserver(() => {
        const container = document.querySelector(SELECTOR_SCROLL)
        if (container === null) return
        attach(container)
      })
      observer.observe(document.body, OBSERVER_OPTIONS)
    }

    // 开关关闭:断开观察,收起全部由本插件展开的行,清空标记。
    function stop() {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (observer !== null) {
        observer.disconnect()
        observer = null
        observedContainer = null
      }
      const container = document.querySelector(SELECTOR_SCROLL)
      const described = container === null
        ? []
        : Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)
      const rows = described.map(({ headable, state, bodyText, expanded }) =>
        ({ headable, state, bodyText, expanded }))
      for (const action of teardown(registry, rows).actions) applyAction(described, action)
    }

    // ---- 设置页面板:settings.section 槽位,仅一个开关 ----

    function SettingsApp() {
      const [enabled, setEnabled] = useState(readEnabled())
      const onToggle = useCallback((event) => {
        const next = event.target.checked
        writeEnabled(next)
        setEnabled(next)
        if (next) start()
        else stop()
      }, [])
      return React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' } },
        React.createElement('input', { type: 'checkbox', checked: enabled, onChange: onToggle }),
        '流式思考自动展开最新一条',
      )
    }

    start()

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: SLOT_ID, order: SLOT_ORDER, label: SLOT_LABEL },
            () => React.createElement(SettingsApp),
          ))
      },
    }
  },
})
