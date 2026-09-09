// api:REST 路由 /api/cron-board/*。宿主 webServer 仅支持 exact/prefix 注册,
// 本插件注册一条 prefix,handler 内按 method + 路径段表驱动分发(:id 路径段捕获);
// 错误语义对齐仓内惯例:业务错误中文透传,系统级错误收敛固定文案并落服务端日志。

import { assertValidSchedule, nextRunAtOf } from './cron.mjs'
import { DEFAULT_MAX_EXPANSION, DEFAULT_TIMEOUT_MS } from './config.mjs'

const ROUTE_PREFIX = '/api/cron-board'
const BODY_MAX_BYTES = 64 * 1024

export const MESSAGES = {
  notFound: '接口不存在',
  methodNotAllowed: '请求方法不支持',
  badJsonBody: '请求体不是合法 JSON',
  bodyTooLarge: '请求体超过上限',
  nameRequired: '变量名不能为空',
  jobNameRequired: '任务名称不能为空',
  commandRequired: '任务命令不能为空',
  badKind: '任务类型不合法',
  badSessionMode: '会话模式仅支持 fresh 或 pinned',
  badOnMiss: '窗口外策略仅支持 skip 或 defer',
  windowPairRequired: '窗口起止时间必须成对填写',
  badWindowFormat: '窗口时间格式须为 HH:mm',
  jobNotFound: '任务不存在',
  runNotFound: '运行记录不存在',
  systemError: '操作失败(系统级错误,详见服务端日志)',
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function respondError(res, error, logSystem) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && logSystem) logSystem('[cron-board] ' + String(error && error.stack || error))
  const message = isSystem ? MESSAGES.systemError : (error && error.message ? error.message : String(error))
  sendJson(res, 400, { error: message })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error(MESSAGES.bodyTooLarge))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    if (error && error.message === MESSAGES.bodyTooLarge) throw error
    throw new Error(MESSAGES.badJsonBody)
  }
  return body && typeof body === 'object' ? body : {}
}

// 值打码:前 2 后 2 中间 ***;长度不足 4 时无中间可保留,全打码
export function maskValue(value) {
  if (value.length <= 4) return '***'
  return value.slice(0, 2) + '***' + value.slice(-2)
}

// 导入文本解析:每行 NAME=value 或 NAME=value #备注;空行跳过,无 = 记非法
export function parseEnvText(text) {
  const rows = []
  let invalid = 0
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      invalid++
      continue
    }
    const name = line.slice(0, eq).trim()
    if (name === '') {
      invalid++
      continue
    }
    let rest = line.slice(eq + 1)
    let remarks = ''
    const hash = rest.indexOf(' #')
    if (hash >= 0) {
      remarks = rest.slice(hash + 2).trim()
      rest = rest.slice(0, hash)
    }
    rows.push({ name, value: rest, remarks })
  }
  return { rows, invalid }
}

// 任务字段校验与规范化:非法即业务错误;返回可落库字段集
const WINDOW_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

// 会话任务专有字段(设计 §3.2 job.session 子对象);窗口 start/end 须成对且为 HH:mm
function normalizeSession(body) {
  if (body.kind !== 'session') return undefined
  const raw = body.session && typeof body.session === 'object' ? body.session : {}
  if (raw.mode !== undefined && raw.mode !== 'fresh' && raw.mode !== 'pinned') throw new Error(MESSAGES.badSessionMode)
  if (raw.onMiss !== undefined && raw.onMiss !== 'skip' && raw.onMiss !== 'defer') throw new Error(MESSAGES.badOnMiss)
  const windowStart = raw.windowStart ? String(raw.windowStart).trim() : ''
  const windowEnd = raw.windowEnd ? String(raw.windowEnd).trim() : ''
  if (windowStart === '' !== (windowEnd === '')) throw new Error(MESSAGES.windowPairRequired)
  for (const window of [windowStart, windowEnd]) {
    if (window !== '' && !WINDOW_PATTERN.test(window)) throw new Error(MESSAGES.badWindowFormat)
  }
  return {
    mode: raw.mode === 'pinned' ? 'pinned' : 'fresh',
    pinnedSessionId: typeof raw.pinnedSessionId === 'string' ? raw.pinnedSessionId.trim() : '',
    windowStart,
    windowEnd,
    onMiss: raw.onMiss === 'defer' ? 'defer' : 'skip',
  }
}

