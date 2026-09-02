// 用量统计 Host 半区:监听 llm/stream 累计 token 与估算费用,账本持久化在
// ~/.dsh/dsh-usage-stats/ledger.json,webServer 路由供浏览器半区读取。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  createLedger,
  dayKeyOf,
  recordCall,
  summarize,
  pruneLedger,
  ensureSessionsIndex,
  sessionTotals,
  FALLBACK_PRICING,
} from './ledger.mjs'
import { normalizeCustomPrices, matchPrice, nativeCostOfCall, toUsd, catalogOrFallback } from './pricing.mjs'
import { isRateStale, parseTencentRate, parseErApiRate, resolveRate, RATE_TTL_MS } from './rates.mjs'
import { buildDashboard, sessionsView } from './dashboard.mjs'
import { toCsv } from './csv.mjs'

const DATA_DIR = join(homedir(), '.dsh', 'dsh-usage-stats')
const DATA_FILE = join(DATA_DIR, 'ledger.json')
const RATES_FILE = join(DATA_DIR, 'rates.json')
const MODELS_DEV_URL = 'https://models.dev/api.json'
const TENCENT_RATE_URL = 'https://qt.gtimg.cn/q=whUSDCNY'
const ERAPI_RATE_URL = 'https://open.er-api.com/v6/latest/USD'
const PRICING_TTL_MS = 24 * 60 * 60 * 1000
const PRICING_TIMEOUT_MS = 30 * 1000
const RATE_TIMEOUT_MS = 5 * 1000
const PRICING_MAX_BYTES = 8 * 1024 * 1024
const LEDGER_KEEP_DAYS = 180
const RECENT_DAY_COUNT = 14
const MAX_SESSION_ROWS = 50
const BODY_MAX_BYTES = 64 * 1024
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8'
const EXPORT_KIND_DAYS = 'days'
const EXPORT_KIND_SESSIONS = 'sessions'
const EXPORT_KIND_JSON = 'json'

// models.dev 拉取失败时的兜底单价,USD / 百万 token。
const PRICING_SOURCE_LIVE = 'live'
const PRICING_SOURCE_FALLBACK = 'fallback'

// 设置命名空间:自定义单价表(配置属 settings 域,与账本文件分离)。
const SETTINGS_NAMESPACE = settingsNamespace('usage-stats')

// 自定义单价条目:model 支持精确与前缀匹配,currency 为 CNY/USD 原生币种。
const SETTINGS_SCHEMA = z.object({
  customPrices: z.array(z.object({
    model: z.string().description('模型 id,支持 provider/model 精确或模型名前缀'),
    input: z.number().description('输入单价 / 百万 token'),
    output: z.number().description('输出单价 / 百万 token'),
    cacheRead: z.number().description('缓存命中单价 / 百万 token'),
    currency: z.union([z.const('CNY'), z.const('USD')]).default('USD').description('单价原生币种'),
  })).default([]).description('自定义模型单价表,命中优先于目录价'),
})

// ---- HTTP 工具 ----
// 访问控制交给 DSH web 鉴权层(非本机 Host 的请求必须携带凭据);
// 本插件响应只含本地用量聚合,不做二次拦截。

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function fetchPricingCatalog() {
  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(PRICING_TIMEOUT_MS) })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const text = await response.text()
  if (text.length > PRICING_MAX_BYTES) throw new Error('价格目录超过上限')
  return flattenPricing(JSON.parse(text))
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export const inject = ['webServer']

