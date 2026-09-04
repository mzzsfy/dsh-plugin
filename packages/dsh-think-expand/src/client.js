// 思考自动展开 Client 半区:纯前端 DOM 插件,流式思考自动展开最新一条。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 纯逻辑段在 LOGIC 标记之间,与 src/logic.mjs 保持同源,由 parity 测试保证。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-think-expand',
  factory(require) {
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

    // 行结构:{ headable, state, bodyText, expanded, plugged }。headable=false 表示识别失败,永不干预;
    // plugged 为插件动作的内存标记(控制层执行展开时记入 WeakSet,不写 DOM 属性),用于区分手动展开。
    // 返回 { actions: [{ index, kind: 'expand' | 'collapse' }] },registry 原位更新。
    function plan(registry, rows) {
      const actions = []

      // 手动行识别:已展开但无插件动作标记且非当前行 → 手动集合,此后永不干预;
      // 手动意图出现即收起当前插件行(至多一条展开)。
      // running 行同样识别:插件展开带 plugged 标记,无标记的展开即用户手动意图;
      // 正文未挂载时不识别,空串 seen 会污染全部前缀匹配。
      for (const row of rows) {
        if (!row.headable || !row.expanded || row.bodyText === '' || row.plugged) continue
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
    /* LOGIC-END */

    // ---- DOM 控制器:识别行、执行展开/收起、MutationObserver 接线 ----

    let registry = createRegistry()
    let containerObserver = null
    let bodySentinel = null
    let observedContainer = null
    let debounceTimer = null
    // 插件动作标记:展开过的行元素记入 WeakSet,用于 plan() 区分手动展开;
    // 只存内存不写 DOM 属性,元素移除自动回收。React 复用元素节点时陈旧标记
    // 可能压制该位置新行的手动识别,概率极低,为已知局限。
    let pluginExpandedEls = new WeakSet()
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
        plugged: pluginExpandedEls.has(el),
      }
    }

    // 执行动作并返回被点击的行元素(未触发点击返回 null)
    function applyAction(described, action) {
      const row = described[action.index]
      if (!row || !row.headable) return null
      const head = row.el.querySelector(SELECTOR_HEAD)
      if (head === null) return null
      if (head.getAttribute(ATTR_EXPANDED) !== String(action.kind === 'expand')) {
        if (action.kind === 'expand') pluginExpandedEls.add(row.el)
        head.click()
        return row.el
      }
      return null
    }

    function scan() {
      const container = document.querySelector(SELECTOR_SCROLL)
      if (container === null) return 0
      const described = Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)
      const rows = described.map(({ headable, state, bodyText, expanded, plugged }) =>
        ({ headable, state, bodyText, expanded, plugged }))
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
      const rows = described.map(({ headable, state, bodyText, expanded, plugged }) =>
        ({ headable, state, bodyText, expanded, plugged }))
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
      pluginExpandedEls = new WeakSet()
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

    return {
      apply() {
        start()
      },
    }
  },
})
