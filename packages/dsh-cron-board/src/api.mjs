// api:REST 路由 /api/cron-board/*。宿主 webServer 仅支持 exact/prefix 注册,
// 本插件注册一条 prefix,handler 内按 method + 路径段表驱动分发(:id 路径段捕获);
// 错误语义对齐仓内惯例:业务错误中文透传,系统级错误收敛固定文案并落服务端日志。
// 写方法成功受理即经 notifyChange 发布总线变更(通知面/数据面分离,客户端 refetch 快照)。

import { assertValidSchedule, nextRunAtOf, nextRunsOf, summarizeCron } from './cron.mjs'
import { DEFAULT_LOG_TAIL_LINES, DEFAULT_MAX_EXPANSION, DEFAULT_TIMEOUT_MS, SESSION_UNAVAILABLE_REASON } from './config.mjs'
import { maskValue } from './env-text.mjs'

const ROUTE_PREFIX = '/api/cron-board'
// 写请求体上限:客户端契约里的长 prompt/env 导入都远小于此值,超限即 413(测试引用同一常量)
export const BODY_MAX_BYTES = 64 * 1024

export const MESSAGES = {
  notFound: '接口不存在',
  methodNotAllowed: '请求方法不支持',
  badJsonBody: '请求体不是合法 JSON',
  bodyTooLarge: '请求体超过上限',
  bodyAborted: '请求体读取中断',
  nameRequired: '变量名不能为空',
  jobNameRequired: '任务名称不能为空',
  commandRequired: '任务命令不能为空',
  badKind: '任务类型不合法',
  badSessionMode: '会话模式仅支持 fresh 或 pinned',
  badAgentPreset: '执行预设 ID 仅限小写字母、数字与连字符',
  badSessionModel: '模型指定不合法:provider 与 model 必须为非空文本,reasoningEffort 可省略',
  jobNotFound: '任务不存在',
  jobConflict: '任务已被其他操作修改,请关闭后重新打开编辑再保存',
  jobNotTerminated: '任务仍有在途运行未能终止,已取消删除,请稍后重试',
  runNotFound: '运行记录不存在',
  sessionUnavailable: SESSION_UNAVAILABLE_REASON,
  noFutureTrigger: 'cron 表达式没有可执行的未来触发点,请调整表达式',
  systemError: '操作失败(系统级错误,详见服务端日志)',
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 写路由守卫由装配层 route-gate.mjs 的 withRouteGate 统一承担(宿主闸门/同源/JSON),
// api 层只保留路由分发与业务语义,不重复实现第二套守卫。

// 业务错误显式状态码:乐观锁冲突 409;未携带按仓内惯例 400
function businessError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function respondError(res, error, logSystem) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && logSystem) logSystem('[cron-board] ' + String(error && error.stack || error))
  const message = isSystem ? MESSAGES.systemError : (error && error.message ? error.message : String(error))
  sendJson(res, Number.isInteger(error && error.status) ? error.status : 400, { error: message })
}

// 请求体超限:结构性业务错误(413),不是系统级错误(不收敛文案、不落服务端日志)
function payloadTooLarge() {
  const error = new Error(MESSAGES.bodyTooLarge)
  error.status = 413
  return error
}

// 客户端中途断开:请求体永远等不到 end,不收敛就会让 Promise 与 req/res 一起悬挂泄漏
function requestAborted() {
  const error = new Error(MESSAGES.bodyAborted)
  error.status = 400
  return error
}

// 请求体读取:正常路径 data/end,中断路径 error/aborted/close 三路都收敛(中间断开是本轮修复点)。
// 超限绝不 destroy(destroy 在写出响应前撕 socket,客户端只见 ECONNRESET),也不 pause(pause 让
// socket 停读,连接既不能复用也不会关闭,慢速超限体的下一请求永久悬挂);改为摘监听并 resume
// 排空剩余体(读完丢弃),请求消息走到末尾后 keep-alive 仍可承载下一请求。
function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks = []
    const onData = (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        chunks.length = 0
        finish(reject, payloadTooLarge())
        drainRest()
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'))
    const onError = (error) => finish(reject, error)
    const onAborted = () => finish(reject, requestAborted())
    // close 在正常读完(complete)后同样触发:只有请求体未读完才是客户端中途断开
    const onClose = () => {
      if (!req.complete) finish(reject, requestAborted())
    }
    // 单一收敛出口:先摘全部监听再结算,半读状态不留悬挂 Promise 与悬挂监听
    function finish(settler, value) {
      if (settled) return
      settled = true
      chunks.length = 0
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      req.off?.('aborted', onAborted)
      req.off?.('close', onClose)
      settler(value)
    }
    // 超限后转入排空:剩余体读完丢弃;此时 socket 级错误已无人关心,留空监听防未处理 error 打崩进程。
    // 必须保留一个显式消费者(data 监听):只靠响应收尾时 Node 内部的 dump 属于实现细节,
    // 半读连接在客户端继续上传时要持续前进,413 之后同连接才可复用
    function drainRest() {
      req.on('error', () => {})
      req.on('data', () => {})
      req.resume?.()
    }
    // 已声明的长度即超限:不必先收满再计数
    const declared = Number(req.headers && req.headers['content-length'])
    if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) {
      finish(reject, payloadTooLarge())
      drainRest()
      return
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
  })
}

