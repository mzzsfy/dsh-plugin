import { setupCommonTools, createChangeNotifier } from '@mzzsfy/dsh-common-tools/host'
// 用量面板 Host 半区:多平台余额查询 + 定期轮询 + 历史快照落盘。webServer 路由供浏览器半区调用,
// fetch 直连平台 API,配置持久化在 ~/.dsh/dsh-usage-panel/accounts.json,快照在 history.json。

import { mkdir, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { withRouteGate } from './route-gate.mjs'
import { createHistoryStore } from './historyStore.mjs'
import { createAtomicWriter } from './atomicFile.mjs'
import { createBackoff, lastQuerySecOf, isDue, runLimited, POLL_INTERVAL_SEC } from './poller.mjs'
import {
  DEFAULT_QUOTA_THRESHOLD_PCT,
  WEBHOOK_TIMEOUT_MS,
  buildNotifyEvent,
  buildWebhookPayload,
  createProjection,
  createNotifyState,
  evaluateAccount,
  mergeAccountOverride,
  normalizeAccountNotify,
  normalizeImTargets,
  normalizeNotifyState,
  publicNotify,
  resolvedNotifySettings,
  sendWebhook,
  validateNotifyPatch,
  isValidImBotId,
} from './notify.mjs'

const FETCH_TIMEOUT_MS = 20 * 1000
const BODY_MAX_BYTES = 256 * 1024
const MAX_ACCOUNTS = 20
// 单轮轮询的受限并发:串行执行时单账号 20s 超时即可拖满整轮(pollInFlight 互斥
// 使后续 tick 全部跳过,轮询事实停摆),并发上限同时压住上游瞬时压力
const POLL_CONCURRENCY = 4
// 数据目录支持 env 注入(测试隔离);缺省从宿主 home 派生(DSH_HOME 即 .dsh 根,rs-workflow 同构)
const DATA_DIR = process.env.DSH_USAGE_PANEL_DATA_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-usage-panel')
const DATA_FILE = join(DATA_DIR, 'accounts.json')
const HISTORY_FILE = join(DATA_DIR, 'history.json')
const BAK_SUFFIX = '.bak'
const ACCOUNTS_BROKEN_MESSAGE = '账号配置文件已损坏已备份,已暂停写入以防数据丢失'
const DISPOSED_MESSAGE = '插件实例已卸载,已停止写入'
const TICK_SEC = 30

const NAMESPACE = 'usage-panel'

const SETTINGS_SCHEMA = z.object({
  notify: z.object({
    enabled: z.boolean().default(false).description('通知总开关,默认关闭'),
    quotaThresholdPct: z.number().default(DEFAULT_QUOTA_THRESHOLD_PCT).description('用量窗口阈值百分比'),
    balanceThreshold: z.union([z.number(), z.const(null)]).default(null).description('余额阈值,null 为不启用'),
    resetNotice: z.boolean().default(true).description('额度窗口重置时通知上一窗口峰值'),
    toast: z.boolean().default(true).description('浏览器页内 toast 通道'),
    webhookUrl: z.string().role('secret').default('').description('webhook 目标 URL(Slack-compatible {text}),留空禁用'),
    imTargets: z.array(z.object({ botId: z.string().default(''), targetId: z.string().default('') })).default([]).description('dsh-im 投递目标列表'),
  }).default({}),
})

// 0.1.7 宿主以静态 Config 导出生成设置节表单(maintain 同构);legacy 宿主经
// settings.register 注册命名空间。根级 volatile 包装:整节 live 表单,节写经
// loader 原地热更;旧宿主 schemastery 无 volatile 方法,特性检测原样返回
export const Config = volatileWrap(SETTINGS_SCHEMA)

function volatileWrap(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

// volatile ref 动态解包(get 协议):0.1.7 下 apply 入参 config 为整节单 ref;
// legacy 宿主 config 为普通对象原样透传
function unwrapVolatile(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

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
}

// 解析分发:custom 需要账号级 extract 规则,单参表无法表达,特化传参
function parseReading(account, body) {
  return account.type === TYPE_CUSTOM
    ? extractCustom(body, account.custom && account.custom.extract)
    : PARSERS[account.type](body)
}

// ---- HTTP 工具 ----
// 访问控制交给 DSH web 鉴权层(非本机 Host 的请求必须携带凭据);
// 读路由响应不含明文 Key,读数不含敏感凭据;写路由统一经 guardedRoute
// (同源 + JSON 守卫),阻断跨站简单请求 drive-by 改写账号/配置或借测试通道外发(turn-notify 同构)。

// 读体:超限立即以 413 结束等待但不 destroy 连接——先回的响应必须能送到客户端,
// 连接破坏后 413 会变成 ECONNRESET;请求流继续被消费(丢弃),不会阻塞客户端写。
// aborted/close 早于 end 时按中断拒绝,防半截请求留下悬挂 promise。
const BODY_OVER_LIMIT_STATUS = 413
const BODY_ABORTED_STATUS = 400
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    let overLimit = false
    const chunks = []
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      if (overLimit) return
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        overLimit = true
        chunks.length = 0
        settle(reject, Object.assign(new Error('请求体超过上限'), { status: BODY_OVER_LIMIT_STATUS }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => settle(reject, error))
    req.on('aborted', () => settle(reject, Object.assign(new Error('请求已中断'), { status: BODY_ABORTED_STATUS })))
    req.on('close', () => settle(reject, Object.assign(new Error('请求已中断'), { status: BODY_ABORTED_STATUS })))
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// JSON 体统一入口:解析失败回固定中文,不把 JSON.parse 的英文原文与片段回给面板
async function readJsonBody(req) {
  const text = await readBody(req)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体必须是合法 JSON')
  }
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒;无 Origin 的非浏览器客户端放行。
// 守卫实现统一由共享 route-gate 提供(大小写不敏感同源 + 媒体类型精确比较),本文件不再自带副本。
// 路由样板:双方法变体放行 GET(读无 CSRF 面),其余 405;POST-only 变体供无读面的
// 写路由(测试通道/查询)使用——GET 放行会让跨站 <img src> 无守卫驱动外发;
// 跨源与 JSON content-type 由注册处的 withRouteGate 统一下沉,业务异常归一,
// handler 只留业务体。全部路由统一经此,防逐路由遗漏。
const guardedRoute = (handler) => async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    await handler(req, res)
  } catch (error) {
    // 读体超限等带 status 的错误按原状态码回,其余业务异常 400
    sendJson(res, error && Number.isInteger(error.status) ? error.status : 400, { error: error && error.message ? error.message : String(error) })
  }
}
guardedRoute.post = (handler) => async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  return guardedRoute(handler)(req, res)
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

async function performRequest(request, lifecycleSignal) {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = lifecycleSignal === undefined ? timeoutSignal : AbortSignal.any([lifecycleSignal, timeoutSignal])
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
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

// 端点 URL 只接受可解析的 http(s) 绝对地址:非法串既无法按分量脱敏,也不能当请求目标。
// 错误信息不回显原值(原值可能含凭据)
function parseEndpointUrl(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(label + ' 不是合法的 URL,请填写完整的 http(s) 地址')
  }
  requireOk(parsed.protocol === 'http:' || parsed.protocol === 'https:', label + ' 须为 http(s) 地址')
  return parsed
}

function normalizeAccounts(input) {
  requireOk(Array.isArray(input), 'accounts 必须是数组')
  requireOk(input.length <= MAX_ACCOUNTS, '账号数量超过上限 ' + MAX_ACCOUNTS)
  return input.map((raw, index) => {
    requireOk(raw !== null && typeof raw === 'object', '第 ' + (index + 1) + ' 个账号格式非法')
    const type = String(raw.type || '')
    requireOk(ACCOUNT_TYPES.indexOf(type) >= 0, '未知平台类型: ' + type)
    const customSource = raw.custom && typeof raw.custom === 'object' ? raw.custom : {}
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
    const customUrl = typeof customSource.url === 'string' ? customSource.url.trim() : ''
    if (baseUrl.length > 0) parseEndpointUrl(baseUrl, '第 ' + (index + 1) + ' 个账号的 baseUrl')
    if (customUrl.length > 0) parseEndpointUrl(customUrl, '第 ' + (index + 1) + ' 个账号的 custom.url')
    const headers = {}
    if (customSource.headers && typeof customSource.headers === 'object') {
      for (const name of Object.keys(customSource.headers)) {
        if (typeof customSource.headers[name] === 'string') headers[name] = customSource.headers[name]
      }
    }
    const lastSource = raw.last && typeof raw.last === 'object' ? raw.last : null
    const last = lastSource && typeof lastSource.ok === 'boolean'
      ? {
          ok: lastSource.ok,
          // 无 kind 判别字段的旧形态读数(v1 custom)单点清洗为 null,渲染回落空态,首轮刷新自然归一
          reading: lastSource.reading !== null && lastSource.reading !== undefined && typeof lastSource.reading === 'object' &&
            (lastSource.reading.kind === 'quota' || lastSource.reading.kind === 'balance')
            ? lastSource.reading
            : null,
          error: typeof lastSource.error === 'string' ? lastSource.error : null,
          queriedAt: typeof lastSource.queriedAt === 'number' && Number.isFinite(lastSource.queriedAt) ? lastSource.queriedAt : null,
        }
      : null
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : 'acct-' + String(index)
    // 序列键以「id:后缀」拼接,id 含冒号会破坏键解析与孤儿清理的账号段切分
    requireOk(id.indexOf(':') < 0, '账号 id 不得包含冒号: ' + id)
    return {
      id,
      name: typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : type,
      type,
      baseUrl,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
      custom: {
        url: customUrl,
        method: typeof customSource.method === 'string' ? customSource.method.toUpperCase() : 'GET',
        headers,
        body: typeof customSource.body === 'string' ? customSource.body : '',
        extract: customSource.extract && typeof customSource.extract === 'object' ? customSource.extract : {},
      },
      last,
      notify: normalizeAccountNotify(raw.notify),
      notifyState: normalizeNotifyState(raw.notifyState),
    }
  })
}

// 响应剥离明文凭据:apiKey 用 hasKey 表达;自定义头/体按字段名脱敏,
// 客户端回存时把占位替换回旧值,因此占位必须稳定且不可能与真实值撞车。
// 自定义端点 URL 的敏感查询参数/用户信息与上游错误体同样可能携带凭据,
// 响应侧一并脱敏(错误体按账号 Key 与常见 token 形态兜底)。
const REDACTED = '[已隐藏]'
const SECRET_FIELD = /(api[-_]?key|token|secret|password|authorization|cookie)/i

// URL 脱敏:敏感查询参数与用户信息(userinfo)统一隐藏。userinfo 非空即视为
// 凭据——常见形态 `https://token:@host` 的 token 在用户名位,密码位为空,
// 只判断 password 会把它明文回显;两段各自按非空判定,回存时对称还原。
function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  try {
    const parsed = new URL(value)
    let changed = false
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_FIELD.test(name) && parsed.searchParams.get(name) !== REDACTED) {
        parsed.searchParams.set(name, REDACTED)
        changed = true
      }
    }
    if (parsed.username.length > 0 && decodeUrlPart(parsed.username) !== REDACTED) {
      parsed.username = REDACTED
      changed = true
    }
    if (parsed.password.length > 0 && decodeUrlPart(parsed.password) !== REDACTED) {
      parsed.password = REDACTED
      changed = true
    }
    return changed ? parsed.toString() : value
  } catch {
    // 非法 URL 不能按分量脱敏,也可能整串就是凭据:整体置占位,绝不原样回显。
    // 保存侧由 parseEndpointUrl 拒绝回存,占位不会落盘
    return REDACTED
  }
}

