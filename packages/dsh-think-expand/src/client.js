// 思考自动展开 Client 半区:纯前端 DOM 插件,流式思考自动展开最新一条。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 纯逻辑段在 LOGIC 标记之间,与 src/logic.mjs 保持同源,由 parity 测试(含逐函数
// 源码文本对比)保证;容器观察器句柄挂 window 代际槽,HMR 重评估先拆上一代。

// 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;键 = 市场短名(发现页
// 收录显示形态);该插件未就绪时入队,由其启动时排空
if (typeof window !== 'undefined') {
  const NAV_ICON = { 'dsh-think-expand': 'spark' }
  if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
  else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
  else window.__navicIconQueue = [NAV_ICON]
}

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
    // 全部消息模式:可展开头带官方 expandable 标记;行键取 flowItem 宿主稳定行键
    const ATTR_EXPANDABLE = 'data-expandable'
    const SELECTOR_FLOW_ITEM = '[data-chat-node-key]'

    // ---- 配置常量 ----

    const OBSERVER_OPTIONS = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [ATTR_EXPANDED, ATTR_STATE],
    }
    // 哨兵只关心容器出现/替换(childList 通道已覆盖),attributes 通道只会带来
    // 全页 aria 扩散回波(含本插件自身点击引发的),独立最小配置
    const SENTINEL_OPTIONS = { childList: true, subtree: true }
    const DEBOUNCE_MS = 50

    // ---- 模式开关:仅思考(默认) / 全部消息;值持久在 localStorage ----

    const STORAGE_KEY = 'dsh-think-expand:expandAll'
    const STORAGE_ON = 'on'

    function readExpandAll() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === STORAGE_ON
      } catch {
        return false
      }
    }

    function writeExpandAll(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? STORAGE_ON : 'off')
      } catch {
        // 存储不可用时开关仅本次会话生效
      }
    }

    let expandAll = readExpandAll()

    /* LOGIC-BEGIN */
    // 纯逻辑层:与 src/logic.mjs 同源实现,禁止只改其一。

    // 已见文本 Map 容量上限,超出按插入序裁剪最旧条目(手动/已读标记增长有界)。
    const SEEN_MAP_CAP = 10 * 20

    // 插件展开行 uid 记录上限(用户收起意图识别用),超出整体清空(防御性有界)。
    const EXPANDED_CAP = 64

    // 置底判定阈值:与官方滚动跟随的贴近底部语义一致,距离底部不超过该值视为置底。
    const PIN_THRESHOLD_PX = 25

    // 置底判定:视口距底部不超过阈值;度量形态 { scrollHeight, scrollTop, clientHeight }。
    function isPinned(metrics, threshold = PIN_THRESHOLD_PX) {
      return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
    }

    // 置底回补判定:动作后偏离底部的量可被本次高度变化解释(官方跟随失效或浏览器
    // 未补偿)才回补;用户在落定窗口内主动滚开的偏离超出该范围,不干预。
    function shouldPinRestore(before, after, threshold = PIN_THRESHOLD_PX) {
      const distance = after.scrollHeight - after.scrollTop - after.clientHeight
      const heightDelta = after.scrollHeight - before.scrollHeight
      return distance <= Math.abs(heightDelta) + threshold
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

    // 标记命中:双侧行身份在场时 uid 优先(流式短前缀快照在不同行同名开头时前缀会错配),
    // 任一侧无 uid 退化为纯前缀匹配。
    function matchMark(entry, uid, text) {
      if (entry.uid !== undefined && uid !== undefined && entry.uid !== uid) return false
      return prefixOf(entry.seen, text)
    }

    function findSeenKey(map, uid, text) {
      for (const [key, entry] of map) {
        if (matchMark(entry, uid, text)) return key
      }
      return null
    }

    function isCurrent(registry, uid, text) {
      return registry.current !== null && matchMark(registry.current, uid, text)
    }

    // 标记以登记时文本为键(消哈希碰撞类),值携带行身份供命中判定。
    function putSeen(map, uid, seen) {
      map.set(seen, { uid, seen })
      capMap(map)
    }

    // uid 记录容量裁剪:超出整体清空(记录仅服务收起意图识别,清空只损失一轮记忆)。
    function capSet(set, cap = EXPANDED_CAP) {
      if (set.size > cap) set.clear()
      return set
    }

    function createRegistry() {
      return { marks: new Map(), manual: new Map(), read: new Map(), current: null, expanded: new Set() }
    }

    // 当前插件行定位:uid 优先(行序上 current 必然靠后,findLastIndex 消解同开头
    // 历史行的前缀错配),无 uid 退化为前缀匹配。
    function findRow(registry, rows) {
      const current = registry.current
      if (current.uid !== undefined) {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index].uid === current.uid) return index
        }
        return -1
      }
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].headable && prefixOf(current.seen, rows[index].bodyText)) return index
      }
      return -1
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

    // 行结构:{ uid, headable, state, bodyText, expanded, plugged }。headable=false 表示识别失败,永不干预;
    // uid 为控制器侧行身份(元素稳定标识),标记命中按 uid 优先、前缀兜底;
    // plugged 为插件动作的闩锁标记(展开记入,收起解除),用于区分手动展开。
    // options.suppressManual 为真时跳过手动识别(容器重挂后首扫,既存展开行视为中性,
    // 防止把上一代插件展开误登记为手动意图)。
    // 返回 { actions: [{ index, kind: 'expand' | 'collapse' }] },registry 原位更新。
    function plan(registry, rows, options = {}) {
      const actions = []

      // 手动行识别:已展开但无插件动作闩锁且非当前行 → 手动集合,此后永不干预;
      // 手动意图出现即收起当前插件行(至多一条展开)。
      // running 行同样识别:插件展开带 plugged 闩锁,无闩锁的展开即用户手动意图;
      // 正文未挂载时不识别,空串 seen 会污染全部前缀匹配。
      if (options.suppressManual !== true) {
        for (const [index, row] of rows.entries()) {
          if (!row.headable || !row.expanded || row.bodyText === '' || row.plugged) continue
          if (findSeenKey(registry.marks, row.uid, row.bodyText) !== null) continue
          if (isCurrent(registry, row.uid, row.bodyText)) continue
          // 回合收尾宿主重建行(uid 变)后,已读标记按纯前缀兜底命中:保持用户收起意图,
          // 不再把该行登记为手动展开(手动集合会永久免干预,收起意图就此丢失)。
          // 同元素重展开例外:插件曾展开过该行(expanded 记录)且 uid 匹配,收起后用户
          // 再次手动展开是新的手动意图,清除已读命中键后落入手动登记;重建行 uid 失配
          // 不命中 expanded,保持收起语义不变。已知权衡:宽松已读(uid 缺失)跨行前缀
          // 命中时,重展开他行会连带清除待重建行的收起保护(同文本前缀 + 双行 + 特定
          // 时序才触发,与宽松已读既有权衡同族)。
          const readKey = findSeenKey(registry.read, row.uid, row.bodyText)
          if (readKey !== null) {
            if (row.uid !== undefined && registry.expanded.has(row.uid)) registry.read.delete(readKey)
            else {
              actions.push({ index, kind: 'collapse' })
              continue
            }
          }
          if (findSeenKey(registry.manual, row.uid, row.bodyText) === null) {
            putSeen(registry.manual, row.uid, row.bodyText)
            if (registry.current !== null) {
              const currentIndex = findRow(registry, rows)
              const currentRow = currentIndex >= 0 ? rows[currentIndex] : null
              if (currentRow !== null && currentRow.expanded) actions.push({ index: currentIndex, kind: 'collapse' })
              registry.marks.delete(registry.current.seen)
              registry.current = null
            }
          }
        }
      }

      // 插件展开的行变为收起 → 手动收起,视为已读。同元素折叠写 uid 限定已读
      // (不拦同开头新回合行);元素定位丢失(宿主回合收尾重建行,uid 失配)时
      // 额外写宽松已读(纯前缀命中),否则收起意图随 uid 失配永久丢失(FIND-RC2-2)。
      if (registry.current !== null) {
        const index = findRow(registry, rows)
        if (index < 0 || !rows[index].expanded) {
          putSeen(registry.read, registry.current.uid, registry.current.seen)
          if (index < 0) putSeen(registry.read, undefined, registry.current.seen)
          registry.marks.delete(registry.current.seen)
          registry.current = null
        }
      }

      // 只处理唯一流式尾块;多行 running 或无 running 均不干预(历史批量/异常降级)。
      const running = []
      rows.forEach((row, index) => {
        if (row.headable && row.state === STATE_RUNNING) running.push(index)
      })
      if (running.length !== 1) return { actions }
      const targetIndex = running[0]
      const target = rows[targetIndex]

      if (findSeenKey(registry.manual, target.uid, target.bodyText) !== null) return { actions }
      if (findSeenKey(registry.read, target.uid, target.bodyText) !== null) return { actions }
      if (isCurrent(registry, target.uid, target.bodyText)) return { actions }

      // 用户对插件已展开 running 行的收起:登记宽松已读(纯前缀,跨 uid 重渲染稳定),
      // 不再周期性强制重展开(FIND-RC2-3);正文未挂载时保留展开记录,正文到位后
      // 下一轮在此补写已读。uid 记录仅服务控制器行(控制器恒派 uid),无 uid 行
      // (测试桩/异常形态)不记录,保持原语义。已知权衡:宽松已读按登记时文本快照
      // 前缀命中,后续回合以该全文为前缀的展开行会被压制自动展开(概率低,cap
      // 裁剪有界),换取收起意图跨重建存活。
      if (!target.expanded && target.uid !== undefined && registry.expanded.has(target.uid)) {
        if (target.bodyText !== '') putSeen(registry.read, undefined, target.bodyText)
        return { actions }
      }

      // 新思考行出现:收起旧的插件行(手动行除外),展开新行。
      if (registry.current !== null) {
        const oldIndex = findRow(registry, rows)
        const oldIsManual = findSeenKey(registry.manual, registry.current.uid, registry.current.seen) !== null
        const old = oldIndex >= 0 ? rows[oldIndex] : null
        if (!oldIsManual && old !== null && old.expanded) actions.push({ index: oldIndex, kind: 'collapse' })
        registry.marks.delete(registry.current.seen)
        registry.current = null
      }

      if (!target.expanded) {
        actions.push({ index: targetIndex, kind: 'expand' })
        if (target.uid !== undefined) capSet(registry.expanded.add(target.uid))
      }
      // 正文未挂载时仅展开不登记,空串 seen 会污染全部前缀匹配;正文挂载后下轮补登记
      if (target.bodyText !== '') registerCurrent(registry, target.uid, target.bodyText)
      return { actions }
    }

    // 当前插件行登记:current 与 marks 的单点写入口,状态形态单点拥有。
    function registerCurrent(registry, uid, seen) {
      registry.current = { uid, seen }
      putSeen(registry.marks, uid, seen)
      if (uid !== undefined) capSet(registry.expanded.add(uid))
    }

    // ---- 全部消息模式:行触达登记与展开决策 ----

    // 用户触达登记值:open = 手动展开过的行,插件持续保持展开;
    // closed = 手动收起过的行,插件不再展开。
    const TOUCH_OPEN = 'open'
    const TOUCH_CLOSED = 'closed'

    // 触达登记容量上限,超出按插入序裁剪最旧条目(登记以会话行数量级增长,有界防御)。
    const ALL_TOUCHED_CAP = 10 * 50

    function createAllRegistry() {
      return { touched: new Map() }
    }

    // 行触达键:宿主稳定行键优先,控制器元素序号兜底。
    function allRowKey(item) {
      return item.key !== undefined ? item.key : item.uid
    }

    // 行目标态:未触达默认展开,触达后以登记值为准。
    function touchedValue(registry, item) {
      const value = registry.touched.get(allRowKey(item))
      return value !== undefined ? value : TOUCH_OPEN
    }

    function putTouched(map, key, value) {
      map.delete(key)
      map.set(key, value)
      capMap(map, ALL_TOUCHED_CAP)
    }

    // 全部消息模式展开决策。行结构:{ uid, key, expandable, expanded, plugged, touched }。
    // key 为宿主稳定行键;touched 为控制器查表结果(键已在登记表)。
    // 动作只补齐目标态差:目标展开且当前收起 → expand。登记规则(suppressManual 首扫除外):
    // 无插件闩锁的展开 = 用户手动意图 → open;有闩锁的收起 = 用户收回插件行 → closed。
    function planAll(registry, rows, options = {}) {
      const actions = []
      if (options.suppressManual !== true) {
        for (const item of rows) {
          if (!item.expandable || item.touched) continue
          if (item.expanded && !item.plugged) putTouched(registry.touched, allRowKey(item), TOUCH_OPEN)
          else if (!item.expanded && item.plugged) putTouched(registry.touched, allRowKey(item), TOUCH_CLOSED)
        }
      }
      for (const [index, item] of rows.entries()) {
        if (!item.expandable || item.expanded) continue
        if (touchedValue(registry, item) !== TOUCH_CLOSED) actions.push({ index, kind: 'expand' })
      }
      return { actions }
    }
    /* LOGIC-END */

    // ---- DOM 控制器:识别行、执行展开/收起、MutationObserver 接线 ----

    let registry = createRegistry()
    // 全部消息模式登记表:行触达标记(用户手动意图),容器重建即重置
    let allRegistry = createAllRegistry()
    // 全部消息模式插件动作闩锁(元素级):展开记入、收起解除;行重建即失效,
    // 重建行视为未触达,自然重新展开
    let allPluggedEls = new WeakSet()
    let containerObserver = null
    let bodySentinel = null
    let observedContainer = null
    // 插件动作闩锁:展开记入、收起解除,语义为"自上次收起以来的插件动作",
    // 保证用户收起后再手动展开同一条能被识别为手动意图(至多一条展开契约)
    let pluginExpandedEls = new WeakSet()
    // 行身份:元素稳定 uid(WeakMap 计数器),行重排/文本增长不影响标记命中
    const rowUidMap = new WeakMap()
    let rowUidSeq = 0
    function rowUid(el) {
      let uid = rowUidMap.get(el)
      if (uid === undefined) {
        rowUidSeq += 1
        uid = rowUidSeq
        rowUidMap.set(el, uid)
      }
      return uid
    }

    // final 握手状态单点:pending(容器就绪待执行)→ awaitRegister(已展开待登记),
    // el 为待登记/待登记中的行元素(登记完成即清引用,不延长 detached 子树寿命)
    const finalState = { pending: false, awaitRegister: false, el: null }

    function describeRow(el) {
      const head = el.querySelector(SELECTOR_HEAD)
      const state = el.getAttribute(ATTR_STATE)
      const headable = head !== null && (state === STATE_RUNNING || state === STATE_OK)
      const body = headable ? el.querySelector(SELECTOR_BODY) : null
      return {
        el,
        uid: rowUid(el),
        headable,
        state,
        bodyText: body !== null ? body.textContent || '' : '',
        expanded: head !== null && head.getAttribute(ATTR_EXPANDED) === 'true',
        plugged: pluginExpandedEls.has(el),
      }
    }

    // 剥离 el 等控制器字段,保持 plan() 纯度(单点定义防行结构加字段时漏改)
    const toLogicRows = (described) => described.map(({ uid, headable, state, bodyText, expanded, plugged }) =>
      ({ uid, headable, state, bodyText, expanded, plugged }))

    // 全部消息模式行集:选择器放行所有行,expandable 由官方折叠头标记判定;
    // 行键取宿主 flowItem 稳定行键(宿主 ChatView 每 flowItem 渲染单 routedNode 单
    // 折叠头,键与行一一对应;无 flowItem 时退化为 head 元素序号,不与宿主键混用),
    // touched 查登记表,plugged 查双闩锁并集(think 机制与 all 机制的插件动作同属插件)
    const collectRowsAll = (container) => Array.from(container.querySelectorAll(SELECTOR_HEAD), (head) => {
      const root = head.closest(SELECTOR_FLOW_ITEM) || head.parentElement
      const key = root.getAttribute('data-chat-node-key') ?? rowUid(head)
      return {
        el: root,
        head,
        uid: rowUid(root),
        key,
        expandable: head.getAttribute(ATTR_EXPANDABLE) !== null,
        expanded: head.getAttribute(ATTR_EXPANDED) === 'true',
        touched: allRegistry.touched.has(key),
        plugged: allPluggedEls.has(root) || pluginExpandedEls.has(root),
      }
    })

    const collectRows = (container) => Array.from(container.querySelectorAll(SELECTOR_ROW), describeRow)

    // 执行动作并返回被点击的行元素(未触发点击返回 null)。
    // 动作改变内容高度会把置底视口推离底部,官方滚动跟随随即失联:
    // 动作前处于置底态时,高度落定后回补置底。
    function applyAction(container, described, action) {
      const row = described[action.index]
      if (!row || !row.headable) return null
      const head = row.el.querySelector(SELECTOR_HEAD)
      if (head === null) return null
      if (head.getAttribute(ATTR_EXPANDED) !== String(action.kind === 'expand')) {
        const before = containerMetrics(container)
        if (action.kind === 'expand') pluginExpandedEls.add(row.el)
        else pluginExpandedEls.delete(row.el)
        head.click()
        if (isPinned(before)) schedulePinRestore(container, before)
        return row.el
      }
      return null
    }

    // 全部消息模式动作执行:批量动作前记一次置底状态,全部落定后回补一次;
    // 闩锁为元素级 WeakSet,展开记入、收起解除
    function applyActionsAll(container, items, actions) {
      if (actions.length === 0) return
      const before = containerMetrics(container)
      for (const action of actions) {
        const item = items[action.index]
        if (!item) continue
        const head = item.head
        if (head.getAttribute(ATTR_EXPANDED) !== String(action.kind === 'expand')) {
          if (action.kind === 'expand') allPluggedEls.add(item.el)
          else allPluggedEls.delete(item.el)
          head.click()
        }
      }
      if (isPinned(before)) schedulePinRestore(container, before)
    }

    // ---- 置底回补 ----

    const containerMetrics = (container) => ({
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
    })

    // 高度落定判定:高度变化后连续 SETTLE_FRAMES 帧不变即落定;
    // 总帧数达上限按已落定兜底(渲染停滞环境不永久挂起)。
    const PIN_SETTLE_FRAMES = 2
    const PIN_SETTLE_MAX_FRAMES = 30

    // 单一挂起回补任务(slot 代际槽):同批多动作时以最新前置度量重启,
    // HMR 重评估经槽身份校验作废。
    function schedulePinRestore(target, before) {
      if (window[SLOT_KEY] !== slot) return
      if (slot.pinFrame !== null) cancelAnimationFrame(slot.pinFrame)
      let lastHeight = before.scrollHeight
      let changed = false
      let stableFrames = 0
      let totalFrames = 0
      const tick = () => {
        slot.pinFrame = null
        if (window[SLOT_KEY] !== slot || target !== observedContainer || !target.isConnected) return
        const metrics = containerMetrics(target)
        if (metrics.scrollHeight !== lastHeight) {
          lastHeight = metrics.scrollHeight
          changed = true
          stableFrames = 0
        } else {
          stableFrames += 1
        }
        totalFrames += 1
        if (totalFrames < PIN_SETTLE_MAX_FRAMES && (!changed || stableFrames < PIN_SETTLE_FRAMES)) {
          slot.pinFrame = requestAnimationFrame(tick)
          return
        }
        if (shouldPinRestore(before, metrics)) target.scrollTop = target.scrollHeight
      }
      slot.pinFrame = requestAnimationFrame(tick)
    }

    function scan() {
      const container = document.querySelector(SELECTOR_SCROLL)
      // 容器身份守卫:容器替换至哨兵回调之间,旧观察器投递的扫描不对新容器用旧 registry 决策
      if (container === null || container !== observedContainer) return 0
      if (expandAll) return scanAll(container, false)
      const described = collectRows(container)
      releaseLatchIfCollapsed(described)
      for (const action of plan(registry, toLogicRows(described)).actions) applyAction(container, described, action)
      return described.length
    }

    // 全部消息模式扫描:先按触达规则登记,再补齐展开差;返回行数供 final 握手判定
    function scanAll(container, suppressManual) {
      const items = collectRowsAll(container)
      const rows = items.map(({ el, head, ...rest }) => rest)
      const result = planAll(allRegistry, rows, { suppressManual })
      applyActionsAll(container, items, result.actions)
      return items.length
    }

    // 用户手动收起不经 applyAction(闩锁解除只发生在插件 collapse 分支):
    // current 行转为收起时在此解除闩锁,使"收起后再手动展开同一条"能被
    // 识别为手动意图,不被新行出现时的接管收起强收
    function releaseLatchIfCollapsed(described) {
      if (registry.current === null) return
      const row = described.find((item) => item.uid === registry.current.uid)
      if (row !== undefined && !row.expanded) pluginExpandedEls.delete(row.el)
    }

    // 展开动作落定后登记当前行,使 plan() 识别为插件展开而非手动意图;
    // 行已收起(用户抢先)则放弃登记
    function registerFinal() {
      if (!finalState.awaitRegister) return
      finalState.awaitRegister = false
      const el = finalState.el
      finalState.el = null
      if (el === null || !el.isConnected) return
      const described = describeRow(el)
      if (!described.expanded) {
        pluginExpandedEls.delete(el)
        return
      }
      if (described.bodyText === '') {
        finalState.el = el
        finalState.awaitRegister = true
        return
      }
      registerCurrent(registry, described.uid, described.bodyText)
    }

    // 容器就绪/重建后执行一次:展开最后一条;
    // 行集为空或全部识别失败(渲染/水合瞬态)则保持挂起,等待后续变更重试
    function tryPlanFinal() {
      const container = document.querySelector(SELECTOR_SCROLL)
      if (container === null) return
      const described = collectRows(container)
      if (!described.some((row) => row.headable)) return
      finalState.pending = false
      for (const action of planFinal(toLogicRows(described)).actions) {
        const clicked = applyAction(container, described, action)
        if (clicked !== null) {
          finalState.el = clicked
          finalState.awaitRegister = true
        }
      }
    }

    // 计时单点挂 slot(代际槽):旧代残余回调(disconnect 不取消已入队微任务)
    // 经槽身份校验作废,防上一代决策机与新代同扫并发点击
    function scheduleScan() {
      if (window[SLOT_KEY] !== slot) return
      if (slot.debounceTimer !== null) clearTimeout(slot.debounceTimer)
      slot.debounceTimer = setTimeout(() => {
        slot.debounceTimer = null
        if (window[SLOT_KEY] !== slot) return
        if (expandAll) {
          // 全部消息模式:final 握手不参与,普通扫描即幂等补齐展开差
          if (scan() === 0) finalState.pending = true
          return
        }
        registerFinal()
        if (scan() === 0) finalState.pending = true
        else if (finalState.pending) tryPlanFinal()
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
    // 会话切换不继承标记,registry 重建;首扫抑制手动识别:
    // 既存展开行视为中性(可能是上一代插件的展开),由 planFinal/流式流程接管
    function attach(container) {
      if (containerObserver !== null) containerObserver.disconnect()
      containerObserver = new MutationObserver(scheduleScan)
      containerObserver.observe(container, OBSERVER_OPTIONS)
      if (slot !== null) slot.containerObserver = containerObserver
      observedContainer = container
      registry = createRegistry()
      allRegistry = createAllRegistry()
      pluginExpandedEls = new WeakSet()
      allPluggedEls = new WeakSet()
      finalState.el = null
      finalState.awaitRegister = false
      finalState.pending = true
      scanSuppressManual()
      if (!expandAll && finalState.pending) tryPlanFinal()
    }

    function scanSuppressManual() {
      const container = observedContainer
      if (container === null) return 0
      if (expandAll) return scanAll(container, true)
      const described = collectRows(container)
      const actions = plan(registry, toLogicRows(described), { suppressManual: true }).actions
      for (const action of actions) applyAction(container, described, action)
      return described.length
    }

    // 模式切换(开关回调):实时生效。
    // → 全部消息:直接重扫补齐展开差;
    // → 仅思考:收起全部插件闩锁(双闩锁并集)内的展开行(手动行保留)并解除全部
    //   闩锁(收起行残留闩锁会让后续手动重展开被 plan 误判插件动作),登记表重置后
    //   走 think 首扫;批量收起与批量展开同构,动作前记置底状态落定后回补
    function setMode(value) {
      expandAll = value
      writeExpandAll(value)
      const container = observedContainer
      if (container === null || !container.isConnected) return
      if (value) {
        scanAll(container, false)
        return
      }
      const items = collectRowsAll(container)
      const before = containerMetrics(container)
      const pinned = isPinned(before)
      for (const item of items) {
        if (!item.plugged) continue
        allPluggedEls.delete(item.el)
        pluginExpandedEls.delete(item.el)
        if (item.expanded) item.head.click()
      }
      if (pinned) schedulePinRestore(container, before)
      registry = createRegistry()
      allRegistry = createAllRegistry()
      finalState.pending = true
      scanSuppressManual()
      if (finalState.pending) tryPlanFinal()
    }

    // body 哨兵常驻,监视容器出现与身份变化;发现容器即挂载子树观察。
    // 代际槽:HMR 同页重评估时先拆上一代观察器与挂起计时,防多套决策机并行同扫
    const SLOT_KEY = Symbol.for('@mzzsfy/dsh-think-expand')
    let slot = null
    function start() {
      if (bodySentinel !== null) return
      const previous = window[SLOT_KEY]
      if (previous !== undefined) {
        if (previous.bodySentinel !== null) previous.bodySentinel.disconnect()
        if (previous.containerObserver !== null) previous.containerObserver.disconnect()
        if (previous.debounceTimer !== null) clearTimeout(previous.debounceTimer)
        if (previous.pinFrame !== null) cancelAnimationFrame(previous.pinFrame)
      }
      slot = { bodySentinel: null, containerObserver: null, debounceTimer: null, pinFrame: null }
      window[SLOT_KEY] = slot
      bodySentinel = new MutationObserver(ensureAttached)
      slot.bodySentinel = bodySentinel
      bodySentinel.observe(document.body, SENTINEL_OPTIONS)
      ensureAttached()
    }

    // ---- 设置卡片:「插件」设置页折叠卡 + 全部消息开关(实时生效,持久 localStorage) ----

    // 包局部视觉 token(plugin-ui-design 契约):引用宿主语义别名,fallback 必填
    const CARD_CSS = [
      ':root { --te-accent: var(--dsw-alias-brand-primary, #1677ff);',
      '  --te-text: var(--dsw-alias-label-primary, #1f2329);',
      '  --te-text-dim: var(--dsw-alias-label-tertiary, #8f959e);',
      '  --te-border: var(--dsw-alias-border-l2, #e5e6eb);',
      '  --te-bg-muted: var(--dsw-alias-bg-module-platform, #f2f3f5); }',
      '.te-card { border:0.5px solid var(--te-border); background:transparent; border-radius:8px;',
      '  width:100%; transition:border-color 0.16s; }',
      '.te-card:hover { border-color:var(--te-text-dim); }',
      '.te-card__header { appearance:none; width:100%; font:inherit; color:inherit; text-align:left; cursor:pointer;',
      '  background:none; border:0; border-radius:8px; align-items:center; gap:12px; padding:14px 16px; display:flex; }',
      '.te-card__header:focus-visible { outline:2px solid var(--te-accent); outline-offset:-2px; }',
      '.te-card__head-text { display:flex; flex-direction:column; flex:1 1 0%; gap:4px; min-width:0; }',
      '.te-card__name { color:var(--te-text); font-size:15px; font-weight:600; line-height:1.4; }',
      '.te-card__description { color:var(--te-text-dim); font-size:13px; line-height:1.5; }',
      '.te-card__chevron { color:var(--te-text-dim); flex:0 0 auto; transition:transform 0.16s; display:inline-flex; }',
      '.te-card--open .te-card__chevron { transform:rotate(180deg); }',
      '.te-card__body { border-top:0.5px solid var(--te-border); margin:0 16px; padding:8px 0 12px;',
      '  display:flex; flex-direction:column; align-items:flex-start; gap:4px; }',
      // 开关行(规约 switch 形态):track 胶囊 + thumb 圆点,状态选择器锚定 checkbox
      '.te-switch { display:inline-flex; align-items:center; gap:8px; margin-top:6px; cursor:pointer;',
      '  font:inherit; font-size:13px; color:var(--te-text-dim); }',
      '.te-switch:hover { color:var(--te-text); }',
      '.te-switch input[type="checkbox"] { position:absolute; width:1px; height:1px; margin:-1px; opacity:0; }',
      '.te-switch__track { position:relative; flex:none; width:36px; height:20px; border-radius:999px;',
      '  background:var(--te-bg-muted); transition:background 0.15s ease; }',
      '.te-switch__thumb { position:absolute; left:2px; top:2px; width:16px; height:16px; border-radius:999px;',
      '  background:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.25); transition:transform 0.15s ease; }',
      '.te-switch input[type="checkbox"]:checked + .te-switch__track { background:var(--te-accent); }',
      '.te-switch input[type="checkbox"]:checked + .te-switch__track .te-switch__thumb { transform:translateX(16px); }',
      '.te-switch input[type="checkbox"]:focus-visible + .te-switch__track { outline:2px solid var(--te-accent); outline-offset:1px; }',
      '@media (prefers-reduced-motion: reduce) { .te-switch__track, .te-switch__thumb, .te-card__chevron { transition:none; } }',
    ].join('\n')

    const CHEVRON_PATH = 'M3.5 5.25L7 8.75L10.5 5.25'

    function ExpandAllPanel() {
      const [open, setOpen] = useState(false)
      const [checked, setChecked] = useState(() => readExpandAll())
      const onToggle = useCallback((event) => {
        setChecked(event.target.checked)
        setMode(event.target.checked)
      }, [])
      return React.createElement('div', { className: 'te-card' + (open ? ' te-card--open' : '') },
        React.createElement('button', {
          type: 'button', className: 'te-card__header', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
        React.createElement('span', { className: 'te-card__head-text' },
          React.createElement('span', { className: 'te-card__name' }, '思考自动展开'),
          React.createElement('span', { className: 'te-card__description' }, '流式思考自动展开;开启后自动展开全部折叠消息')),
        React.createElement('span', { className: 'te-card__chevron', 'aria-hidden': 'true' },
          React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none' },
            React.createElement('path', {
              d: CHEVRON_PATH, stroke: 'currentColor', strokeWidth: '1.2',
              strokeLinecap: 'round', strokeLinejoin: 'round',
            })))),
        open && React.createElement('div', { className: 'te-card__body' },
          React.createElement('label', { className: 'te-switch' },
            React.createElement('input', { type: 'checkbox', checked, onChange: onToggle }),
            React.createElement('span', { className: 'te-switch__track' },
              React.createElement('span', { className: 'te-switch__thumb' })),
            React.createElement('span', { className: 'te-switch__label' }, '展开全部消息')),
        ))
    }

    return {
      // slots 仅服务设置卡片;缺失(声明生命周期门控)时卡片缺席,决策机不受影响
      inject: ['slots'],
      apply(ctx) {
        start()
        const slots = ctx.slots
        if (!slots || typeof slots.inject !== 'function') return
        // 样式挂文档级:设置页未打开时面板不存在,样式随面板注入会裸渲染
        ctx.effect(() => {
          const style = document.createElement('style')
          // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
          style.setAttribute('data-plugin', '@mzzsfy/dsh-think-expand')
          style.textContent = CARD_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'think-expand styles')
        // 设置卡片两代槽位并存注册(context-manager 同构):0.1.6- 为设置页
        // 插件条目槽,0.1.7+ 槽被宿主移除,卡片注册进插件管理页包详情配置槽;
        // 错误世代宿主永不声明该槽,inject 回调挂起不执行,零成本
        slots.inject('settings.plugin.item', () =>
          slots.register(
            { name: 'settings.plugin.item', id: 'think-expand', key: 'think-expand' },
            () => React.createElement(ExpandAllPanel),
          ))
        slots.inject('plugins.bundle.config', () =>
          slots.register(
            { name: 'plugins.bundle.config', key: '@mzzsfy/dsh-think-expand' },
            () => React.createElement(ExpandAllPanel),
          ))
      },
    }
  },
})