async function readJsonBody(req) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    // 超限已在读取层定型状态码,原样上抛;其余解析失败一律归非法 JSON
    if (Number.isInteger(error && error.status)) throw error
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

// 导入文本解析:每行 NAME=value 或 NAME=value #备注;空行跳过,无 = 记非法。
// value/备注在含换行、首尾空白、` #` 或首引号时由导出侧加双引号并转义,
// 解析侧按引号还原,保证多值与值内 ` #` 不丢失。
function decodeQuoted(text) {
  if (!text.startsWith('"')) return null
  let value = ''
  let index = 1
  for (; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      const next = text[++index]
      if (next === undefined) return null
      if (next === 'n') value += '\n'
      else if (next === 'r') value += '\r'
      else if (next === 't') value += '\t'
      else value += next
      continue
    }
    if (char === '"') return { value, rest: text.slice(index + 1) }
    value += char
  }
  return null
}

// 多值标志:单行多值(值里没有换行)在文本上无法与普通单行值区分,只能由导出侧显式标注,
// 否则覆盖导入后值不变而 multi 丢成 false,UI 退化为单行输入
const MULTI_FLAG = '[multi]'

function encodeEnvText(text, { alwaysQuote = false } = {}) {
  const value = String(text)
  const needsQuote = alwaysQuote
    || value !== value.trim()
    || value.includes('\n')
    || value.includes('\r')
    || value.includes(' #')
    || value.startsWith('"')
  if (!needsQuote) return value
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'
}

function encodeEnvRemark(remark) {
  return encodeEnvText(remark)
}

// 导出行:multi 行值强制加引号并把标志放在引号之后(备注仍以 # 开头),
// 解析侧只在引号值之后认标志 —— 不加标志的文本一律按普通值导入(旧导出文本兼容)
function encodeEnvLine(row) {
  const multi = row.multi === true
  return row.name + '=' + encodeEnvText(row.value, { alwaysQuote: multi })
    + (multi ? ' ' + MULTI_FLAG : '')
    + (row.remarks ? ' #' + encodeEnvRemark(row.remarks) : '')
}

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
    let value
    let trailing = ''
    let flaggedMulti = false
    if (rest.startsWith('"')) {
      const decoded = decodeQuoted(rest)
      if (decoded === null) {
        invalid++
        continue
      }
      value = decoded.value
      trailing = decoded.rest
      // 标志只认引号值之后的显式 [multi]:无引号值里出现同名字样属于值本身
      const marked = trailing.trimStart()
      if (marked.startsWith(MULTI_FLAG)) {
        flaggedMulti = true
        trailing = marked.slice(MULTI_FLAG.length)
      }
    } else {
      const hash = rest.indexOf(' #')
      if (hash >= 0) {
        value = rest.slice(0, hash)
        trailing = rest.slice(hash)
      } else {
        value = rest
      }
    }
    let remarks = ''
    const remarkText = trailing.trimStart()
    if (remarkText.startsWith('#')) {
      const rawRemark = remarkText.slice(1).trimStart()
      if (rawRemark.startsWith('"')) {
        const decoded = decodeQuoted(rawRemark)
        if (decoded === null) {
          invalid++
          continue
        }
        remarks = decoded.value
      } else {
        remarks = rawRemark.trim()
      }
    }
    // 多值 = 显式标志或多行值(旧导出文本只有后者可用)
    rows.push({ name, value, remarks, multi: flaggedMulti || value.includes('\n') })
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