// URL 中非空 userinfo 的明文形态(含百分号编码形态),供错误文本脱敏。
// 非法 URL 用字面形态兜底:上游把原始地址写进错误体时同样要遮住这段凭据
function urlUserInfoSecrets(value) {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = new URL(value)
    const secrets = []
    for (const part of [parsed.username, parsed.password]) {
      if (part.length === 0) continue
      secrets.push(part)
      const decoded = decodeUrlPart(part)
      if (decoded !== part) secrets.push(decoded)
    }
    return secrets
  } catch {
    const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#\s@]+)@/.exec(value)
    if (match === null) return []
    const secrets = [match[1]]
    for (const part of match[1].split(':')) {
      if (part.length === 0) continue
      secrets.push(part)
      const decoded = decodeUrlPart(part)
      if (decoded !== part) secrets.push(decoded)
    }
    return secrets
  }
}

function redactTextSecrets(value, extraSecrets = []) {
  if (typeof value !== 'string' || value.length === 0) return value
  let text = value
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join(REDACTED)
  }
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, '$1' + REDACTED)
  text = text.replace(/\bsk-[A-Za-z0-9._-]{4,}\b/g, REDACTED)
  // 上游错误体常把请求 URL 原样带回,查询参数里的 token 同样不能进响应
  text = text.replace(/([?&](?:api[-_]?key|token|secret|password|authorization|cookie)=)[^&\s"'`]+/gi, '$1' + REDACTED)
  return text
}

// 自定义请求体整体视为凭据面:字段名不可信(access_key/auth/pin 等命名各异,
// 白名单拦不住),字符串值一律遮住;数值/布尔等结构保留,回存按位置对称还原
function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === 'string' && item.length > 0 ? REDACTED : redactJson(item),
  ]))
}