export function apply(ctx) {
  let ledger = null
  let loadPromise = null
  let writeChain = Promise.resolve()
  let pricingTable = null
  let pricingSource = PRICING_SOURCE_FALLBACK
  let pricingPromise = null
  let customTable = []
  let rate = { rate: null, fetchedAt: 0, stale: true }
  let ratePromise = null

  customTable = readCustomSettings()
  // 启动预热:汇率缓存先落定再触发刷新,避免未读缓存即发起网络请求产生覆盖竞态
  loadRateCache().then(() => {
    ensureRate()
  })
  ensurePricing()

  function readCustomSettings() {
    try {
      const settings = ctx.get('settings')
      if (settings === undefined) return []
      const value = settings.get(SETTINGS_NAMESPACE)
      const normalized = SETTINGS_SCHEMA(value || {})
      return normalizeCustomPrices(normalized.customPrices)
    } catch (error) {
      console.error('usage-stats: 自定义单价配置无效,忽略', error)
      return []
    }
  }

  function ensureLedger() {
    if (ledger !== null) return Promise.resolve(ledger)
    if (!loadPromise) {
      loadPromise = readFile(DATA_FILE, 'utf8')
        .then((text) => {
          const parsed = JSON.parse(text)
          ledger = parsed && parsed.days && typeof parsed.days === 'object' ? parsed : createLedger()
          // v1 旧账本无顶层会话索引:视为空,增量写入,不回填
          ensureSessionsIndex(ledger)
          return ledger
        })
        .catch(() => {
          ledger = createLedger()
          return ledger
        })
    }
    return loadPromise
  }

  function persistLedger() {
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(DATA_FILE), { recursive: true })
      await writeFile(DATA_FILE, JSON.stringify(ledger, null, 2), 'utf8')
    })
    return writeChain
  }

  // 计价表懒加载:models.dev 24h 缓存,失败回落内置兜底表。
  function ensurePricing() {
    if (pricingTable !== null && pricingSource === PRICING_SOURCE_LIVE) return Promise.resolve(pricingTable)
    if (!pricingPromise) {
      pricingPromise = fetchPricingCatalog()
        .then((table) => {
          if (table.length > 0) {
            pricingTable = table
            pricingSource = PRICING_SOURCE_LIVE
            return table
          }
          throw new Error('价格目录为空')
        })
        .catch((error) => {
          console.error('usage-stats: models.dev 拉取失败,使用内置兜底价', error)
          pricingTable = FALLBACK_PRICING
          pricingSource = PRICING_SOURCE_FALLBACK
          return pricingTable
        })
    }
    return pricingPromise
  }

  // 汇率:腾讯财经 -> open.er-api -> 兜底;缓存落盘,重启沿用上次汇率。
  function loadRateCache() {
    return readFile(RATES_FILE, 'utf8')
      .then((text) => {
        const parsed = JSON.parse(text)
        if (parsed && Number.isFinite(parsed.rate) && parsed.rate > 0) rate = parsed
      })
      .catch(() => {
        // 无缓存或损坏:保持兜底口径,等待下次刷新
      })
  }

  function persistRate() {
    return mkdir(dirname(RATES_FILE), { recursive: true })
      .then(() => writeFile(RATES_FILE, JSON.stringify(rate), 'utf8'))
      .catch((error) => console.error('usage-stats: 汇率缓存写入失败', error))
  }

  async function fetchLiveRate() {
    try {
      const tencent = await fetch(TENCENT_RATE_URL, { signal: AbortSignal.timeout(RATE_TIMEOUT_MS) })
      const tencentRate = parseTencentRate(await tencent.text())
      if (tencentRate !== null) return { ok: true, rate: tencentRate }
    } catch {
      // 降级到 er-api
    }
    try {
      const erapi = await fetch(ERAPI_RATE_URL, { signal: AbortSignal.timeout(RATE_TIMEOUT_MS) })
      const erapiRate = parseErApiRate(await erapi.json())
      if (erapiRate !== null) return { ok: true, rate: erapiRate }
    } catch {
      // 全源失败
    }
    return { ok: false }
  }

  function ensureRate() {
    const now = Date.now()
    if (rate.rate !== null && !isRateStale(rate.fetchedAt, now)) return Promise.resolve(rate)
    if (!ratePromise) {
      ratePromise = fetchLiveRate()
        .then((outcome) => {
          rate = resolveRate(rate.rate !== null ? rate : null, outcome, Date.now())
          ratePromise = null
          return persistRate().then(() => rate)
        })
        .catch((error) => {
          console.error('usage-stats: 汇率刷新失败,沿用上次汇率', error)
          ratePromise = null
          return rate
        })
    }
    return ratePromise
  }

  function recordAsync(options, usage) {
    const call = {
      at: Date.now(),
      sessionId: options && options.sessionId ? options.sessionId : 'unknown',
      model: options && options.model ? options.model : 'unknown',
      provider: options && options.provider ? options.provider : '',
      inputTokens: usage && Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
      cacheReadTokens: usage && Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
      outputTokens: usage && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
    }
    return (async () => {
      try {
        await ensureLedger()
        // 计费前等待计价表就绪;启动窗口内未就绪时同步回落兜底价,不静默丢费用
        await ensurePricing()
        const matched = matchPrice(customTable, catalogOrFallback(pricingTable), call.provider, call.model)
        const native = nativeCostOfCall(call, matched ? matched.entry : null)
        let cost = null
        if (native !== null) {
          const currentRate = await ensureRate()
          cost = toUsd(native.amount, native.currency, currentRate.rate)
        }
        recordCall(ledger, call, cost)
        pruneLedger(ledger, dayKeyOf(Date.now()), LEDGER_KEEP_DAYS)
        await persistLedger()
      } catch (error) {
        console.error('usage-stats: 记录调用失败', error)
      }
    })()
  }

  ctx.on('llm/stream', (options, next) => {
    const upstream = next()
    let usage = null
    const pump = (async function* () {
      try {
        for await (const chunk of upstream) {
          if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage
          yield chunk
        }
      } finally {
        recordAsync(options, usage)
      }
    })()
    return pump
  })

  async function sessionTitle(sessionId) {
    try {
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined) return null
      const snapshot = await sessionQuery.readTitle(sessionId)
      return snapshot && typeof snapshot.title === 'string' && snapshot.title.length > 0 ? snapshot.title : null
    } catch {
      return null
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-stats/summary',
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const current = await ensureLedger()
            const todayKey = dayKeyOf(Date.now())
            const summary = summarize(current, todayKey, RECENT_DAY_COUNT)
            summary.recentDays = summary.recentDays.map((day) => ({
              date: day.date,
              calls: day.calls,
              inputTokens: day.inputTokens,
              cacheReadTokens: day.cacheReadTokens,
              outputTokens: day.outputTokens,
              cost: day.cost,
            }))
            const rows = summary.todaySessions.slice(0, MAX_SESSION_ROWS)
            summary.todaySessions = await Promise.all(
              rows.map(async (row) => ({ ...row, title: await sessionTitle(row.sessionId) })),
            )
            const currentRate = await ensureRate()
            sendJson(res, 200, { summary, pricingSource, todayKey, rate: currentRate })
          } catch (error) {
            sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-stats summary route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-stats/session',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = JSON.parse(await readBody(req))
            const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
            const current = await ensureLedger()
            // v2:读顶层会话索引,会话累计跨日合并
            const session = sessionTotals(current, sessionId)
            sendJson(res, 200, {
              calls: session ? session.calls : 0,
              inputTokens: session ? session.inputTokens : 0,
              cacheReadTokens: session ? session.cacheReadTokens : 0,
              outputTokens: session ? session.outputTokens : 0,
              cost: session ? session.cost : 0,
            })
          } catch (error) {
            sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-stats session route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-stats/reset',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            // 清零语义:days 与顶层会话索引一起清空,不可恢复;汇率缓存与导出不受影响
            ledger = createLedger()
            await persistLedger()
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-stats reset route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-stats/dashboard',
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const current = await ensureLedger()
            const todayKey = dayKeyOf(Date.now())
            const currentRate = await ensureRate()
            const dash = buildDashboard(current, todayKey, currentRate)
            // 标题动态读取不入账本,缺失由前端以 ID 前缀兜底
            const rows = dash.sessions.slice(0, MAX_SESSION_ROWS)
            dash.sessions = await Promise.all(
              rows.map(async (row) => ({ ...row, title: await sessionTitle(row.sessionId) })),
            )
            sendJson(res, 200, {
              dashboard: dash,
              pricingSource,
              customTiers: customTable.length > 0 ? customTable.map((entry) => entry.keys[0]) : [],
              totalSessions: sessionsView(current, 0).length,
            })
          } catch (error) {
            sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-stats dashboard route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-stats/export',
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const url = new URL(req.url, 'http://localhost')
            const kind = url.searchParams.get('kind') || EXPORT_KIND_DAYS
            const current = await ensureLedger()
            if (kind === EXPORT_KIND_JSON) {
              sendJson(res, 200, current)
              return
            }
            const todayKey = dayKeyOf(Date.now())
            let rows
            let filename
            if (kind === EXPORT_KIND_SESSIONS) {
              filename = 'usage-stats-sessions.csv'
              rows = [['sessionId', 'title', 'firstAt', 'lastAt', 'calls', 'inputTokens', 'cacheReadTokens', 'outputTokens', 'costUsd']]
              for (const row of sessionsView(current, 0)) {
                rows.push([
                  row.sessionId,
                  await sessionTitle(row.sessionId),
                  new Date(row.firstAt).toISOString(),
                  new Date(row.lastAt).toISOString(),
                  row.calls,
                  row.inputTokens,
                  row.cacheReadTokens,
                  row.outputTokens,
                  row.cost,
                ])
              }
            } else {
              filename = 'usage-stats-days.csv'
              rows = [['date', 'calls', 'inputTokens', 'cacheReadTokens', 'outputTokens', 'costUsd']]
              for (const key of Object.keys(current.days).sort()) {
                const day = current.days[key]
                rows.push([key, day.calls, day.inputTokens, day.cacheReadTokens, day.outputTokens, day.cost])
              }
            }
            res.writeHead(200, {
              'content-type': CSV_CONTENT_TYPE,
              'content-disposition': 'attachment; filename="' + filename + '"',
            })
            res.end(toCsv(rows))
          } catch (error) {
            sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-stats export route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-stats/prices',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, { customPrices: customTable })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = JSON.parse(await readBody(req))
            const normalized = normalizeCustomPrices(body && body.customPrices)
            customTable = normalized
            const settings = ctx.get('settings')
            if (settings !== undefined) {
              // 回写原始条目,保留字段语义;归一化表仅用于运行时匹配
              await settings.update(SETTINGS_NAMESPACE, { customPrices: body && Array.isArray(body.customPrices) ? body.customPrices : [] })
            }
            sendJson(res, 200, { ok: true, customPrices: customTable })
          } catch (error) {
            sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-stats prices route',
  )
}
