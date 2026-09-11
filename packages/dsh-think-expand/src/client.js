// 思考自动展开 Client 半区:纯前端 DOM 插件,流式思考自动展开最新一条。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory})。
// 纯逻辑段在 LOGIC 标记之间,与 src/logic.mjs 保持同源,由 parity 测试(含逐函数
// 源码文本对比)保证;容器观察器句柄挂 window 代际槽,HMR 重评估先拆上一代。

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
    // 哨兵只关心容器出现/替换(childList 通道已覆盖),attributes 通道只会带来
    // 全页 aria 扩散回波(含本插件自身点击引发的),独立最小配置
    const SENTINEL_OPTIONS = { childList: true, subtree: true }
    const DEBOUNCE_MS = 50

    /* LOGIC-BEGIN */
    // 纯逻辑层:与 src/logic.mjs 同源实现,禁止只改其一。

    // 已见文本 Map 容量上限,超出按插入序裁剪最旧条目(手动/已读标记增长有界)。
    const SEEN_MAP_CAP = 10 * 20

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

    function createRegistry() {
      return { marks: new Map(), manual: new Map(), read: new Map(), current: null }
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
        for (const row of rows) {
          if (!row.headable || !row.expanded || row.bodyText === '' || row.plugged) continue
          if (findSeenKey(registry.marks, row.uid, row.bodyText) !== null) continue
          if (isCurrent(registry, row.uid, row.bodyText)) continue
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

      // 插件展开的行变为收起 → 手动收起,视为已读。
      if (registry.current !== null) {
        const index = findRow(registry, rows)
        if (index < 0 || !rows[index].expanded) {
          putSeen(registry.read, registry.current.uid, registry.current.seen)
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

      // 新思考行出现:收起旧的插件行(手动行除外),展开新行。
      if (registry.current !== null) {
        const oldIndex = findRow(registry, rows)
        const oldIsManual = findSeenKey(registry.manual, registry.current.uid, registry.current.seen) !== null
        const old = oldIndex >= 0 ? rows[oldIndex] : null
        if (!oldIsManual && old !== null && old.expanded) actions.push({ index: oldIndex, kind: 'collapse' })
        registry.marks.delete(registry.current.seen)
        registry.current = null
      }

      if (!target.expanded) actions.push({ index: targetIndex, kind: 'expand' })
      // 正文未挂载时仅展开不登记,空串 seen 会污染全部前缀匹配;正文挂载后下轮补登记
      if (target.bodyText !== '') registerCurrent(registry, target.uid, target.bodyText)
      return { actions }
    }

    // 当前插件行登记:current 与 marks 的单点写入口,状态形态单点拥有。
    function registerCurrent(registry, uid, seen) {
      registry.current = { uid, seen }
      putSeen(registry.marks, uid, seen)
    }
    /* LOGIC-END */

    // ---- DOM 控制器:识别行、执行展开/收起、MutationObserver 接线 ----

    let registry = createRegistry()
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
      const described = collectRows(container)
      releaseLatchIfCollapsed(described)
      for (const action of plan(registry, toLogicRows(described)).actions) applyAction(container, described, action)
      return described.length
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
      pluginExpandedEls = new WeakSet()
      finalState.el = null
      finalState.awaitRegister = false
      finalState.pending = true
      scanSuppressManual()
      if (finalState.pending) tryPlanFinal()
    }

    function scanSuppressManual() {
      const container = observedContainer
      if (container === null) return 0
      const described = collectRows(container)
      const actions = plan(registry, toLogicRows(described), { suppressManual: true }).actions
      for (const action of actions) applyAction(container, described, action)
      return described.length
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

    return {
      apply() {
        start()
      },
    }
  },
})
