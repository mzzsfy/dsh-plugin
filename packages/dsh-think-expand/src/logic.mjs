// 纯逻辑层:思考行分类、展开决策、标记存活性。不依赖 DOM,client.js 内嵌同源实现,由 parity 测试保证。

// 行状态字面量,与官方 ReasoningRow 的 data-state 一致。
export const STATE_RUNNING = 'running'
export const STATE_OK = 'ok'

// 已见文本 Map 容量上限,超出按插入序裁剪最旧条目(手动/已读标记增长有界)。
export const SEEN_MAP_CAP = 10 * 20

// 插件展开行 uid 记录上限(用户收起意图识别用),超出整体清空(防御性有界)。
export const EXPANDED_CAP = 64

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
export function putSeen(map, uid, seen) {
  map.set(seen, { uid, seen })
  capMap(map)
}

// uid 记录容量裁剪:超出整体清空(记录仅服务收起意图识别,清空只损失一轮记忆)。
export function capSet(set, cap = EXPANDED_CAP) {
  if (set.size > cap) set.clear()
  return set
}

export function createRegistry() {
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

  // 流式目标行:优先唯一 running 尾块;宿主流式态不再标注 running 时(2026-10
  // DOM 变更,行恒 ok)退化为最后一条可识别且正文已挂载的行。多行 running 仍
  // 视为历史批量/异常,不干预。
  const running = []
  rows.forEach((row, index) => {
    if (row.headable && row.state === STATE_RUNNING) running.push(index)
  })
  let targetIndex = -1
  if (running.length === 1) targetIndex = running[0]
  else if (running.length === 0) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].headable && rows[index].bodyText !== '') {
        targetIndex = index
        break
      }
    }
  }
  if (targetIndex < 0) return { actions }
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
  // 正文未挂载时仅展开不登记,空串 seen 会污染全部前缀匹配;正文挂载后下轮补登记。
  // suppressManual 首扫遇既存展开行(无插件闩锁)时不登记:该行属中性既存形态,
  // 登记会把下一拍的常规扫描挡在 isCurrent,手动意图识别永久失效
  if (target.bodyText !== '' && !(target.expanded && options.suppressManual === true)) {
    registerCurrent(registry, target.uid, target.bodyText)
  }
  return { actions }
}

// 当前插件行登记:current 与 marks 的单点写入口,状态形态单点拥有。
export function registerCurrent(registry, uid, seen) {
  registry.current = { uid, seen }
  putSeen(registry.marks, uid, seen)
  if (uid !== undefined) capSet(registry.expanded.add(uid))
}

// ---- 工具机:与思考机独立的第二状态机(展开全部消息模式) ----

// 行结构:{ uid, expandable, expanded, plugged, bodyText }。
// 独立 registry/current/manual/read,与思考机互不读写;共享 seen 存取助手与
// 容量上限。目标行 = 文档序最后一个可展开行(工具流 state 形态多样,不按
// state 选行;preparing 行无官方 expandable 标记天然落选);至多一条工具行展开。
export function createToolsRegistry() {
  return { current: null, marks: new Map(), manual: new Map(), read: new Map(), expanded: new Set() }
}

export function planTools(registry, rows, options = {}) {
  const actions = []

  // 工具行标记命中:uid 双侧在场即按身份命中(工具行正文会被宿主在展开后改写,
  // 文本前缀不可靠);任一侧无 uid 退化为前缀匹配。思考机仍走文本前缀(思考正文
  // 只追加不改写),两机匹配语义分治。
  const seenKey = (map, uid, text) => {
    for (const [key, entry] of map) {
      if (uid !== undefined && entry.uid !== undefined) {
        if (entry.uid === uid) return key
        continue
      }
      if (prefixOf(entry.seen, text)) return key
    }
    return null
  }
  const isCurrentRow = (uid, text) => {
    if (registry.current === null) return false
    if (uid !== undefined && registry.current.uid !== undefined) return registry.current.uid === uid
    return prefixOf(registry.current.seen, text)
  }

  // 手动识别:已展开且无插件闩锁 → manual(永不干预);正文未挂载不识别。
  // 仅在插件已展开过行(current 在场)后识别:首轮既存展开行视为中性,
  // 与思考机"无 running 行不干预"同构,防首扫把用户历史展开误判挡住目标行
  if (options.suppressManual !== true && registry.current !== null) {
    for (const row of rows) {
      if (!row.expandable || !row.expanded || row.bodyText === '' || row.plugged) continue
      if (seenKey(registry.marks, row.uid, row.bodyText) !== null) continue
      if (isCurrentRow(row.uid, row.bodyText)) continue
      const readKey = seenKey(registry.read, row.uid, row.bodyText)
      if (readKey !== null) {
        if (row.uid !== undefined && registry.expanded.has(row.uid)) registry.read.delete(readKey)
        continue
      }
      if (seenKey(registry.manual, row.uid, row.bodyText) === null) {
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

  // 插件展开行被收起 → 已读(该工具行不再展开)
  if (registry.current !== null) {
    const index = findRow(registry, rows)
    if (index < 0 || !rows[index].expandable || !rows[index].expanded) {
      putSeen(registry.read, registry.current.uid, registry.current.seen)
      if (index < 0) putSeen(registry.read, undefined, registry.current.seen)
      registry.marks.delete(registry.current.seen)
      registry.current = null
    }
  }

  // 目标行:文档序最后一个可展开行;无则不干预
  let targetIndex = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].expandable) { targetIndex = index; break }
  }
  if (targetIndex < 0) return { actions }
  const target = rows[targetIndex]

  if (seenKey(registry.manual, target.uid, target.bodyText) !== null) return { actions }
  if (seenKey(registry.read, target.uid, target.bodyText) !== null) return { actions }
  if (isCurrentRow(target.uid, target.bodyText)) return { actions }

  // 插件展开过的目标行被收起(如回合收尾重建后):登记宽松已读,不强制重展开
  if (!target.expanded && target.uid !== undefined && registry.expanded.has(target.uid)) {
    if (target.bodyText !== '') putSeen(registry.read, undefined, target.bodyText)
    return { actions }
  }

  // 新目标行:收起旧插件行(手动行除外),展开目标行
  if (registry.current !== null) {
    const oldIndex = findRow(registry, rows)
    const oldIsManual = seenKey(registry.manual, registry.current.uid, registry.current.seen) !== null
    const old = oldIndex >= 0 ? rows[oldIndex] : null
    if (!oldIsManual && old !== null && old.expanded) actions.push({ index: oldIndex, kind: 'collapse' })
    registry.marks.delete(registry.current.seen)
    registry.current = null
  }

  if (!target.expanded) {
    actions.push({ index: targetIndex, kind: 'expand' })
    if (target.uid !== undefined) capSet(registry.expanded.add(target.uid))
  }
  if (target.bodyText !== '') registerCurrent(registry, target.uid, target.bodyText)
  return { actions }
}

// 观察器重挂判定:已观察节点为空或与当前容器不一致(容器被重建)即需重挂,
// 旧观察器 disconnect,避免 detached 节点泄漏与观察永久失效。
export function needsReattach(observed, current) {
  return observed === null || observed !== current
}
