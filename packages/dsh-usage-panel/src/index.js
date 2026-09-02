// 用量面板 Host 半区:多平台余额查询 + 定期轮询 + 历史快照落盘。webServer 路由供浏览器半区调用,
// fetch 直连平台 API,配置持久化在 ~/.dsh/dsh-usage-panel/accounts.json,快照在 history.json。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  parseDeepSeek,
  parseOpenRouter,
  parseKimi,
  parseZhipu,
  parseMiniMax,
  parseNewApi,
  extractCustom,
} from './parsers.mjs'
import { readingToSnapshots, appendPoint, buildMonthSequence, newSequenceStore } from './history.mjs'
import { createHistoryStore } from './historyStore.mjs'
import { DEFAULT_POLL_INTERVAL_SEC, resolvePollIntervalSec, createBackoff, longWindowDivisor, shouldQueryThisRound, isShortWindowTier } from './poller.mjs'

const FETCH_TIMEOUT_MS = 20 * 1000
const BODY_MAX_BYTES = 256 * 1024
const MAX_ACCOUNTS = 20
const DATA_DIR = join(homedir(), '.dsh', 'dsh-usage-panel')
const DATA_FILE = join(DATA_DIR, 'accounts.json')
const HISTORY_FILE = join(DATA_DIR, 'history.json')
const TICK_SEC = 30
const SHORT_SUFFIX = '5h'

const NAMESPACE = settingsNamespace('usage-panel')

const SETTINGS_SCHEMA = z.object({
  pollIntervalSec: z.number().default(DEFAULT_POLL_INTERVAL_SEC).description('定期查询间隔秒数,仅正数有效'),
})

const TYPE_DEEPSEEK = 'deepseek'
const TYPE_OPENROUTER = 'openrouter'
const TYPE_KIMI = 'kimi'
const TYPE_ZHIPU = 'zhipu'
const TYPE_MINIMAX = 'minimax'
const TYPE_NEWAPI = 'newapi'
const TYPE_CUSTOM = 'custom'

const ACCOUNT_TYPES = [TYPE_DEEPSEEK, TYPE_OPENROUTER, TYPE_KIMI, TYPE_ZHIPU, TYPE_MINIMAX, TYPE_NEWAPI, TYPE_CUSTOM]
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

// 各预设平台的默认基址与余额接口路径。
const TYPE_META = {
  [TYPE_DEEPSEEK]: { defaultBase: 'https://api.deepseek.com', path: '/user/balance', rawAuth: false },
  [TYPE_OPENROUTER]: { defaultBase: 'https://openrouter.ai', path: '/api/v1/credits', rawAuth: false },
  [TYPE_KIMI]: { defaultBase: 'https://api.kimi.com/coding', path: '/v1/usages', rawAuth: false, userAgent: 'KimiCLI/1.5' },
  [TYPE_ZHIPU]: { defaultBase: 'https://open.bigmodel.cn', path: '/api/monitor/usage/quota/limit', rawAuth: true },
  [TYPE_MINIMAX]: { defaultBase: 'https://api.minimaxi.com', path: '/v1/api/openplatform/coding_plan/remains', rawAuth: false },
  [TYPE_NEWAPI]: { defaultBase: '', path: '/api/usage/token', rawAuth: false },
  [TYPE_CUSTOM]: { defaultBase: '', path: '', rawAuth: false },
}

const PARSERS = {
  [TYPE_DEEPSEEK]: parseDeepSeek,
  [TYPE_OPENROUTER]: parseOpenRouter,
  [TYPE_KIMI]: parseKimi,
  [TYPE_ZHIPU]: parseZhipu,
  [TYPE_MINIMAX]: parseMiniMax,
  [TYPE_NEWAPI]: parseNewApi,
  [TYPE_CUSTOM]: extractCustom,
}

// ---- HTTP 工具 ----
// 访问控制交给 DSH web 鉴权层(非本机 Host 的请求必须携带凭据);
// 本插件响应不含明文 Key,读数不含敏感凭据,不做二次拦截。

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

// ---- 平台请求 ----

function isUsableUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/.test(value)
}

function stripUnsafeHeaderChars(value) {
  return String(value).replace(/[\r\n]+/g, ' ')
}

function buildRequest(account) {
  const meta = TYPE_META[account.type]
  if (account.type === TYPE_CUSTOM) {
    const custom = account.custom || {}
    if (!isUsableUrl(custom.url)) throw new Error('自定义端点 URL 无效(需 http/https 且无空白)')
    const method = HTTP_METHODS.indexOf(String(custom.method || 'GET').toUpperCase()) >= 0
      ? String(custom.method).toUpperCase()
      : 'GET'
    const headers = {}
    const rawHeaders = custom.headers && typeof custom.headers === 'object' ? custom.headers : {}
    for (const name of Object.keys(rawHeaders)) {
      if (typeof rawHeaders[name] !== 'string') continue
      headers[stripUnsafeHeaderChars(name)] = stripUnsafeHeaderChars(rawHeaders[name])
    }
    return {
      url: custom.url,
      method,
      headers,
      body: method !== 'GET' && method !== 'HEAD' && typeof custom.body === 'string' && custom.body.length > 0 ? custom.body : undefined,
    }
  }
  const base = (account.baseUrl || '').trim() || meta.defaultBase
  if (base.length === 0) throw new Error('该平台需要填写 API 基础地址')
  if (!isUsableUrl(base)) throw new Error('API 基础地址无效')
  const key = (account.apiKey || '').trim()
  if (key.length === 0) throw new Error('未配置 API Key')
  const headers = { Authorization: (meta.rawAuth ? '' : 'Bearer ') + key, Accept: 'application/json' }
  if (meta.userAgent) headers['User-Agent'] = meta.userAgent
  return { url: base.replace(/\/+$/, '') + meta.path, method: 'GET', headers, body: undefined }
}