function redactBody(body) {
  if (typeof body !== 'string' || body.length === 0) return body
  try {
    const parsed = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') return JSON.stringify(redactJson(parsed), null, 2)
  } catch {
    // 非 JSON 体无法判定字段,整体隐藏
  }
  return REDACTED
}

// 自定义头/体整块属凭据面:上游错误体常把请求原样带回,其值同样要进脱敏集合。
// 头值逐个收集;体按 JSON 递归收集字符串值,非 JSON 体整体视为一个凭据串
function collectStringValues(value, out) {
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out)
    return
  }
  if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStringValues(item, out)
}

function customCredentialSecrets(custom) {
  const secrets = []
  for (const value of Object.values(custom.headers || {})) {
    if (typeof value === 'string' && value.length > 0) secrets.push(value)
  }
  if (typeof custom.body !== 'string' || custom.body.length === 0) return secrets
  try {
    collectStringValues(JSON.parse(custom.body), secrets)
  } catch {
    secrets.push(custom.body)
  }
  return secrets
}

function redactAccount(account) {
  const custom = account.custom || {}
  const userInfo = [...urlUserInfoSecrets(account.baseUrl), ...urlUserInfoSecrets(custom.url)]
  const last = account.last && typeof account.last === 'object'
    ? { ...account.last, error: redactTextSecrets(account.last.error, [account.apiKey, ...userInfo, ...customCredentialSecrets(custom)]) }
    : account.last
  return {
    ...account,
    apiKey: '',
    hasKey: account.apiKey.length > 0,
    baseUrl: redactUrl(account.baseUrl),
    last,
    custom: {
      ...custom,
      url: redactUrl(custom.url),
      headers: Object.fromEntries(Object.entries(custom.headers || {}).map(([name, value]) => [name, value === '' ? '' : REDACTED])),
      body: redactBody(custom.body),
    },
  }
}

function restoreJson(submitted, existing) {
  if (Array.isArray(submitted)) {
    const old = Array.isArray(existing) ? existing : []
    return submitted.map((item, index) => restoreJson(item, old[index]))
  }
  if (submitted === null || typeof submitted !== 'object') {
    return submitted === REDACTED && typeof existing === 'string' ? existing : submitted
  }
  const old = existing !== null && typeof existing === 'object' ? existing : {}
  return Object.fromEntries(Object.entries(submitted).map(([key, value]) => [key, restoreJson(value, old[key])]))
}

function restoreHeaders(submitted, existing) {
  const old = existing || {}
  return Object.fromEntries(Object.entries(submitted || {}).map(([name, value]) => [
    name,
    value === REDACTED && typeof old[name] === 'string' ? old[name] : value,
  ]))
}

function restoreBody(submitted, existing) {
  if (submitted === REDACTED) return typeof existing === 'string' ? existing : submitted
  if (typeof submitted !== 'string' || typeof existing !== 'string') return submitted
  try {
    return JSON.stringify(restoreJson(JSON.parse(submitted), JSON.parse(existing)), null, 2)
  } catch {
    return submitted
  }
}

