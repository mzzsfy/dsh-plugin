// 用量面板聚合用例:一次面板请求 = 按范围扫桶行 + 聚合为槽位序列。
// 输入规模取真实数据面 2223 桶行(分钟档历史最多),覆盖三种粒度。
import { SCALE } from '../scale.mjs'
import { seededRandom } from '../lib.mjs'
import { aggregateRange } from '../../../packages/dsh-usage-dash/src/query.js'
import { dayKey, hourKey, minuteKey } from '../../../packages/dsh-usage-dash/src/store.js'

// 锚点取本月固定日,使桶串与枚举序列在同一本地时区下稳定
const ANCHOR = new Date(2026, 10, 11, 0, 0, 0).getTime()
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MINUTE_BUCKET_MS = 10 * MINUTE_MS
const SEED = 20261111
const MODELS = [
  ['default', '(unknown)'],
  ['newapi', 'newapi/auto'],
  ['glm2', 'glm2/glm-5.3-flash'],
  ['anthropic', 'anthropic/claude-sonnet-4'],
]

const pick = (random, list) => list[Math.floor(random() * list.length)]

function buildRow(random, bucket, [provider, model]) {
  const inputTokens = Math.floor(random() * 8000)
  const outputTokens = Math.floor(random() * 3000)
  return {
    bucket,
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.floor(random() * 20000),
    cacheWriteTokens: Math.floor(random() * 4000),
    durationMs: Math.floor(random() * 60000),
    decodeTokens: outputTokens,
    ttftMs: Math.floor(random() * 5000),
    ttftSteps: Math.floor(random() * 20),
    requests: Math.floor(random() * 10),
    turns: Math.floor(random() * 5),
    lastSeen: ANCHOR,
  }
}

function buildRows() {
  const random = seededRandom(SEED)
  const rows = []
  for (let index = 0; index < SCALE.usageMinutes; index += 1) {
    rows.push(buildRow(random, minuteKey(ANCHOR - index * MINUTE_BUCKET_MS), pick(random, MODELS)))
  }
  for (let index = 0; index < SCALE.usageHours; index += 1) {
    rows.push(buildRow(random, hourKey(ANCHOR - index * HOUR_MS), pick(random, MODELS)))
  }
  for (let index = 0; index < SCALE.usageDays; index += 1) {
    rows.push(buildRow(random, dayKey(ANCHOR - index * DAY_MS), pick(random, MODELS)))
  }
  return rows
}

function buildSessionRows() {
  const random = seededRandom(SEED + 1)
  const rows = []
  for (let index = 0; index < SCALE.usageSessionRows; index += 1) {
    const sessions = []
    const count = 1 + Math.floor(random() * 5)
    for (let offset = 0; offset < count; offset += 1) sessions.push(`session-${Math.floor(random() * 100000)}`)
    rows.push({ bucket: index % 2 === 0 ? dayKey(ANCHOR - index * DAY_MS) : hourKey(ANCHOR - index * HOUR_MS), sessions })
  }
  return rows
}

const rows = buildRows()
const sessionRows = buildSessionRows()
const ranges = {
  D: [dayKey(ANCHOR - 182 * DAY_MS), dayKey(ANCHOR)],
  H: [hourKey(ANCHOR - 15 * DAY_MS), hourKey(ANCHOR)],
  M: [minuteKey(ANCHOR - 7 * DAY_MS), minuteKey(ANCHOR)],
}

export const cases = [
  {
    name: 'usage-dash/aggregateRange-M',
    description: '分钟粒度 7 天窗口聚合(1008 槽位)',
    scale: `${rows.length} 桶行`,
    iterations: 20,
    setup: () => ranges.M,
    run: (range) => aggregateRange(rows, 'M', range[0], range[1], sessionRows),
  },
  {
    name: 'usage-dash/aggregateRange-H',
    description: '小时粒度 15 天窗口聚合(360 槽位)',
    scale: `${rows.length} 桶行`,
    iterations: 20,
    setup: () => ranges.H,
    run: (range) => aggregateRange(rows, 'H', range[0], range[1], sessionRows),
  },
  {
    name: 'usage-dash/aggregateRange-D',
    description: '天粒度 26 周窗口聚合(182 槽位)',
    scale: `${rows.length} 桶行`,
    iterations: 20,
    setup: () => ranges.D,
    run: (range) => aggregateRange(rows, 'D', range[0], range[1], sessionRows),
  },
]

export default cases[0]
