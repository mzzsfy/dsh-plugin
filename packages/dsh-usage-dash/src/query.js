import { costOf, matchPrice } from './pricing.js'

export const MAX_SLOTS = 2000

const PAD_WIDTH = 2
const PERCENT_SCALE = 100
const MS_PER_SECOND = 1000

const GRANULARITY_DAILY = 'D'
const GRANULARITY_HOURLY = 'H'
const GRANULARITY_MINUTE = 'M'

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const HOUR_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/
const MINUTE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

// 妗朵覆鍓嶇紑瀹?D 娈靛畾浣嶆棩妗?M 琛屾埅鍙栫埗 H 妗?
const DAY_KEY_WIDTH = 'YYYY-MM-DD'.length
const HOUR_KEY_WIDTH = 'YYYY-MM-DDTHH'.length

const pad = (value) => String(value).padStart(PAD_WIDTH, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const formatHour = (date) => `${formatDate(date)}T${pad(date.getHours())}`
const formatMinute = (date) => `${formatHour(date)}:${pad(date.getMinutes())}`

const nextDay = (date) => {
  const next = new Date(date)
  next.setDate(next.getDate() + 1)
  return next
}
const nextHour = (date) => {
  const next = new Date(date)
  next.setHours(next.getHours() + 1)
  return next
}
const nextMinute = (date) => {
  const next = new Date(date)
  next.setMinutes(next.getMinutes() + MINUTE_STEP_MINUTES)
  return next
}

// 鍒嗛挓妗剁矑搴?鏋氫妇涓庢《閿叡鐢ㄥ悓涓€姝ラ暱,from 蹇呴』瀵归綈妗惰竟鐣?
const MINUTE_STEP_MINUTES = 10

// pattern 閿氬畾妗朵覆澶栧舰,suffix 琛ュ叏涓烘湰鍦版椂鍖哄彲瑙ｆ瀽鏃ユ湡涓?format 鍥炶鏍￠獙鍒嗛噺鍚堟硶鎬?
const BUCKET_FORMS = {
  [GRANULARITY_DAILY]: { pattern: DAY_KEY_PATTERN, suffix: 'T00:00:00', format: formatDate, step: nextDay },
  [GRANULARITY_HOURLY]: { pattern: HOUR_KEY_PATTERN, suffix: ':00:00', format: formatHour, step: nextHour },
  [GRANULARITY_MINUTE]: { pattern: MINUTE_KEY_PATTERN, suffix: ':00', format: formatMinute, step: nextMinute, align: MINUTE_STEP_MINUTES },
}

const parseBucketKey = (key, form) => {
  if (typeof key !== 'string' || !form.pattern.test(key)) return null
  const parsed = new Date(`${key}${form.suffix}`)
  return Number.isNaN(parsed.getTime()) || form.format(parsed) !== key ? null : parsed
}

const enumerateBucketKeys = (form) => (from, to) => {
  const start = parseBucketKey(from, form)
  const end = parseBucketKey(to, form)
  if (!start || !end) return []
  if (form.align && start.getMinutes() % form.align !== 0) return []
  const keys = []
  for (let cursor = start, key = form.format(cursor); key <= to; key = form.format(cursor)) {
    keys.push(key)
    cursor = form.step(cursor)
  }
  return keys
}

export const daysInRange = enumerateBucketKeys(BUCKET_FORMS[GRANULARITY_DAILY])
export const hourKeysInRange = enumerateBucketKeys(BUCKET_FORMS[GRANULARITY_HOURLY])
export const minuteKeysInRange = enumerateBucketKeys(BUCKET_FORMS[GRANULARITY_MINUTE])

const emptySlot = (day) => ({
  day,
  total: 0,
  byModel: {},
  byProvider: {},
  requests: 0,
  turns: 0,
  cacheHit: 0,
  cacheMiss: 0,
})

const addRowToSlot = (slot, row, tokens) => {
  slot.total += tokens
  slot.requests += row.requests
  slot.turns += row.turns
  slot.cacheHit += row.cacheReadTokens
  slot.cacheMiss += row.inputTokens + row.cacheWriteTokens
}

const percentOf = (part, total) => (total === 0 ? 0 : (part / total) * PERCENT_SCALE)

const rowTokens = (row) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens

// 閫熷害閰嶅鍒嗗瓙:decode 鍙ｅ緞鍙?decodeTokens;瀛橀噺鏃ф牸寮忚(甯︽椂闀挎棤 decodeTokens)
// 鍥炶惤 outputTokens,鑱氬悎闅忔柊鏁版嵁鑷劧鏀舵暃
const speedTokensOf = (row) => (row.durationMs ? row.decodeTokens ?? row.outputTokens : 0)

export function aggregateRange(rows, g, from, to) {
  const form = BUCKET_FORMS[g]
  const slots = enumerateBucketKeys(form)(from, to).map((key) => emptySlot(key))
  const slotByKey = new Map(slots.map((slot) => [slot.day, slot]))
  const modelTotals = new Map()
  const providerTotals = new Map()
  const activeBuckets = new Set()
  // 妲界骇閰嶅:妗朵覆 鈫?閫熷害瀵?{decodeTokens, durationMs} 涓庨瀛楀 {ttftMs, ttftSteps},
  const slotSpeeds = new Map()
  const slotTtfts = new Map()
  for (const row of rows) {
    const slot = slotByKey.get(row.bucket)
    // 妗朵覆鏈惤鍦ㄦ灇涓惧簭鍒?濡傛敼绮掑害鍓嶇殑鍘嗗彶娈嬭)涓嶅彲褰掑睘,璺宠繃闃插穿
    if (!slot) continue
    const tokens = rowTokens(row)
    addRowToSlot(slot, row, tokens)
    // 绾?timing 琛?闆?token 妗?+ decode 閰嶅)涓嶅弬涓庡綊灞?浣嗕粛杩涢厤瀵硅仛鍚?
    if (tokens > 0) {
      activeBuckets.add(row.bucket)
      slot.byModel[row.model] = (slot.byModel[row.model] ?? 0) + tokens
      slot.byProvider[row.provider] = (slot.byProvider[row.provider] ?? 0) + tokens
    }
    if (row.durationMs) {
      const pair = slotSpeeds.get(row.bucket) ?? { decodeTokens: 0, durationMs: 0 }
      pair.decodeTokens += speedTokensOf(row)
      pair.durationMs += row.durationMs
      slotSpeeds.set(row.bucket, pair)
    }
    if (row.ttftSteps > 0) {
      const pair = slotTtfts.get(row.bucket) ?? { ttftMs: 0, ttftSteps: 0 }
      pair.ttftMs += row.ttftMs ?? 0
      pair.ttftSteps += row.ttftSteps
      slotTtfts.set(row.bucket, pair)
    }
    const modelTotal = modelTotals.get(row.model)
    if (modelTotal) {
      modelTotal.tokens += tokens
      modelTotal.inputTokens += row.inputTokens
      modelTotal.outputTokens += row.outputTokens
      modelTotal.cacheReadTokens += row.cacheReadTokens
      modelTotal.cacheWriteTokens += row.cacheWriteTokens
      modelTotal.speedDurationMs += row.durationMs ?? 0
      modelTotal.speedOutputTokens += speedTokensOf(row)
      modelTotal.ttftMs += row.ttftMs ?? 0
      modelTotal.ttftSteps += row.ttftSteps ?? 0
    } else {
      modelTotals.set(row.model, {
        provider: row.provider,
        tokens,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        speedDurationMs: row.durationMs ?? 0,
        speedOutputTokens: speedTokensOf(row),
        ttftMs: row.ttftMs ?? 0,
        ttftSteps: row.ttftSteps ?? 0,
      })
    }
    providerTotals.set(row.provider, (providerTotals.get(row.provider) ?? 0) + tokens)
  }
  for (const slot of slots) {
    const speedPair = slotSpeeds.get(slot.day)
    if (speedPair && speedPair.durationMs > 0) slot.speed = speedPair.decodeTokens / (speedPair.durationMs / MS_PER_SECOND)
    const ttftPair = slotTtfts.get(slot.day)
    if (ttftPair && ttftPair.ttftSteps > 0) slot.ttft = ttftPair.ttftMs / ttftPair.ttftSteps
  }
  const totals = { tokens: 0, requests: 0, turns: 0, cacheHit: 0, cacheMiss: 0 }
  for (const slot of slots) {
    totals.tokens += slot.total
    totals.requests += slot.requests
    totals.turns += slot.turns
    totals.cacheHit += slot.cacheHit
    totals.cacheMiss += slot.cacheMiss
  }
  // speed = decode 閰嶅鍙ｅ緞(decodeTokens 梅 鏃堕暱绉?;ttft = 棣?token 寤惰繜
  // 鍔犳潈骞冲潎(姣);浠呴厤瀵规暟鎹瓨鍦ㄧ殑鏉＄洰鎸傚瓧娈?鏃犳暟鎹潯鐩笉鎸?
  // 绾?timing 琛屽彲鑳戒骇鐢?0-token 鏉＄洰,鍒楄〃淇濇寔鍙惈 token 琛?瀛橀噺濂戠害)
  const models = [...modelTotals.entries()]
    .filter(([, agg]) => agg.tokens > 0)
    .map(([model, agg]) => ({
      model,
      provider: agg.provider,
      tokens: agg.tokens,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      percent: percentOf(agg.tokens, totals.tokens),
      ...(agg.speedDurationMs > 0 ? { speed: agg.speedOutputTokens / (agg.speedDurationMs / MS_PER_SECOND) } : {}),
      ...(agg.ttftSteps > 0 ? { ttft: agg.ttftMs / agg.ttftSteps } : {}),
    }))
    .sort((a, b) => b.tokens - a.tokens)
  const providers = [...providerTotals.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([provider, tokens]) => ({ provider, tokens, percent: percentOf(tokens, totals.tokens) }))
    .sort((a, b) => b.tokens - a.tokens)
  const truncated = slots.length > MAX_SLOTS
  const daily = truncated ? slots.slice(-MAX_SLOTS) : slots
  const top = models[0]
  const result = {
    from,
    to,
    tokens: totals.tokens,
    requests: totals.requests,
    turns: totals.turns,
    cacheHit: totals.cacheHit,
    cacheMiss: totals.cacheMiss,
    activeDays: activeBuckets.size,
    topModel: top?.model ?? '',
    topProvider: top?.provider ?? '',
    daily,
    models,
    providers,
  }
  if (truncated) result.truncated = true
  return result
}

// 鑱氬悎璁′环鐨勬Ы瀹氫綅:D 鎶樺彔鍒版棩妲?H/M 鍗虫湰妲?璁′环涓€寰嬪彇琛屾墍灞?H 妲借捣鐐?
const COST_SLOT_KEYS = {
  [GRANULARITY_DAILY]: (bucket) => bucket.slice(0, DAY_KEY_WIDTH),
  [GRANULARITY_HOURLY]: (bucket) => bucket,
  [GRANULARITY_MINUTE]: (bucket) => bucket,
}

// 鑱氬悎璁′环:浠ュ彲瑙佹Ы涓哄敮涓€鍙ｅ緞,cost 琛屾寜 H 妲借捣鐐瑰尮閰嶄环鏍煎悗绱姞;
// 妲界骇閫愭ā鍨嬫媶鍒?costByModel 渚涢噾棰濇煴鐘跺浘鎸夋ā鍨嬪爢鍙?
export function attachCosts(result, costRows, granularity, rules) {
  const slotKeyOf = COST_SLOT_KEYS[granularity]
  const slotOfDay = new Map(result.daily.map((slot) => [slot.day, slot]))
  const slotCosts = new Map()
  const slotCostsByModel = new Map()
  const modelCosts = new Map(result.models.map((entry) => [entry.model, 0]))
  const unpricedHours = new Set()
  for (const row of costRows) {
    const slot = slotOfDay.get(slotKeyOf(row.bucket))
    if (!slot || rowTokens(row) === 0) continue
    const hourKey = row.bucket.slice(0, HOUR_KEY_WIDTH)
    const date = parseBucketKey(hourKey, BUCKET_FORMS[GRANULARITY_HOURLY])
    if (!date) continue
    const price = matchPrice(rules, row.model, date)
    if (!price) {
      unpricedHours.add(hourKey)
      continue
    }
    const cost = costOf(price, row)
    slotCosts.set(slot.day, (slotCosts.get(slot.day) ?? 0) + cost)
    let perModel = slotCostsByModel.get(slot.day)
    if (perModel === undefined) {
      perModel = new Map()
      slotCostsByModel.set(slot.day, perModel)
    }
    perModel.set(row.model, (perModel.get(row.model) ?? 0) + cost)
    if (modelCosts.has(row.model)) modelCosts.set(row.model, modelCosts.get(row.model) + cost)
  }
  const daily = result.daily.map((slot) => ({
    ...slot,
    cost: slotCosts.get(slot.day) ?? 0,
    costByModel: Object.fromEntries(slotCostsByModel.get(slot.day) ?? []),
  }))
  const cost = daily.reduce((sum, slot) => sum + slot.cost, 0)
  const models = result.models.map((entry) => ({ ...entry, cost: modelCosts.get(entry.model) }))
  return { ...result, daily, models, cost, unpriced: unpricedHours.size }
}