// URL.password getter 返回百分号编码值,比较占位前先解码
function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// 端点 URL 的脱敏占位按参数名/用户信息位还原旧值;无法还原的占位由 assertRestoredUrl 拒绝落盘
function restoreUrl(submitted, existing) {
  if (typeof submitted !== 'string' || typeof existing !== 'string') return submitted
  try {
    const next = new URL(submitted)
    const old = new URL(existing)
    let changed = false
    for (const name of [...next.searchParams.keys()]) {
      if (next.searchParams.get(name) !== REDACTED || !SECRET_FIELD.test(name)) continue
      const oldValue = old.searchParams.get(name)
      if (oldValue === null) continue
      next.searchParams.set(name, oldValue)
      changed = true
    }
    if (decodeUrlPart(next["username"]) === REDACTED) {
      next["username"] = decodeUrlPart(old["username"])
      changed = true
    }
    if (decodeUrlPart(next["password"]) === REDACTED) {
      next["password"] = decodeUrlPart(old["password"])
      changed = true
    }
    return changed ? next.toString() : submitted
  } catch {
    return submitted
  }
}

function assertRestoredUrl(url) {
  if (typeof url !== 'string') return
  let decoded = url
  try {
    decoded = decodeURIComponent(url)
  } catch {
    decoded = url
  }
  if (decoded.includes(REDACTED)) {
    throw new Error('自定义端点 URL 的隐藏参数无法还原,请重新填写该地址')
  }
}

