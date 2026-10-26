// api:REST 路由 /api/cron-board/*。宿主 webServer 仅支持 exact/prefix 注册,
// 本插件注册一条 prefix,handler 内按 method + 路径段表驱动分发(:id 路径段捕获);
// 错误语义对齐仓内惯例:业务错误中文透传,系统级错误收敛固定文案并落服务端日志。
// 写方法成功受理即经 notifyChange 发布总线变更(通知面/数据面分离,客户端 refetch 快照)。

import { assertValidSchedule, nextRunAtOf, nextRunsOf, summarizeCron } from './cron.mjs'
import { DEFAULT_MAX_EXPANSION, DEFAULT_TIMEOUT_MS } from './config.mjs'
import { maskValue } from './env-text.mjs'

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
  badAgentPreset: '执行预设 ID 仅限小写字母、数字与连字符',
  badSessionModel: '模型指定不合法:provider 与 model 必须为非空文本,reasoningEffort 可省略',
  jobNotFound: '任务不存在',
  runNotFound: '运行记录不存在',
  sessionDisabled: '宿主会话服务不可用,会话任务通道已禁用',
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

// 多值归一:values 数组(客户端契约)按行折叠进 value 存储形态(单行 + multi 标志,
// 展开时拆行);数组缺失或非多值回退原 value 字符串语义
function normalizeEnvValue(body, multi) {
  if (multi && Array.isArray(body.values)) {
    return body.values
      .map((item) => String(item).trim())
      .filter((line) => line !== '')
      .join('\n')
  }
  return typeof body.value === 'string' ? body.value : ''
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

// 会话任务专有字段(设计 §3.2 job.session 子对象);agentPreset 形态对齐宿主预设目录 id(dsh-im 同款校验)
const AGENT_PRESET_PATTERN = /^[a-z0-9][a-z0-9-]*$/

// 模型指定归一:provider/model 必填非空文本,reasoningEffort 可省;
// provider/model 均为空白 = 未指定(返回 undefined,跟随宿主默认);形态残缺即业务错误
function normalizeSessionModel(raw) {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object') throw new Error(MESSAGES.badSessionModel)
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' && model === '') return undefined
  if (provider === '' || model === '') throw new Error(MESSAGES.badSessionModel)
  const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
  if (raw.reasoningEffort !== undefined && reasoningEffort === '') throw new Error(MESSAGES.badSessionModel)
  return reasoningEffort === '' ? { provider, model } : { provider, model, reasoningEffort }
}

// 会话任务专有字段(设计 §3.2 job.session 子对象)
function normalizeSession(body) {
  if (body.kind !== 'session') return undefined
  const raw = body.session && typeof body.session === 'object' ? body.session : {}
  if (raw.mode !== undefined && raw.mode !== 'fresh' && raw.mode !== 'pinned') throw new Error(MESSAGES.badSessionMode)
  const agentPreset = typeof raw.agentPreset === 'string' ? raw.agentPreset.trim() : ''
  if (agentPreset !== '' && !AGENT_PRESET_PATTERN.test(agentPreset)) throw new Error(MESSAGES.badAgentPreset)
  const session = {
    mode: raw.mode === 'pinned' ? 'pinned' : 'fresh',
    pinnedSessionId: typeof raw.pinnedSessionId === 'string' ? raw.pinnedSessionId.trim() : '',
    // 空串 = 跟随宿主当前默认(driver 建会话时对空值省略字段)
    agentPreset,
  }
  const model = normalizeSessionModel(raw.model)
  if (model) session.model = model
  return session
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
  const normalized = {
    name,
    kind,
    command,
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    workdir: typeof body.workdir === 'string' ? body.workdir.trim() : '',
    schedule,
    enabled: body.enabled !== false,
    session: normalizeSession(body),
  }
  if (normalized.session === undefined) delete normalized.session
  // 会话任务投递即终态无超时语义,timeoutMs 仅为 shell 真实执行保留
  if (kind === 'shell') {
    normalized.timeoutMs = Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : DEFAULT_TIMEOUT_MS
  }
  // 单次运行:真实运行入队即禁用(executor dispatch 承担),缺省关闭
  normalized.runOnce = body.runOnce === true
  // 任务级并发上限:合法正整数才落库,缺省走全局闸门(executor min 规则)
  if (Number.isInteger(body.concurrency) && body.concurrency > 0) normalized.concurrency = body.concurrency
  // nextRunAt:调用方可显式指定(导入任务保留原状态 / 测试注入到期时刻),缺省按 schedule 计算
  normalized.nextRunAt = typeof body.nextRunAt === 'number' && Number.isFinite(body.nextRunAt)
    ? body.nextRunAt
    : nextRunAtOf(schedule)
  return normalized
}

export function createApi({ store, logger, executor, scheduler, periodic, sessionState, readSidebarTab, updateUiSettings, getAgentPresets, getSessionController, logSystem, notifyChange }) {

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
        const multi = body.multi === true
        const row = await store.envs.create({
          name,
          value: normalizeEnvValue(body, multi),
          remarks: typeof body.remarks === 'string' ? body.remarks : '',
          enabled: body.enabled !== false,
          multi,
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
        if (body.multi !== undefined) patch.multi = body.multi === true
        // values 数组折叠与 POST 同前提:仅 multi===true 时采纳(client 契约恒带 multi)
        if (body.multi === true && Array.isArray(body.values)) patch.value = normalizeEnvValue(body, true)
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
      // 环境变量文本导入:apply!==true 即预览(返回解析行数组),apply=true 落库
      // overwrite=true 先清空再导入,缺省追加;与 client ImportForm 契约一一对应
      method: 'POST',
      segments: ['envs', 'import'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const { rows, invalid } = parseEnvText(body.text)
        if (body.apply !== true) {
          sendJson(res, 200, { parsed: rows, invalid })
          return
        }
        const mode = body.overwrite === true ? 'overwrite' : 'append'
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
          session: sessionState
            ? { ready: Boolean(sessionState.ready), disabled: Boolean(sessionState.disabled) }
            : { ready: false, disabled: false },
          // 宿主进程时区偏移小时数:无后缀任务的展示时区(调度与展示同源,与浏览器无关)
          serverTzOffset: -new Date().getTimezoneOffset() / 60,
          ui: { sidebarTab: readSidebarTab ? readSidebarTab() === true : false },
        })
      },
    },
    {
      // 界面偏好写入(sidebarTab 等):settings.update 服务端持久化,即时生效
      method: 'POST',
      segments: ['ui-settings'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const patch = {}
        if (typeof body.sidebarTab === 'boolean') patch.sidebarTab = body.sidebarTab
        if (!Object.keys(patch).length) return sendJson(res, 400, { error: '无有效字段' })
        if (typeof updateUiSettings !== 'function') return sendJson(res, 200, { ok: false, error: '设置服务不可用' })
        const persisted = await updateUiSettings(patch)
        sendJson(res, 200, { ok: persisted, ui: { sidebarTab: readSidebarTab ? readSidebarTab() === true : false } })
      },
    },
    {
      // 编辑表单实时预览:croner 服务端解析,前端不引解析依赖(定案 §6.2)
      method: 'POST',
      segments: ['cron', 'preview'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : ''
        assertValidSchedule(schedule)
        sendJson(res, 200, { summary: summarizeCron(schedule), nextAt: nextRunsOf(schedule, 3) })
      },
    },
    {
      method: 'GET',
      segments: ['agent-presets'],
      handler: async ({ res }) => {
        // 目录来自宿主 agentPresets 服务(dsh-im 同构);服务缺失或异常回空目录,前端仅展示「跟随宿主默认」
        const catalog = { defaultId: '', items: [] }
        try {
          const service = getAgentPresets ? getAgentPresets() : undefined
          if (service && typeof service.list === 'function') {
            const listed = await service.list()
            const seen = new Set()
            for (const entry of Array.isArray(listed) ? listed : []) {
              const row = typeof entry === 'string' ? { id: entry } : entry
              const id = row && typeof row.id === 'string' ? row.id.trim() : ''
              if (id === '' || !AGENT_PRESET_PATTERN.test(id) || seen.has(id) || row.broken !== undefined) continue
              seen.add(id)
              const label = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 128) : id
              catalog.items.push({ id, label })
            }
            if (typeof service.defaultId === 'string' && AGENT_PRESET_PATTERN.test(service.defaultId.trim())) {
              catalog.defaultId = service.defaultId.trim()
            }
          }
        } catch { /* 目录降级为空,不阻断任务表单 */ }
        sendJson(res, 200, catalog)
      },
    },
    {
      // 模型目录:宿主 sessionController.modelCatalog 的看板归一面;
      // 服务缺失或异常回空目录,前端仅「跟随宿主默认」可选(agent-presets 同构)
      method: 'GET',
      segments: ['model-catalog'],
      handler: async ({ res }) => {
        const catalog = { default: null, items: [], failures: [] }
        try {
          const controller = getSessionController ? getSessionController() : undefined
          if (controller && typeof controller.modelCatalog === 'function') {
            const raw = await controller.modelCatalog()
            for (const group of Array.isArray(raw && raw.groups) ? raw.groups : []) {
              const models = Array.isArray(group && group.models) ? group.models : []
              if (group && typeof group.id === 'string' && group.id !== '' && models.length > 0) {
                catalog.items.push({
                  provider: group.id,
                  name: typeof group.name === 'string' && group.name.trim() ? group.name.trim() : group.id,
                  models: models
                    .filter((model) => model && typeof model.id === 'string' && model.id !== '')
                    .map((model) => ({
                      id: model.id,
                      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id,
                      efforts: model.reasoning && Array.isArray(model.reasoning.efforts)
                        ? model.reasoning.efforts.filter((effort) => effort && typeof effort.id === 'string' && effort.id !== '')
                        : [],
                      ...(model.reasoning && typeof model.reasoning.defaultEffort === 'string' ? { defaultEffort: model.reasoning.defaultEffort } : {}),
                    })),
                })
              }
            }
            const failures = Array.isArray(raw && raw.failures) ? raw.failures : []
            catalog.failures = failures.filter((item) => item && typeof item.id === 'string' && item.id !== '')
            const fallback = raw && raw.default
            if (fallback && typeof fallback.provider === 'string' && typeof fallback.model === 'string') {
              catalog.default = { provider: fallback.provider, model: fallback.model }
            }
          }
        } catch { /* 目录降级为空,不阻断任务表单 */ }
        sendJson(res, 200, catalog)
      },
    },
    {
      method: 'GET',
      segments: ['jobs'],
      handler: async ({ res }) => {
        // summary 人话摘要随行返回,前端不引解析依赖
        const items = store.jobs.list().map((job) => ({ ...job, summary: summarizeCron(job.schedule) }))
        sendJson(res, 200, { items })
      },
    },
    {
      method: 'POST',
      segments: ['jobs'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const fields = normalizeJob(body)
        if (fields.kind === 'session' && sessionState && sessionState.disabled) {
          return sendJson(res, 400, { error: MESSAGES.sessionDisabled })
        }
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
        // 编辑保存:请求未显式携带 nextRunAt 即按当前 schedule 重算。
        // 合并旧任务行会把既有 nextRunAt 当作显式值透传,改期后残留旧触发点导致误执行
        if (body.nextRunAt === undefined) fields.nextRunAt = nextRunAtOf(fields.schedule)
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

  // 写方法统一包装:成功受理即发布变更。预览类 POST(如 envs/import 预览)多发
  // 一次通知,客户端 refetch 幂等无害;集中包装保证未来新增写路由不漏发
  const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT'])
  const dispatchRoute = (matched, callArgs) => WRITE_METHODS.has(matched.route.method) && notifyChange
    ? matched.route.handler(callArgs).then((result) => { notifyChange(); return result })
    : matched.route.handler(callArgs)

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
        await dispatchRoute(matched, { req, res, url, params: matched.params })
      } catch (error) {
        respondError(res, error, logSystem)
      }
    },
  }
}
