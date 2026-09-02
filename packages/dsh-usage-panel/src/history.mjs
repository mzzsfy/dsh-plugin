// 历史快照纯逻辑层:序列键映射 / 档位对齐去重 / 时间修剪 / 硬上限 / 月窗口聚合。
// 数据结构与落盘 history.json 一致:{ [账号id:序列键]: { granularity, points: [{t, v}] } }。

// 窗口 label <-> 序列键后缀 <-> 采样档位,设计文档映射表。
export const SEQUENCE_TIERS = {
  '5h': '10m',
  '7d': '1h',
  month: '1h',
  balance: '1h',
}

const MIN_MS = 60 * 1000
export const GRANULARITY_MS = {
  '10m': 10 * MIN_MS,
  '1h': 60 * MIN_MS,
}

// 留存期点数:短窗口 7 天,长窗口 30 天。
export const RETENTION_POINTS = {
  '10m': 7 * 24 * 6,
  '1h': 30 * 24,
}

// 硬点数上限 = 2 倍留存上界,异常兜底。
export const HARD_POINT_CAP = {
  '10m': 2 * RETENTION_POINTS['10m'],
  '1h': 2 * RETENTION_POINTS['1h'],
}

const LABEL_TO_SUFFIX = { '5小时': '5h', '7天': '7d', 月: 'month' }

export function labelToSuffix(label) {
  return Object.prototype.hasOwnProperty.call(LABEL_TO_SUFFIX, label) ? LABEL_TO_SUFFIX[label] : null
}

export function granularityOf(suffix) {
  return SEQUENCE_TIERS[suffix] || null
}

// 就近对齐到最近档(设计场景组要求:10:07 与 10:14 同归 10:10 档实现档内去重;
// 文档"向下对齐"字样与场景矛盾,以场景为准)。
export function alignTs(t, granularityMs) {
  return Math.round(t / granularityMs) * granularityMs
}

export function newSequenceStore() {
  return {}
}

function retentionMs(granularity) {
  return RETENTION_POINTS[granularity] * GRANULARITY_MS[granularity]
}

// 时间修剪:丢弃早于 now - 留存期 的点。
export function pruneSequence(store, seqKey, now) {
  const seq = store[seqKey]
  if (!seq) return
  const earliest = now - retentionMs(seq.granularity)
  seq.points = seq.points.filter((point) => point.t >= earliest)
}

// 追加快照:向下对齐档位;档内已有点不改写(保档内最前一次);先时间修剪后硬上限。
export function appendPoint(store, seqKey, t, v, now) {
  const granularity = granularityOf(seqKey.slice(seqKey.indexOf(':') + 1))
  if (granularity === null) return
  const granularityMs = GRANULARITY_MS[granularity]
  const aligned = alignTs(t, granularityMs)
  if (!store[seqKey]) store[seqKey] = { granularity, points: [] }
  const seq = store[seqKey]
  if (!seq.points.some((point) => point.t === aligned)) {
    seq.points.push({ t: aligned, v })
    seq.points.sort((a, b) => a.t - b.t)
  }
  pruneSequence(store, seqKey, now === undefined ? aligned : now)
  if (seq.points.length > HARD_POINT_CAP[granularity]) {
    seq.points = seq.points.slice(seq.points.length - HARD_POINT_CAP[granularity])
  }
}

// 读数 -> 快照取样:额度窗口按 label 映射,值优先 remaining(消耗口径)回落 utilization 百分点;
// 余额账号单序列取 remaining 回落 total。
export function readingToSnapshots(reading) {
  if (!reading || typeof reading !== 'object') return []
  if (reading.kind === 'quota') {
    const windows = Array.isArray(reading.windows) ? reading.windows : []
    return windows
      .map((win) => {
        const suffix = labelToSuffix(win && win.label)
        if (suffix === null) return null
        const hasRemaining = win.remaining !== null && win.remaining !== undefined && Number.isFinite(Number(win.remaining))
        const value = hasRemaining ? Number(win.remaining) : Number(win.utilization)
        return Number.isFinite(value) ? { suffix, value, tier: SEQUENCE_TIERS[suffix] } : null
      })
      .filter(Boolean)
  }
  if (reading.kind === 'balance') {
    const entries = Array.isArray(reading.entries) ? reading.entries : []
    const entry = entries[0]
    if (!entry) return []
    const hasRemaining = entry.remaining !== null && entry.remaining !== undefined && Number.isFinite(Number(entry.remaining))
    const value = hasRemaining ? Number(entry.remaining) : Number(entry.total)
    return Number.isFinite(value) ? [{ suffix: 'balance', value, tier: SEQUENCE_TIERS.balance }] : []
  }
  return []
}

// 月窗口聚合:从账号余额序列取当月日历月的点重建月序列(v2 新增序列,host 按快照产出)。
// 月界取宿主本地时区月初零点,与仓库 usage-stats 本地时口径一致。
export function buildMonthSequence(store, accountId, now) {
  const balance = store[accountId + ':balance']
  if (!balance) return
  const nowDate = new Date(now)
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime()
  const points = balance.points
    .filter((point) => point.t >= monthStart && point.t < now)
  store[accountId + ':month'] = { granularity: SEQUENCE_TIERS.month, points: points.map((p) => ({ ...p })) }
}