function normalizeJob(body, { requireFutureTrigger = true } = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') throw new Error(MESSAGES.jobNameRequired)
  const kind = body.kind === 'session' ? 'session' : 'shell'
  if (body.kind !== 'shell' && body.kind !== 'session') throw new Error(MESSAGES.badKind)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (kind === 'shell' && command === '') throw new Error(MESSAGES.commandRequired)
  const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : ''
  assertValidSchedule(schedule)
  // 无未来触发点(如 2 月 30 日)的表达式合法但永不执行:新建或改期时拒绝;
  // 旧数据里的此类表达式仍允许停用/改名等维护性 PATCH,避免任务彻底不可操作
  const nextAt = nextRunAtOf(schedule)
  if (requireFutureTrigger && nextAt === null) throw new Error(MESSAGES.noFutureTrigger)
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
  // 任务级并发上限:合法正整数才落库,缺省走全局闸门(executor min 规则);
  // 显式 null = 清空该键(mutate 按 undefined 删键),表达「不限并发」
  if (body.concurrency === null) normalized.concurrency = undefined
  else if (Number.isInteger(body.concurrency) && body.concurrency > 0) normalized.concurrency = body.concurrency
  // nextRunAt:调用方可显式指定(导入任务保留原状态 / 测试注入到期时刻),缺省按 schedule 计算
  normalized.nextRunAt = typeof body.nextRunAt === 'number' && Number.isFinite(body.nextRunAt)
    ? body.nextRunAt
    : nextAt
  return normalized
}

// 数据集合损坏时在只读响应中显式告警:空表不得伪装成「没有数据」
function storageWarning(store) {
  const broken = []
  if (store.envs.broken) broken.push('envs')
  if (store.jobs.broken) broken.push('jobs')
  if (store.runs.broken) broken.push('runs')
  if (broken.length === 0) return {}
  return {
    broken,
    warning: '数据文件损坏已备份为 .bak,对应集合写入已暂停;请检查数据目录后重启',
  }
}