async function performRequest(request) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 200) : ''))
  }
  return text
}

// ---- 配置存取 ----

function defaultConfig() {
  return { version: 1, accounts: [] }
}

function requireOk(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizeAccounts(input) {
  requireOk(Array.isArray(input), 'accounts 必须是数组')
  requireOk(input.length <= MAX_ACCOUNTS, '账号数量超过上限 ' + MAX_ACCOUNTS)
  return input.map((raw, index) => {
    requireOk(raw !== null && typeof raw === 'object', '第 ' + (index + 1) + ' 个账号格式非法')
    const type = String(raw.type || '')
    requireOk(ACCOUNT_TYPES.indexOf(type) >= 0, '未知平台类型: ' + type)
    const customSource = raw.custom && typeof raw.custom === 'object' ? raw.custom : {}
    const headers = {}
    if (customSource.headers && typeof customSource.headers === 'object') {
      for (const name of Object.keys(customSource.headers)) {
        if (typeof customSource.headers[name] === 'string') headers[name] = customSource.headers[name]
      }
    }
    const lastSource = raw.last && typeof raw.last === 'object' ? raw.last : null
    return {
      id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : 'acct-' + String(index),
      name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : type,
      type,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
      custom: {
        url: typeof customSource.url === 'string' ? customSource.url.trim() : '',
        method: typeof customSource.method === 'string' ? customSource.method.toUpperCase() : 'GET',
        headers,
        body: typeof customSource.body === 'string' ? customSource.body : '',
        extract: customSource.extract && typeof customSource.extract === 'object' ? customSource.extract : {},
      },
      last: lastSource && typeof lastSource.ok === 'boolean'
        ? {
            ok: lastSource.ok,
            reading: lastSource.reading || null,
            error: typeof lastSource.error === 'string' ? lastSource.error : null,
            queriedAt: Number.isFinite(Number(lastSource.queriedAt)) ? Number(lastSource.queriedAt) : null,
          }
        : null,
    }
  })
}

// 响应剥离明文 Key:客户端只需知道是否已配置,Key 永不出主机。
function redactAccount(account) {
  return { ...account, apiKey: '', hasKey: account.apiKey.length > 0 }
}

async function queryAccount(config, account) {
  const queriedAt = Date.now()
  let last
  try {
    const text = await performRequest(buildRequest(account))
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('响应不是合法 JSON')
    }
    const topError = body && body.error
    if (topError && typeof topError.message === 'string') throw new Error(topError.message)
    const reading = PARSERS[account.type](body)
    last = { ok: true, reading, error: null, queriedAt }
  } catch (error) {
    last = { ok: false, reading: null, error: error && error.message ? error.message : String(error), queriedAt }
  }
  account.last = last
  return { ok: last.ok, account }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export const inject = ['webServer', 'timer']

export function apply(ctx) {
  let config = null
  let loadPromise = null
  let writeChain = Promise.resolve()
  let historyStore = createHistoryStore({ file: HISTORY_FILE })
  let history = newSequenceStore()
  // 账号级轮询状态:分频轮次计数(退避期间不递增)与失败退避状态机
  const pollState = new Map()

  function readPollIntervalSec() {
    const settings = ctx.get('settings')
    const value = settings ? settings.get(NAMESPACE) : undefined
    return resolvePollIntervalSec(value ? value.pollIntervalSec : undefined)
  }

  function ensureHistory() {
    return historyStore.ensure().then((sequences) => {
      history = sequences
      return history
    })
  }

  function persistHistory() {
    return historyStore.persist()
  }

  // 查询成功后落快照:按读数取样追加各序列,并重建当月月窗口序列。
  function recordSnapshots(account, reading, queriedAt) {
    const snaps = readingToSnapshots(reading)
    for (const snap of snaps) {
      appendPoint(history, account.id + ':' + snap.suffix, queriedAt, snap.value, queriedAt)
    }
    buildMonthSequence(history, account.id, queriedAt)
    return persistHistory()
  }

  function pollEntry(accountId, intervalSec) {
    const existing = pollState.get(accountId)
    if (existing && existing.baseSec === intervalSec) return existing
    // 查询周期变更:重建退避使基期始终跟随当前间隔,保留分频轮次
    const state = {
      baseSec: intervalSec,
      round: existing ? existing.round : 0,
      backoff: createBackoff({ baseSec: intervalSec }),
    }
    pollState.set(accountId, state)
    return state
  }

  function hasShortWindow(account) {
    return isShortWindowTier(
      account.last,
      account.last !== null && account.last.reading !== null &&
        readingToSnapshots(account.last.reading).some((snap) => snap.suffix === SHORT_SUFFIX),
    )
  }

  function runQuery(account) {
    const queriedAt = Date.now()
    return queryAccount(config, account).then((result) => {
      const state = pollEntry(account.id, readPollIntervalSec())
      if (result.ok) {
        state.backoff.onSuccess()
        return recordSnapshots(account, account.last.reading, queriedAt).then(() => result)
      }
      state.backoff.onFailure(Math.floor(queriedAt / 1000))
      return result
    })
  }

  function ensureConfig() {
    if (config !== null) return Promise.resolve(config)
    if (!loadPromise) {
      loadPromise = readFile(DATA_FILE, 'utf8')
        .then((text) => {
          const parsed = JSON.parse(text)
          config = parsed && Array.isArray(parsed.accounts) ? parsed : defaultConfig()
          return config
        })
        .catch(() => {
          config = defaultConfig()
          return config
        })
    }
    return loadPromise
  }

  function persistConfig() {
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(DATA_FILE), { recursive: true })
      await writeFile(DATA_FILE, JSON.stringify(config, null, 2), 'utf8')
    })
    return writeChain
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-panel/accounts',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const current = await ensureConfig()
              sendJson(res, 200, { accounts: current.accounts.map(redactAccount) })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = JSON.parse(await readBody(req))
            await ensureConfig()
            const previous = Array.isArray(config.accounts) ? config.accounts : []
            const saved = normalizeAccounts(body && body.accounts).map((account) => {
              // 客户端拿不到旧 Key,空 Key 视为「保持不变」
              if (account.apiKey.length > 0) return account
              const old = previous.find((item) => item.id === account.id)
              return old ? { ...account, apiKey: old.apiKey } : account
            })
            config = { version: 1, accounts: saved }
            // 已删除账号的轮询状态同步清理,不留悬挂退避
            for (const id of [...pollState.keys()]) {
              if (!saved.some((account) => account.id === id)) pollState.delete(id)
            }
            await persistConfig()
            sendJson(res, 200, { ok: true, accounts: saved.map(redactAccount) })
          } catch (error) {
            sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-panel accounts route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-panel/query',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = JSON.parse(await readBody(req))
            const id = body && typeof body.id === 'string' ? body.id : ''
            const auto = body && body.auto === true
            const current = await ensureConfig()
            const account = current.accounts.find((item) => item.id === id)
            requireOk(account !== undefined, '账号不存在: ' + id)
            const intervalSec = readPollIntervalSec()
            const state = pollEntry(id, intervalSec)
            // 面板打开触发的自动查询受退避约束,避免绕过退避轰炸上游;手动刷新不受限
            if (auto && state.backoff.isBlocked(Math.floor(Date.now() / 1000))) {
              sendJson(res, 200, { ok: false, skipped: true, account: redactAccount(account) })
              return
            }
            await ensureHistory()
            const result = await runQuery(account)
            await persistConfig()
            sendJson(res, 200, { ok: result.ok, account: redactAccount(result.account) })
          } catch (error) {
            sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-panel query route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-panel/history',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          await ensureHistory()
          sendJson(res, 200, { sequences: history })
        },
      }),
    'usage-panel history route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/usage-panel/settings',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, { pollIntervalSec: readPollIntervalSec() })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = JSON.parse(await readBody(req))
            const intervalSec = resolvePollIntervalSec(body ? body.pollIntervalSec : undefined)
            const settings = ctx.get('settings')
            requireOk(settings !== undefined, 'settings 服务不可用')
            await settings.update(NAMESPACE, { pollIntervalSec: intervalSec })
            sendJson(res, 200, { ok: true, pollIntervalSec: readPollIntervalSec() })
          } catch (error) {
            sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          }
        },
      }),
    'usage-panel settings route',
  )

  // 定期轮询:固定短 tick,串行查询到期账号;退避期间跳过且不消耗分频轮次。
  let pollRunning = false
  ctx.interval(() => {
    if (pollRunning) return
    const current = config
    if (!current) return
    const intervalSec = readPollIntervalSec()
    const nowSec = Math.floor(Date.now() / 1000)
    const divisor = longWindowDivisor(intervalSec)
    const due = current.accounts.filter((account) => {
      const state = pollEntry(account.id, intervalSec)
      if (state.backoff.isBlocked(nowSec)) return false
      return shouldQueryThisRound({ round: state.round + 1, hasShortWindow: hasShortWindow(account), divisor })
    })
    if (due.length === 0) return
    pollRunning = true
    ensureHistory()
      .then(async () => {
        for (const account of due) {
          pollEntry(account.id, intervalSec).round += 1
          // 单账号失败不中止本轮其余账号(broken 等持久态下尤为关键)
          await runQuery(account).catch(() => {})
        }
        await persistConfig()
      })
      .catch(() => {})
      .then(() => {
        pollRunning = false
      })
  }, TICK_SEC * 1000)

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA)
  })
}
