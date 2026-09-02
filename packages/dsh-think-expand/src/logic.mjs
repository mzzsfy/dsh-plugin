// 纯逻辑层:思考行分类、展开决策、哈希标记存活性。不依赖 DOM,client.js 内嵌同源实现,由 parity 测试保证一致。

// 行状态字面量,与官方 ReasoningRow 的 data-state 一致。
export const STATE_RUNNING = 'running'
export const STATE_OK = 'ok'

// djb2 变体,确定性字符串哈希,作为行标识键。
export function hashText(text) {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

// 已见文本 Map 容量上限,超出按插入序裁剪最旧条目(手动/已读标记增长有界)。
export const SEEN_MAP_CAP = 10 * 20

// 前缀匹配:空串 seen 会命中任意行,视为无匹配。
function prefixOf(seen, text) {
  return seen.length > 0 && text.length >= seen.length && text.startsWith(seen)
}

// 标记匹配按"已见文本前缀",保证流式追加后标记不丢失。
function findSeenKey(map, text) {
  for (const [key, seen] of map) {
    if (prefixOf(seen, text)) return key
  }
  return null
}

function isCurrent(registry, text) {
  return registry.current !== null && prefixOf(registry.current.seen, text)
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

function putSeen(map, text) {
  map.set(hashText(text), text)
  capMap(map)
}

export function createRegistry() {
  return { marks: new Map(), manual: new Map(), read: new Map(), current: null }
}

function findRow(registry, rows, seen) {
  return rows.findIndex((row) => row.headable && prefixOf(seen, row.bodyText))
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

// 行结构:{ headable, state, bodyText, expanded }。headable=false 表示识别失败,永不干预。
// 返回 { actions: [{ index, kind: 'expand' | 'collapse' }] },registry 原位更新。
export function plan(registry, rows) {
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

  // 插件展开的行变为收起 → 手动收起,视为已读。
  if (registry.current !== null) {
    const index = findRow(registry, rows, registry.current.seen)
    if (index < 0 || !rows[index].expanded) {
      putSeen(registry.read, registry.current.seen)
      registry.marks.delete(registry.current.hash)
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

  if (findSeenKey(registry.manual, target.bodyText) !== null) return { actions }
  if (findSeenKey(registry.read, target.bodyText) !== null) return { actions }
  if (isCurrent(registry, target.bodyText)) return { actions }

  // 新思考行出现:收起旧的插件行(手动行除外),展开新行。
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

// 观察器重挂判定:已观察节点为空或与当前容器不一致(容器被重建)即需重挂,
// 旧观察器 disconnect,避免 detached 节点泄漏与观察永久失效。
export function needsReattach(observed, current) {
  return observed === null || observed !== current
}

// 开关关闭:收起全部由本插件展开的行,清空全部标记。
export function teardown(registry, rows) {
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