function normalizeJob(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') throw new Error(MESSAGES.jobNameRequired)
  const kind = body.kind === 'session' ? 'session' : 'shell'
  if (body.kind !== 'shell' && body.kind !== 'session') throw new Error(MESSAGES.badKind)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (kind === 'shell' && command === '') throw new Error(MESSAGES.commandRequired)
  const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : ''
  assertValidSchedule(schedule)
  const timeoutMs = Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_TIMEOUT_MS
  const normalized = {
    name,
    kind,
    command,
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    scriptPath: typeof body.scriptPath === 'string' ? body.scriptPath : '',
    workdir: typeof body.workdir === 'string' ? body.workdir.trim() : '',
    schedule,
    timeoutMs,
    enabled: body.enabled !== false,
    session: normalizeSession(body),
  }
  if (normalized.session === undefined) delete normalized.session
  // nextRunAt:调用方可显式指定(导入任务保留原状态 / 测试注入到期时刻),缺省按 schedule 计算
  normalized.nextRunAt = typeof body.nextRunAt === 'number' && Number.isFinite(body.nextRunAt)
    ? body.nextRunAt
    : nextRunAtOf(schedule)
  return normalized
}

export function createApi({ store, logger, executor, scheduler, periodic, logSystem }) {

  const routes = [
    {
      method: 'GET',
      segments: ['envs'],
      handler: async ({ res }) => {
        const items = store.envs.list().map((row) => ({ ...row, value: maskValue(row.value) }))
        sendJson(res, 200, { items })
      },
    },
    {
      // 固定段 export 须先于 :id 捕获注册,否则被当作 id 吞掉
      method: 'GET',
      segments: ['envs', 'export'],
      handler: async ({ res, url }) => {
        const includeDisabled = url.searchParams.get('includeDisabled') === '1'
        const rows = store.envs.list().filter((row) => includeDisabled || row.enabled)
        const text = rows.map((row) => row.name + '=' + row.value + (row.remarks ? ' #' + row.remarks : '')).join('\n') + (rows.length > 0 ? '\n' : '')
        sendJson(res, 200, { text })
      },
    },
    {
      method: 'GET',
      segments: ['envs', ':id'],
      handler: async ({ res, params }) => {
        const row = store.envs.get(params.id)
        if (!row) throw new Error('变量不存在:' + params.id)
        sendJson(res, 200, row)
      },
    },
    {
      method: 'POST',
      segments: ['envs'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') throw new Error(MESSAGES.nameRequired)
        const row = await store.envs.create({
          name,
          value: typeof body.value === 'string' ? body.value : '',
          remarks: typeof body.remarks === 'string' ? body.remarks : '',
          enabled: body.enabled !== false,
        })
        sendJson(res, 200, row)
      },
    },
    {
      method: 'PATCH',
      segments: ['envs', ':id'],
      handler: async ({ req, res, params }) => {
        const body = await readJsonBody(req)
        const patch = {}
        if (body.name !== undefined) {
          const name = String(body.name).trim()
          if (name === '') throw new Error(MESSAGES.nameRequired)
          patch.name = name
        }
        for (const field of ['value', 'remarks']) {
          if (body[field] !== undefined) patch[field] = String(body[field])
        }
        if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
        const row = await store.envs.update(params.id, patch)
        if (!row) throw new Error('变量不存在:' + params.id)
        sendJson(res, 200, row)
      },
    },
    {
      method: 'DELETE',
      segments: ['envs', ':id'],
      handler: async ({ res, params }) => {
        const removed = await store.envs.remove(params.id)
        if (!removed) throw new Error('变量不存在:' + params.id)
        sendJson(res, 200, { ok: true })
      },
    },
    {
      method: 'POST',
      segments: ['import'],
      handler: async ({ req, res, url }) => {
        const body = await readJsonBody(req)
        const { rows, invalid } = parseEnvText(body.text)
        if (url.searchParams.get('preview') === '1') {
          const names = new Set(rows.map((row) => row.name))
          sendJson(res, 200, { parsed: rows.length, invalid, nameGroups: names.size })
          return
        }
        const mode = body.mode === 'overwrite' ? 'overwrite' : 'append'
        if (mode === 'overwrite') {
          for (const row of [...store.envs.list()]) {
            await store.envs.remove(row.id)
          }
        }
        for (const row of rows) {
          await store.envs.create({ name: row.name, value: row.value, remarks: row.remarks, enabled: true })
        }
        sendJson(res, 200, { ok: true, imported: rows.length, mode })
      },
    },
    {
      method: 'GET',
      segments: ['status'],
      handler: async ({ res }) => {
        sendJson(res, 200, {
          timerRunning: Boolean(periodic && periodic.running),
          timerReason: periodic && periodic.reason ? periodic.reason : null,
          scheduler: scheduler ? scheduler.status() : { active: 0, queued: 0 },
          nextAt: scheduler && scheduler.nextRunAt ? scheduler.nextRunAt() : null,
        })
      },
    },
    {
      method: 'GET',
      segments: ['jobs'],
      handler: async ({ res }) => {
        sendJson(res, 200, { items: store.jobs.list() })
      },
    },
    {
      method: 'POST',
      segments: ['jobs'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const fields = normalizeJob(body)
        const row = await store.jobs.create(fields)
        sendJson(res, 200, row)
      },
    },
    {
      method: 'PATCH',
      segments: ['jobs', ':id'],
      handler: async ({ req, res, params }) => {
        const body = await readJsonBody(req)
        const existing = store.jobs.get(params.id)
        if (!existing) throw new Error(MESSAGES.jobNotFound)
        const fields = normalizeJob({ ...existing, ...body })
        const row = await store.jobs.update(params.id, fields)
        sendJson(res, 200, row)
      },
    },
    {
      method: 'DELETE',
      segments: ['jobs', ':id'],
      handler: async ({ res, params }) => {
        const removed = await store.jobs.remove(params.id)
        if (!removed) throw new Error(MESSAGES.jobNotFound)
        await logger.removeJob(params.id)
        sendJson(res, 200, { ok: true })
      },
    },
    {
      method: 'POST',
      segments: ['jobs', ':id', 'run'],
      handler: async ({ res, params }) => {
        const job = store.jobs.get(params.id)
        if (!job) throw new Error(MESSAGES.jobNotFound)
        // 预占记录同步返回 runIds,执行经执行链闸门后台推进(结果经运行记录与日志呈现)
        const runIds = await executor.dispatch(job, 'manual')
        sendJson(res, 200, { runIds })
      },
    },
    {
      method: 'POST',
      segments: ['jobs', ':id', 'toggle'],
      handler: async ({ res, params }) => {
        const job = store.jobs.get(params.id)
        if (!job) throw new Error(MESSAGES.jobNotFound)
        const row = await store.jobs.update(params.id, { enabled: !job.enabled })
        sendJson(res, 200, row)
      },
    },
    {
      method: 'GET',
      segments: ['runs'],
      handler: async ({ res, url }) => {
        const jobId = url.searchParams.get('jobId')
        const rows = store.runs.list(jobId).slice().reverse()
        sendJson(res, 200, { items: rows })
      },
    },
    {
      method: 'GET',
      segments: ['runs', ':runId', 'log'],
      handler: async ({ res, params, url }) => {
        const record = store.runs.get(params.runId)
        if (!record) throw new Error(MESSAGES.runNotFound)
        const tailParam = url.searchParams.get('tail')
        const tailLines = tailParam === null ? undefined : Math.max(1, Number(tailParam) || 1)
        const text = await logger.read(record.jobId, params.runId, { tailLines })
        sendJson(res, 200, { text })
      },
    },
    {
      method: 'DELETE',
      segments: ['runs', ':runId', 'log'],
      handler: async ({ res, params }) => {
        const record = store.runs.get(params.runId)
        if (!record) throw new Error(MESSAGES.runNotFound)
        await logger.clear(record.jobId, params.runId)
        sendJson(res, 200, { ok: true })
      },
    },
  ]

  // 路径段匹配:逐段比对,: 开头段捕获参数;返回 null 不匹配
  function matchRoute(method, segments) {
    for (const route of routes) {
      if (route.method !== method) continue
      if (route.segments.length !== segments.length) continue
      const params = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i]
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(segments[i])
        } else if (pattern !== segments[i]) {
          matched = false
          break
        }
      }
      if (matched) return { route, params }
    }
    return null
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost')
      const pathname = url.pathname.startsWith(ROUTE_PREFIX + '/')
        ? url.pathname.slice(ROUTE_PREFIX.length)
        : url.pathname === ROUTE_PREFIX ? '/' : null
      if (pathname === null) {
        sendJson(res, 404, { error: MESSAGES.notFound })
        return
      }
      const segments = pathname.split('/').filter(Boolean)
      try {
        const matched = matchRoute(req.method, segments)
        if (!matched) {
          sendJson(res, 404, { error: MESSAGES.notFound })
          return
        }
        await matched.route.handler({ req, res, url, params: matched.params })
      } catch (error) {
        respondError(res, error, logSystem)
      }
    },
  }
}