export function createApi({ store, logger, executor, scheduler, periodic, reportSessionMissing, readSidebarTab, readShowAutomationTasks, updateUiSettings, getAgentPresets, getSessionController, logSystem, notifyChange }) {
  // 界面偏好统一读取面:两项均为客户端展示开关,缺失服务时按缺省关闭
  const uiPreferences = () => ({
    sidebarTab: readSidebarTab ? readSidebarTab() === true : false,
    showAutomationTasks: readShowAutomationTasks ? readShowAutomationTasks() === true : false,
  })

  // 会话通道就绪按请求时刻判定:服务由宿主异步挂载,晚到即恢复,不做一次性定格
  const sessionAvailable = () => Boolean(typeof getSessionController === 'function' && getSessionController())
  const rejectSessionUnavailable = (res) => {
    if (typeof reportSessionMissing === 'function') reportSessionMissing()
    sendJson(res, 400, { error: MESSAGES.sessionUnavailable })
  }
  const routes = [
    {
      method: 'GET',
      segments: ['envs'],
      handler: async ({ res }) => {
        const items = store.envs.list().map((row) => ({ ...row, value: maskValue(row.value) }))
        sendJson(res, 200, { items, ...storageWarning(store) })
      },
    },
    {
      // 固定段 export 须先于 :id 捕获注册,否则被当作 id 吞掉
      method: 'GET',
      segments: ['envs', 'export'],
      handler: async ({ res, url }) => {
        const includeDisabled = url.searchParams.get('includeDisabled') === '1'
        const rows = store.envs.list().filter((row) => includeDisabled || row.enabled)
        const text = rows.map(encodeEnvLine).join('\n') + (rows.length > 0 ? '\n' : '')
        sendJson(res, 200, { text, ...storageWarning(store) })
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
        // 原子导入:清空与批量追加同一次 mutate 落盘(N 行原先 2N 次写,半途失败无法回滚)
        await store.envs.importRows(rows, { overwrite: mode === 'overwrite' })
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
          session: { ready: sessionAvailable() },
          // 宿主进程时区偏移小时数:无后缀任务的展示时区(调度与展示同源,与浏览器无关)
          serverTzOffset: -new Date().getTimezoneOffset() / 60,
          ui: uiPreferences(),
        })
      },
    },
    {
      // 界面偏好写入(sidebarTab / showAutomationTasks):settings.update 服务端持久化,即时生效
      method: 'POST',
      segments: ['ui-settings'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const patch = {}
        if (typeof body.sidebarTab === 'boolean') patch.sidebarTab = body.sidebarTab
        if (typeof body.showAutomationTasks === 'boolean') patch.showAutomationTasks = body.showAutomationTasks
        if (!Object.keys(patch).length) return sendJson(res, 400, { error: '无有效字段' })
        if (typeof updateUiSettings !== 'function') return sendJson(res, 200, { ok: false, error: '设置服务不可用' })
        const persisted = await updateUiSettings(patch)
        sendJson(res, 200, { ok: persisted, ui: uiPreferences() })
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
        sendJson(res, 200, { items, ...storageWarning(store) })
      },
    },
    {
      method: 'POST',
      segments: ['jobs'],
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        const fields = normalizeJob(body)
        if (fields.kind === 'session' && !sessionAvailable()) return rejectSessionUnavailable(res)
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
        // 全量归一用于校验(未提交字段取服务端当前值),但只把显式提交的配置字段写入:
        // 旧快照不得回滚运行期已推进的 nextRunAt / 会话绑定等字段
        const fields = normalizeJob({ ...existing, ...body }, { requireFutureTrigger: body.schedule !== undefined })
        // 只拦「脚本任务改成会话任务」这一引入动作:停用/改名/改期等既有会话任务维护
        // 在服务缺失期照旧可用(否则会把停用开关一起打断)
        if (fields.kind === 'session' && existing.kind !== 'session' && !sessionAvailable()) return rejectSessionUnavailable(res)
        const patch = {}
        for (const key of ['name', 'kind', 'command', 'prompt', 'workdir', 'schedule', 'enabled', 'timeoutMs', 'runOnce', 'concurrency']) {
          if (body[key] !== undefined) patch[key] = fields[key]
        }
        if (body.session !== undefined || body.kind !== undefined) patch.session = fields.session
        // 改期才重算触发点;未携带 schedule 的局部更新(改名/开关/并发)不得推进 nextRunAt,
        // 否则临近的待触发运行被推到下一周期
        if (body.nextRunAt !== undefined) patch.nextRunAt = fields.nextRunAt
        else if (body.schedule !== undefined) patch.nextRunAt = nextRunAtOf(fields.schedule)
        // 乐观锁 CAS:比较与写入在 store 同一临界区,并发 PATCH 只有首个基线命中
        const outcome = await store.jobs.updateIf(params.id, body.updatedAt, patch)
        if (!outcome.ok) {
          if (outcome.reason === 'missing') throw new Error(MESSAGES.jobNotFound)
          throw businessError(409, MESSAGES.jobConflict)
        }
        sendJson(res, 200, outcome.row)
      },
    },
    {
      method: 'DELETE',
      segments: ['jobs', ':id'],
      handler: async ({ res, params }) => {
        // 删除先清执行面:该任务的排队记录 cancelled、在途运行杀树/终态;
        // 未能在 deadline 内终止时取消删除并显式回报,不能让任务消失后仍有运行投递/写日志
        const stopped = await executor.stopJob(params.id)
        if (!stopped.settled) {
          executor.releaseJob(params.id)
          throw businessError(409, MESSAGES.jobNotTerminated)
        }
        // 持久化删除失败必须解除「删除中」拒绝态:任务仍在(或仍在内存),闩着不放会让
        // 该任务永久拒绝运行,每次调度 tick 再补一条 fail 记录,除重启无解。
        // 删除一旦成功(任务行已落盘移除)日志目录清理就只是收尾:失败留痕但不翻案成败
        try {
          const removed = await store.jobs.remove(params.id)
          if (!removed) throw new Error(MESSAGES.jobNotFound)
        } catch (error) {
          executor.releaseJob(params.id)
          throw error
        }
        try {
          await logger.removeJob(params.id)
        } catch (error) {
          if (typeof logSystem === 'function') logSystem('[cron-board] 任务日志目录清理失败 job=' + params.id + ' 错误=' + String(error && error.message ? error.message : error))
        }
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
        sendJson(res, 200, { items: rows, ...storageWarning(store) })
      },
    },
    {
      method: 'GET',
      segments: ['runs', ':runId', 'log'],
      handler: async ({ res, params, url }) => {
        const record = store.runs.get(params.runId)
        if (!record) throw new Error(MESSAGES.runNotFound)
        // 默认只回尾部窗口:日志文件无上限增长,全文读取会同时压内存与 DOM;
        // 显式 tail=all 才读全文(导出用),tail=<行数> 覆盖窗口
        const tailParam = url.searchParams.get('tail')
        const tailLines = tailParam === 'all' ? undefined : Math.max(1, Number(tailParam) || DEFAULT_LOG_TAIL_LINES)
        const outcome = tailLines === undefined
          ? { text: await logger.read(record.jobId, params.runId), truncated: false }
          : await logger.readTail(record.jobId, params.runId, tailLines)
        sendJson(res, 200, { text: outcome.text, truncated: outcome.truncated, tailLines: tailLines === undefined ? null : tailLines })
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
