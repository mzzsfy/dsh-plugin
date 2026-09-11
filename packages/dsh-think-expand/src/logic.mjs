// 纯逻辑层:思考行分类、展开决策、标记存活性。不依赖 DOM,client.js 内嵌同源实现,由 parity 测试保证。

// 行状态字面量,与官方 ReasoningRow 的 data-state 一致。
export const STATE_RUNNING = 'running'
export const STATE_OK = 'ok'

// 已见文本 Map 容量上限,超出按插入序裁剪最旧条目(手动/已读标记增长有界)。
export const SEEN_MAP_CAP = 10 * 20

// 置底判定阈值:与官方滚动跟随的贴近底部语义一致,距离底部不超过该值视为置底。
export const PIN_THRESHOLD_PX = 25

// 置底判定:视口距底部不超过阈值;度量形态 { scrollHeight, scrollTop, clientHeight }。
export function isPinned(metrics, threshold = PIN_THRESHOLD_PX) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

// 置底回补判定:动作后偏离底部的量可被本次高度变化解释(官方跟随失效或浏览器
// 未补偿)才回补;用户在落定窗口内主动滚开的偏离超出该范围,不干预。
export function shouldPinRestore(before, after, threshold = PIN_THRESHOLD_PX) {
  const distance = after.scrollHeight - after.scrollTop - after.clientHeight
  const heightDelta = after.scrollHeight - before.scrollHeight
  return distance <= Math.abs(heightDelta) + threshold
}

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

// 容量裁剪:超出上限按插入序删除最旧条目。
export function capMap(map, cap = SEEN_MAP_CAP) {
  while (map.size > cap) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
  return map
}

// 标记以登记时文本为键(消哈希碰撞类),值携带行身份供命中判定。
function putSeen(map, uid, seen) {
  map.set(seen, { uid, seen })
  capMap(map)
}

export function createRegistry() {
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
export function planFinal(rows) {
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
export function plan(registry, rows, options = {}) {
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
export function registerCurrent(registry, uid, seen) {
  registry.current = { uid, seen }
  putSeen(registry.marks, uid, seen)
}

// 观察器重挂判定:已观察节点为空或与当前容器不一致(容器被重建)即需重挂,
// 旧观察器 disconnect,避免 detached 节点泄漏与观察永久失效。
export function needsReattach(observed, current) {
  return observed === null || observed !== current
}