// 占位符按「字段路径」还原:改键名、重排数组、把 JSON 改坏都配不上旧值,
// 残留占位符绝不能当凭据落盘(否则上游拿到 [已隐藏] 静默 401),这里直接拒绝保存
function findRedacted(value, path = '') {
  if (value === REDACTED) return path || '(根)'
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findRedacted(item, path + '[' + index + ']')
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const hit = findRedacted(item, path ? path + '.' + key : key)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

function assertRestored(custom) {
  const headerHit = findRedacted(custom.headers, 'headers')
  if (headerHit !== undefined) throw new Error('自定义请求头的隐藏项无法还原(' + headerHit + '),请重新填写该字段')
  if (typeof custom.body === 'string' && custom.body.length > 0) {
    let parsed
    try {
      parsed = JSON.parse(custom.body)
    } catch {
      if (custom.body.includes(REDACTED)) throw new Error('自定义请求体的隐藏项无法还原(JSON 已改动),请重新填写该字段')
      return
    }
    const bodyHit = findRedacted(parsed, 'body')
    if (bodyHit !== undefined) throw new Error('自定义请求体的隐藏项无法还原(' + bodyHit + '),请重新填写该字段')
  }
}

// 脱敏回存的纯函数面:路由层只负责拒绝落盘,判定逻辑在此单测
export const __test = {
  redactAccount,
  redactUrl,
  redactTextSecrets,
  restoreHeaders,
  restoreBody,
  restoreUrl,
  findRedacted,
  assertRestored,
  assertRestoredUrl,
  REDACTED,
}

async function queryAccount(account, lifecycleSignal) {
  const queriedAt = Date.now()
  let last
  try {
    const text = await performRequest(buildRequest(account), lifecycleSignal)
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error('响应不是合法 JSON')
    }
    const topError = body && body.error
    if (topError && typeof topError.message === 'string') throw new Error(topError.message)
    const reading = parseReading(account, body)
    last = { ok: true, reading, error: null, queriedAt }
  } catch (error) {
    last = { ok: false, reading: null, error: error && error.message ? error.message : String(error), queriedAt }
  }
  account.last = last
  return { ok: last.ok, account }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
// timer 为软依赖:不进 inject 声明,服务缺失时仅停用自动轮询,面板手动查询不受影响
// 推送总线:页内通知刷新统一走公共依赖 common-tools,客户端长轮询已废除(不留双路径)
export const inject = ['webServer']

export function apply(ctx, configRef) {
  // 宿主闸门 + 写路由 CSRF 闸门(同源 / JSON content-type)统一由共享 withRouteGate
  // 在注册处包一层:插件 exact 路由先于宿主 /api prefix 命中,否则无 cookie 的调用
  // 绕过 connection.admit 直接进业务面
  const register = ctx.webServer.register.bind(ctx.webServer)
  const gatedRegister = (route) => register({ ...route, handler: withRouteGate(ctx, route.handler) })
  const tools = setupCommonTools(ctx)
  const changes = createChangeNotifier(() => tools.publish())
  ctx.effect(() => () => changes.dispose(), '通知变更合并')
  const notifyChange = changes.refresh
  let config = null
  let loadPromise = null
  let writeChain = Promise.resolve()
  let accountsBroken = false
  const historyStore = createHistoryStore({ file: HISTORY_FILE })
  // 账号配置原子替换:直接写目标文件会先截断,崩溃/ENOSPC 留下半截 JSON,
  // 损坏守卫再把坏文件备份并永久拒写(账号 Key 全丢)
  const writeAccountsFile = createAtomicWriter(DATA_FILE)
  let history = newSequenceStore()
  // 账号级退避状态:每账号失败计数独立,只管退避不管调度;调度到点由 last.queriedAt + 统一间隔另行判定
  const pollState = new Map()  // 通知投影(client 轮询展示)与事件序号
  const projection = createProjection({})
  let notifySeq = 0
  // 实例生命周期:dispose 即中止在途上游查询与出站请求,并阻断迟到结果写盘/通知。
  // 共享数据目录下旧实例若继续写会覆盖新实例,禁用/HMR 后必须尽早停手。
  const lifecycle = new AbortController()
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    lifecycle.abort()
    historyStore.stop()
  }, 'usage-panel lifecycle')

  function readNotifySettings() {
    const settings = ctx.get('settings')
    // 双形读(maintain 同构):legacy settings 命名空间 get;0.1.7+ apply 入参
    // config 整节解包。方法面守卫兼防:服务在但缺 get 时回落默认值,防路由 handler 抛错
    const value = settings && typeof settings.get === 'function' ? settings.get(NAMESPACE) : unwrapVolatile(configRef)
    return resolvedNotifySettings(value && typeof value === 'object' ? value.notify : undefined)
  }

  // 通知配置串行写链:读改写整体追加进链,合并读的总是前序写完成后的最新值;
  // 任一失败不吞链(换行续链,失败只回报本次请求)
  let notifyConfigWriteChain = Promise.resolve()

  function persistNotifyPatch(patch) {
    if (disposed) return Promise.reject(new Error(DISPOSED_MESSAGE))
    const run = notifyConfigWriteChain.then(async () => {
      if (disposed) throw new Error(DISPOSED_MESSAGE)
      // 读出当前值做浅合并后整体写回,不依赖宿主写入的嵌套合并语义
      const merged = { ...readNotifySettings(), ...patch }
      // 双形写(maintain 同构,判定延迟到使用点):legacy 方法面以 register 为准
      // (0.1.7 的 settings.update 名义在场但按命名空间找条目必败,不可作判据);
      // 0.1.7+ 走 configEditor.edit 落 profile 条目(fiber.entry,与命名空间解耦)
      const settings = ctx.get('settings')
      requireOk(settings !== undefined, 'settings 服务不可用')
      if (typeof settings.register === 'function' && typeof settings.update === 'function') {
        return settings.update(NAMESPACE, { notify: merged })
      }
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber?.entry
      requireOk(editor && typeof editor.edit === 'function' && entry, 'configEditor 服务不可用')
      return editor.edit(entry, (current) => ({ ...current, notify: merged }))
    })
    notifyConfigWriteChain = run.then(() => {}, () => {})
    return run
  }

  function ensureHistory() {
    return historyStore.ensure().then((sequences) => {
      history = sequences
      return history
    })
  }

  function persistHistory() {
    if (disposed) return Promise.reject(new Error(DISPOSED_MESSAGE))
    return historyStore.persist().then(() => { bumpDataRevision() })
  }

  // 数据修订号(F31):账号/历史任一持久化成功即自增;面板经 revision 路由
  // 对账,读数落后即重拉——后台轮询写入不再让面板陈旧
  let dataRevision = 0
  // 账号表独立修订号:查询只更新 last 也会 persistConfig,不能拿 dataRevision
  // 做账号保存的乐观锁,否则正常查询会把用户的保存误判成并发冲突。
  let accountsRevision = 0
  // 修订号比较与落盘必须在同一临界区:仅比较 revision 仍有 TOCTOU,两个
  // 携带同修订号的请求可以同时通过检查,后写者覆盖先写者。
  let accountsWriteChain = Promise.resolve()
  function withAccountsLock(job) {
    const run = accountsWriteChain.then(job, job)
    accountsWriteChain = run.catch(() => {})
    return run
  }
  function bumpDataRevision() {
    dataRevision += 1
    notifyChange()
  }
  const dataRevisionOf = () => dataRevision

  // 查询成功后落快照:按读数取样追加各序列,并重建当月月窗口序列。
  function recordSnapshots(account, reading, queriedAt) {
    if (disposed) return Promise.resolve()
    const snaps = readingToSnapshots(reading)
    for (const snap of snaps) {
      appendPoint(history, account.id + ':' + snap.suffix, queriedAt, snap.value, queriedAt)
    }
    buildMonthSequence(history, account.id, queriedAt)
    return persistHistory()
  }

  // 账号级退避状态:基期 = 统一查询间隔,每账号失败计数独立,只管退避不管调度
  function pollEntry(account) {
    const existing = pollState.get(account.id)
    if (existing) return existing
    const backoff = createBackoff({ baseSec: POLL_INTERVAL_SEC })
    pollState.set(account.id, backoff)
    return backoff
  }

  // 同账号单飞(F13):重复触发的查询共享同一在途 promise,不并发打上游
  const inflightQueries = new Map()

  function runQuery(account) {
    // 归属校验(F13):闭包持的是查询发起时的账号对象;完成时按当前 config
    // 引用对账——账号已删除/替换则本结果为孤儿,丢弃不写不评估;dispose 后的
    // 迟到结果同样按孤儿处理(不允许旧实例写盘/外发)
    const owned = () => !disposed && config !== null && Array.isArray(config.accounts) && config.accounts.includes(account)
    const queriedAt = Date.now()
    const inflight = inflightQueries.get(account.id)
    if (inflight !== undefined) return inflight
    const run = queryAccount(account, lifecycle.signal).then((result) => {
      inflightQueries.delete(account.id)
      if (!owned()) return { ...result, ok: false, orphaned: true }
      const backoff = pollEntry(account)
      if (result.ok) {
        backoff.onSuccess()
        // 先评估后落盘:阈值穿越事件不因落盘失败丢失;落盘失败仅弃本轮快照
        evaluateAndDispatch(account, queriedAt)
        return recordSnapshots(account, account.last.reading, queriedAt)
          .catch(() => {})
          .then(() => result)
      }
      backoff.onFailure(Math.floor(queriedAt / 1000))
      return result
    }).catch((error) => {
      inflightQueries.delete(account.id)
      throw error
    })
    inflightQueries.set(account.id, run)
    return run
  }

  // 刷新评估:越逻辑点事件入投影并经 webhook / dsh-im 投递;沿触发状态随账号落盘,
  // 重启不重发。评估在通知关闭时短路,状态零成本。
  function evaluateAndDispatch(account, queriedAt) {
    if (disposed) return
    const globalNotify = readNotifySettings()
    if (!globalNotify.enabled) return
    const rule = mergeAccountOverride(globalNotify, account.notify)
    const outcome = evaluateAccount({
      account,
      rule,
      state: account.notifyState || createNotifyState(),
      seq: notifySeq,
      ts: queriedAt,
    })
    notifySeq += outcome.events.length
    account.notifyState = outcome.state
    for (const event of outcome.events) {
      // toast 开关在投影侧消费:关闭即浏览器半区订阅不到,出站通道不受影响
      if (globalNotify.toast) {
        projection.push(event)
        notifyChange()
      }
      void sendWebhook({ url: globalNotify.webhookUrl, payload: buildWebhookPayload(event), signal: lifecycle.signal })
      deliverIm(event, globalNotify)
    }
  }

  // IM 投递:多目标逐发 fire-and-forget 不重试,失败即弃,与 webhook 同语义;
  // dshIm 经运行期可选读取,未装 dsh-im 的 profile 本插件照常工作。
  function deliverIm(event, globalNotify) {
    if (disposed) return
    const dshIm = ctx.get('dshIm')
    if (dshIm === undefined) return
    for (const { botId, targetId } of normalizeImTargets(globalNotify.imTargets)) {
      const timeoutSignal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
      const signal = AbortSignal.any([lifecycle.signal, timeoutSignal])
      void Promise.resolve().then(() => dshIm.send(botId, targetId, event.text, { signal })).catch(() => {})
    }
  }

  function ensureConfig() {
    if (config !== null && !accountsBroken) return Promise.resolve(config)
    // 损坏态每次调用都重试读原路径:只有出现可解析文件才算恢复;
    // 备份导致的 ENOENT 不是恢复(否则下一次调用即解除,坏文件后的首个写入就会覆盖账号)
    if (accountsBroken) loadPromise = null
    if (!loadPromise) {
      const wasBroken = accountsBroken
      // 损坏守卫(historyStore 同构):解析失败先把坏文件备份 .bak 并标记 broken 拒写,
      // 防空配置被后续持久化覆盖,账号 Key 全部丢失
      loadPromise = readFile(DATA_FILE, 'utf8')
        .then((text) => {
          const parsed = JSON.parse(text)
          requireOk(parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.accounts), '配置形态无效')
          config = parsed
          accountsBroken = false
          return config
        })
        .catch((error) => {
          const missing = error && error.code === 'ENOENT'
          // 首次使用缺失文件是合法初始态;损坏备份后的缺失仍是损坏
          if (missing && !wasBroken) {
            config = defaultConfig()
            accountsBroken = false
            return config
          }
          if (config === null) config = defaultConfig()
          accountsBroken = true
          if (missing) return config
          return rename(DATA_FILE, DATA_FILE + BAK_SUFFIX).catch(() => {}).then(() => config)
        })
    }
    return loadPromise
  }

  function persistConfig() {
    if (accountsBroken) return Promise.reject(new Error(ACCOUNTS_BROKEN_MESSAGE))
    if (disposed) return Promise.reject(new Error(DISPOSED_MESSAGE))
    // 写链毒化防护:链上失败不传播到后续写入(调用方 await 本次结果感知单次失败);
    // 落盘成功即自增修订号并广播(F31):全部账号变更路径(增删改/启停/重排)
    // 都经此口,面板订阅对账,单飞重拉账号与历史
    const result = writeChain.then(async () => {
      // dispose 可能落在排队期间:执行前复查,旧实例不得再写盘
      if (disposed) throw new Error(DISPOSED_MESSAGE)
      await mkdir(dirname(DATA_FILE), { recursive: true })
      // mkdir 可能让出事件循环,写文件前再复查
      if (disposed) throw new Error(DISPOSED_MESSAGE)
      // 临时文件 + rename:写入中断只毁临时文件,accounts.json 保持旧完整内容
      await writeAccountsFile(JSON.stringify(config))
      bumpDataRevision()
    })
    writeChain = result.catch(() => {})
    return result
  }

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/accounts',
        handler: guardedRoute(async (req, res) => {
          if (req.method === 'GET') {
            const current = await ensureConfig()
            sendJson(res, 200, { accounts: current.accounts.map(redactAccount), revision: accountsRevision })
            return
          }
          const body = await readJsonBody(req)
          return withAccountsLock(async () => {
            await ensureConfig()
            // 账号表乐观锁:客户端带读取时的修订号;不一致说明他窗已改,拒绝整体覆盖。
            if (Number.isInteger(body && body.revision) && body.revision !== accountsRevision) {
              sendJson(res, 409, { error: '配置已被其他窗口修改,请刷新后重试', revision: accountsRevision })
              return
            }
            await ensureHistory()
            const previous = Array.isArray(config.accounts) ? config.accounts : []
            const saved = normalizeAccounts(body && body.accounts).map((account) => {
              const old = previous.find((item) => item.id === account.id)
              // 基础地址与自定义端点 URL 同样可能带 userinfo/敏感查询参数:回显已脱敏,
              // 回存按旧账号对称还原;任何账号(含新建)都不得把占位当凭据落盘
              const baseUrl = restoreUrl(account.baseUrl, old === undefined ? '' : old.baseUrl)
              assertRestoredUrl(baseUrl)
              const oldCustom = old === undefined ? {} : old.custom || {}
              const custom = {
                ...account.custom,
                url: restoreUrl(account.custom.url, oldCustom.url),
                headers: restoreHeaders(account.custom.headers, oldCustom.headers),
                body: restoreBody(account.custom.body, oldCustom.body),
              }
              assertRestored(custom)
              assertRestoredUrl(custom.url)
              if (old === undefined) return { ...account, baseUrl, custom }
              // 客户端拿不到旧 Key,空 Key 视为「保持不变」;last 与 notifyState 不经表单,
              // 同 id 旧值回填,防编辑账号丢失读数与沿触发防抖基线。自定义头/体/URL 的
              // 脱敏占位同样按旧账号还原,否则编辑名称就会把凭据写成占位。
              const merged = account.apiKey.length > 0 ? account : { ...account, apiKey: old.apiKey }
              return { ...merged, baseUrl, custom, last: old.last, notifyState: old.notifyState }
            })
            // P1-2:删除前先快照 history/pollState,persistConfig 成功才算删除生效;
            // 失败时逐项恢复(只恢复被删项,保留并发查询新增的数据)
            const removedPollEntries = [...pollState.entries()].filter(([id]) => !saved.some((account) => account.id === id))
            const removedHistoryEntries = Object.entries(history).filter(([key]) => {
              const accountId = key.slice(0, key.indexOf(':'))
              return !saved.some((account) => account.id === accountId)
            })
            config = { version: 1, accounts: saved }
            accountsRevision += 1
            const savedRevision = accountsRevision
            for (const [id] of removedPollEntries) pollState.delete(id)
            for (const [key] of removedHistoryEntries) delete history[key]
            await persistConfig().catch((error) => {
              // 写失败(如 broken 拒写)回滚内存态,防 tick/GET 与磁盘不一致;
              // history/pollState 恢复删除前快照,否则下一次 persistHistory 会把缺历史永久落盘
              config = { version: 1, accounts: previous }
              accountsRevision = savedRevision - 1
              for (const [id, value] of removedPollEntries) pollState.set(id, value)
              for (const [key, value] of removedHistoryEntries) history[key] = value
              throw error
            })
            // 删除账号后历史清理失败不能静默:账号已从配置移除,下次 persist 会覆盖,
            // 但本轮磁盘仍留旧历史,必须让调用方看见(响应告警 + 日志),不假装成功
            let historyWarning = null
            await persistHistory().catch((error) => {
              historyWarning = error && error.message ? error.message : String(error)
              ctx.logger?.warn?.('usage-panel: 账号变更后历史落盘失败: ' + historyWarning)
            })
            sendJson(res, 200, {
              ok: true,
              accounts: saved.map(redactAccount),
              revision: savedRevision,
              ...(historyWarning === null ? {} : { historyWarning }),
            })
          })
        }),
      }),
    'usage-panel accounts route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/query',
        handler: guardedRoute.post(async (req, res) => {
          const body = await readJsonBody(req)
          const id = body && typeof body.id === 'string' ? body.id : ''
          const auto = body && body.auto === true
          const current = await ensureConfig()
          const account = current.accounts.find((item) => item.id === id)
          requireOk(account !== undefined, '账号不存在: ' + id)
          // 面板打开触发的自动查询受退避约束,避免绕过退避轰炸上游;手动刷新不受限
          if (auto && pollEntry(account).isBlocked(Math.floor(Date.now() / 1000))) {
            sendJson(res, 200, { ok: false, skipped: true, account: redactAccount(account) })
            return
          }
          await ensureHistory()
          const result = await runQuery(account)
          // last/notifyState 落盘失败不否定已成功的查询
          await persistConfig().catch(() => {})
          sendJson(res, 200, { ok: result.ok, account: redactAccount(result.account) })
        }),
      }),
    'usage-panel query route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/history',
        handler: guardedRoute(async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          await ensureHistory()
          // P3:按账号过滤(逗号分隔),面板单卡刷新/对账只取变化账号的序列,
          // 避免 20 账号 × 数千点整表重拉
          const raw = new URL(req.url, 'http://localhost').searchParams.get('accountIds')
          if (raw !== null) {
            const ids = raw.length === 0 ? [] : raw.split(',')
            requireOk(ids.length <= MAX_ACCOUNTS, 'accountIds 数量超过上限')
            const filtered = {}
            for (const id of ids) {
              requireOk(/^[^:,]{1,128}$/.test(id), 'accountIds 含非法账号 id')
              const prefix = id + ':'
              for (const key of Object.keys(history)) {
                if (key.indexOf(prefix) === 0) filtered[key] = history[key]
              }
            }
            sendJson(res, 200, { sequences: filtered })
            return
          }
          sendJson(res, 200, { sequences: history })
        }),
      }),
    'usage-panel history route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/settings',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          sendJson(res, 200, { pollArmed })
        },
      }),
    'usage-panel settings route',
  )

  // 测试事件构造:与评估产出共用 buildNotifyEvent,防事件形态平行漂移
  const buildTestEvent = () => {
    notifySeq += 1
    return buildNotifyEvent({
      kind: 'quota',
      accountId: 'test',
      accountName: '测试账号',
      label: '5小时',
      detail: { value: 92, threshold: 90 },
      text: '[dsh] 测试事件:账号余额通知通道',
    }, notifySeq, Date.now())
  }

  // dsh-im 投递错误码到 HTTP 状态的映射,未收录错误按网关失败处理
  const IM_ERROR_STATUS = { 'bad-request': 400, 'unknown-bot': 404, 'bot-not-connected': 503 }

  ctx.effect(() => {
    const disposeRoute = gatedRegister({
      kind: 'exact',
      path: '/api/usage-panel/notifications',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 快照:恒全量返回(变更通知走总线,不再长轮询挂起);丢失恢复靠订阅 onReset 全量对账
        sendJson(res, 200, { units: projection.list(), version: projection.version() })
      },
    })
    return () => {
      disposeRoute()
    }
  }, 'usage-panel notifications route')

  // 数据修订号对账口(F31):面板轮询比对本值,落后即重拉账号与历史
  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/revision',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          sendJson(res, 200, { revision: dataRevisionOf() })
        },
      }),
    'usage-panel revision route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/notify-config',
        handler: guardedRoute(async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, { notify: publicNotify(readNotifySettings()), imAvailable: ctx.get('dshIm') !== undefined })
            return
          }
          const body = await readJsonBody(req)
          const check = validateNotifyPatch(body)
          requireOk(check.ok, check.reason)
          // 读改写经串行链执行:重叠请求各自基于旧快照合并会互相覆盖
          // persistNotifyPatch 内部把读改写整体追加进共享写链:任一写读取的总是
          // 前序写完成后的最新值;链以 catch 续接,单次失败只回报本次请求
          // (抛错由 guardedRoute 统一转 400),不阻断后续写
          await persistNotifyPatch(check.patch)
          sendJson(res, 200, { ok: true, notify: publicNotify(readNotifySettings()) })
        }),
      }),
    'usage-panel notify-config route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/test-webhook',
        handler: guardedRoute.post(async (req, res) => {
          const result = await sendWebhook({ url: readNotifySettings().webhookUrl, payload: buildWebhookPayload(buildTestEvent()), signal: lifecycle.signal })
          sendJson(res, 200, result)
        }),
      }),
    'usage-panel test-webhook route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/im-targets',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const dshIm = ctx.get('dshIm')
          if (dshIm === undefined) {
            sendJson(res, 503, { error: 'dsh-im 未安装' })
            return
          }
          const botId = new URL(req.url, 'http://localhost').searchParams.get('botId') || ''
          if (!isValidImBotId(botId)) {
            sendJson(res, 400, { error: 'botId 缺失或非法' })
            return
          }
          try {
            const targets = await dshIm.listTargets(botId)
            // route 为平台原生路由 ID,选择目标无需知道,不出主机
            sendJson(res, 200, { targets: targets.map(({ targetId, name, kind }) => ({ targetId, name, kind })) })
          } catch (error) {
            const code = error && error.code ? error.code : 'delivery-failed'
            sendJson(res, IM_ERROR_STATUS[code] ?? 502, { error: code })
          }
        },
      }),
    'usage-panel im-targets route',
  )

  ctx.effect(
    () =>
      gatedRegister({
        kind: 'exact',
        path: '/api/usage-panel/test-im',
        handler: guardedRoute.post(async (req, res) => {
          const dshIm = ctx.get('dshIm')
          if (dshIm === undefined) {
            sendJson(res, 200, { ok: false, detail: 'dsh-im 未安装' })
            return
          }
          const targets = normalizeImTargets(readNotifySettings().imTargets)
          if (targets.length === 0) {
            sendJson(res, 200, { ok: false, detail: '未配置投递目标' })
            return
          }
          // 逐目标结算,真实结果随响应返回,与 test-webhook 的不谎报原则一致
          const results = await Promise.all(targets.map(async ({ botId, targetId }) => {
            try {
              const timeoutSignal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
              await dshIm.send(botId, targetId, buildTestEvent().text, { signal: AbortSignal.any([lifecycle.signal, timeoutSignal]) })
              return { botId, targetId, ok: true, detail: 'sent' }
            } catch (error) {
              return { botId, targetId, ok: false, detail: error && error.code ? error.code : 'delivery-failed' }
            }
          }))
          sendJson(res, 200, { ok: results.every((item) => item.ok), results })
        }),
      }),
    'usage-panel test-im route',
  )

  // 定期轮询:固定短 tick,时间驱动调度——上次尝试查询时刻(account.last.queriedAt,
  // 成功失败均记、随配置持久化)距今超过统一查询间隔即到点;退避独立叠加,二者皆过才查。
  // 旧 round 分频形态已废:round 仅查询时递增使余额类账号死锁停摆,短窗账号每 tick 必查
  // 使间隔设置失效。
  // timer 软依赖经嵌套 inject 等待:服务激活才武装轮询,缺失则自动轮询停用,
  // 面板手动查询不受影响,也不因等待服务而阻塞插件装载。
  // pollArmed(武装,外露)与 pollInFlight(单轮在途互斥)分离:在途是瞬态,
  // 误作可用性暴露会让健康环境常驻误报降级。dispose 显式挂回插件 fiber,
  // timer 服务重启导致嵌套 fiber 重跑时不产生双 interval
  let pollInFlight = false
  let pollArmed = false
  ctx.inject(['timer'], (timerCtx) => {
    if (typeof timerCtx.interval !== 'function') return
    // 配置预载:启动即读盘,消除懒加载空窗——否则宿主重启后直到首个面板请求前,
    // tick 回调因 config 为 null 空转,自动查询静默停摆,通知全部缺席
    void ensureConfig()
    const dispose = timerCtx.interval(() => {
      if (disposed || pollInFlight) return
      const current = config
      if (!current) return
      const nowSec = Math.floor(Date.now() / 1000)
      const due = current.accounts.filter((account) => {
        if (pollEntry(account).isBlocked(nowSec)) return false
        return isDue({
          lastQuerySec: lastQuerySecOf(account.last),
          nowSec,
          intervalSec: POLL_INTERVAL_SEC,
        })
      })
      if (due.length === 0) return
      pollInFlight = true
      ensureHistory()
        .then(async () => {
          // 受限并发执行:单账号失败/超时不拖满整轮,后续 tick 不因互斥停摆
          await runLimited(due, POLL_CONCURRENCY, (account) => runQuery(account).catch(() => {}))
          if (!disposed) await persistConfig().catch(() => {})
        })
        .catch(() => {})
        .then(() => {
          pollInFlight = false
        })
    }, TICK_SEC * 1000)
    ctx.effect(() => dispose, 'usage-panel poll interval')
    pollArmed = true
  })

  ctx.inject(['settings'], (settingsCtx) => {
    // 方法面守卫:settings 服务缺 register 面(0.1.7 已移除)即走新形态分支;
    // 0.1.7 关闭原生自动设置页,设置面由本包自带分区承担(maintain 同构)
    if (typeof settingsCtx.settings.register !== 'function') {
      if (typeof settingsCtx.settings?.configure === 'function') {
        settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
      }
      return
    }
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA)
  })
}
