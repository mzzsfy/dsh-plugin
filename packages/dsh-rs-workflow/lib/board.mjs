// board — /api/rsww/* 路由薄分发:数据权威态在 store 单例/自有文件存储(v5/{templates,config}.json)/driver 控制队列单例,路由无业务状态
// 运行时路由 v5 恢复:runs/run/control(approve|reject 增 by/reason)/resume-from(种子续跑,不拉段)/run-remove/release/unrelease/released
// 规划受理不经 HTTP:rs_workflow_start 是 orchestrator 工具行(见 feat/orchestrator.md)
import { reportStore, ACTIVE_STATES } from './store.mjs'
import { registry, post, initiatorOf, resumerOf } from './driver/control.mjs'
import { validateTemplate, validateTemplateSet } from './template.mjs'
import { releaseFlowTemplate, unreleaseFlowTemplate, releasedTemplateIds } from './release.mjs'
import { SPEC_TEXT } from './spec.mjs'
import { normalizeConfig, BUDGET_KEYS, SLOT_KEYS } from './settings-schema.mjs'
import { loadJson, saveJson } from './storage.mjs'

const BODY_MAX_BYTES = 256 * 1024

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers.host
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

// Host fence:插件 exact 路由早于宿主 /api 前缀路由命中(webserver exact 优先),
// 宿主的 DNS-rebinding 防线拦不到本组路由,须自守——Host 须为回环名或本机 IP 字面量
const TRUSTED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function rejectReboundHost(req, res) {
  const authority = req.headers ? String(req.headers.host || '') : ''
  if (authority === '') return false
  const at = authority.lastIndexOf(':')
  const hostname = at > authority.lastIndexOf(']') ? authority.slice(0, at) : authority
  if (TRUSTED_HOSTNAMES.has(hostname.toLowerCase())) return false
  sendJson(res, 403, { error: 'Host 不受信任(疑似 DNS rebinding)' })
  return true
}

function rejectNonJson(req, res) {
  const contentType = req.headers ? String(req.headers['content-type'] || '') : ''
  if (contentType.includes('application/json')) return false
  sendJson(res, 400, { error: 'content-type 须为 application/json' })
  return true
}

function guardedRoute(handler) {
  return async (req, res) => {
    try {
      if (rejectReboundHost(req, res)) return
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (req.method === 'POST') {
        if (rejectCrossOrigin(req, res)) return
        if (rejectNonJson(req, res)) return
      }
      await handler(req, res)
    } catch (error) {
      // errors 数组(逐条 target:message)随响应透传,GUI 编辑器据此逐条定位
      const body = { error: error && error.message ? error.message : String(error) }
      if (Array.isArray(error?.errors)) body.errors = error.errors
      sendJson(res, 400, body)
    }
  }
}

// POST-only 变体供无读面的写路由使用:GET 放行会让跨站 <img src> 无守卫驱动改写
guardedRoute.post = (handler) => async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  return guardedRoute(handler)(req, res)
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let over = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        // 只暂停流入并标记超限,不销毁 socket:连接毁了 guardedRoute 的 400 就送不出去
        over = true
        req.pause()
        reject(new Error('请求体超过上限'))
        return
      }
      if (!over) chunks.push(chunk)
    })
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', () => { if (!over) reject(new Error('请求体读取失败')) })
    // 超限后 end 不再流到(已暂停):挂 res 收尾销毁,防 socket 悬挂
    res.on('finish', () => req.destroy())
  })
}

// ── 模板读写(自有文件存储) ──────────────────────────────────────────────────
function rawTemplates() {
  return loadJson('templates.json', [])
}

function readTemplates() {
  return rawTemplates()
}

function writeTemplates(templates) {
  saveJson('templates.json', templates)
}

function removeTemplateById(id) {
  const raw = rawTemplates()
  const next = raw.filter((t) => t.id !== id)
  if (next.length === raw.length) return { ok: false, error: '模板不存在: ' + id }
  writeTemplates(next)
  // 撤下释放物:删除模板即移除对应释放目录(外来目录返回 foreign 不动)
  const outcome = unreleaseFlowTemplate(id)
  return { ok: true, outcome }
}

function parseTemplateEntry(id, body) {  const json = typeof body.json === 'string' ? body.json : ''
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    const err = new Error('模板 JSON 解析失败:' + (error?.message ?? error))
    err.errors = [{ target: 'json', message: String(error?.message ?? error) }]
    throw err
  }
  const errors = validateTemplate(parsed)
  if (errors.length > 0) {
    const err = new Error('流程模板校验失败:' + errors.length + ' 条')
    err.errors = errors
    throw err
  }
  if (parsed && typeof parsed.id === 'string' && parsed.id !== id) throw new Error(`id 不一致: 模板 "${id}" vs 定义 "${parsed.id}"`)
  return { parsed, json }
}

function configSavePatch(body) {
  const patch = {}
  const problems = []
  if (body.slots !== undefined) {
    if (typeof body.slots !== 'object' || body.slots === null || Array.isArray(body.slots)) {
      problems.push('slots 须为对象')
    } else {
      const slots = {}
      for (const [key, value] of Object.entries(body.slots)) {
        if (!SLOT_KEYS.includes(key)) {
          problems.push(`未知槽位键:${key}`)
          continue
        }
        if (typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
          slots[key] = value
        } else {
          problems.push(`槽位 ${key} 须为 string 或 string 数组`)
        }
      }
      patch.slots = slots
    }
  }
  if (body.budgets !== undefined) {
    if (typeof body.budgets !== 'object' || body.budgets === null || Array.isArray(body.budgets)) {
      problems.push('budgets 须为对象')
    } else {
      const budgets = {}
      for (const [key, value] of Object.entries(body.budgets)) {
        if (!BUDGET_KEYS.includes(key)) {
          problems.push(`未知预算键:${key}`)
          continue
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          problems.push(`预算 ${key} 须为整数`)
          continue
        }
        budgets[key] = Math.max(1, Math.min(10, value))
      }
      patch.budgets = budgets
    }
  }
  if (problems.length > 0) {
    const err = new Error(problems.join(';'))
    err.errors = problems
    throw err
  }
  return patch
}

// ── 运行时控制(v5) ─────────────────────────────────────────────────────────
const CONTROL_KINDS = ['message', 'cancel', 'pause', 'resume', 'approve', 'reject']
const VERDICT_KINDS = new Set(['approve', 'reject'])
const CONTROL_BY = new Set(['user', 'main-agent'])

// 活跃判定:注册表在册或记录未终态(waiting_approval 属活跃)
const isRunActive = (runId, record) => registry.drivers.has(runId) || (record && ACTIVE_STATES.has(record.status))

export function handleControl(body) {
  const runId = typeof body.runId === 'string' ? body.runId : ''
  const kind = typeof body.kind === 'string' ? body.kind : ''
  const store = reportStore()
  if (!CONTROL_KINDS.includes(kind)) throw new Error('kind 须为 ' + CONTROL_KINDS.join('|'))
  if (kind === 'message') {
    if (typeof body.text !== 'string' || body.text.trim() === '') throw new Error('message 须携带非空 text')
    const accepted = post(runId, { kind: 'message', text: body.text, inject: body.inject === true })
    return { ok: accepted }
  }
  if (VERDICT_KINDS.has(kind)) {
    // 外部裁决通道:by 必填(user|main-agent),代审(main-agent)须给出非空 reason
    if (!CONTROL_BY.has(body.by)) throw new Error('裁决须携带 by(user|main-agent)')
    if (body.by === 'main-agent' && (typeof body.reason !== 'string' || body.reason.trim() === '')) throw new Error('代审(main-agent)须携带非空 reason')
    const accepted = post(runId, { kind, by: body.by, reason: typeof body.reason === 'string' ? body.reason : '' })
    if (!accepted) return { ok: false }
    // 裁决翻状态不推进:无活跃段时经会话挂靠拉下一段(页签先裁场景主循环无通知,须代为唤醒)
    const record = store.get(runId)
    const resumed = resumerOf(record?.sessionId)?.(runId) === true
    return { ok: true, resumed }
  }
  const driver = registry.drivers.get(runId)
  if (!driver) return { ok: false }
  if (kind === 'cancel') {
    store.step({ runId, event: 'control', body: { kind: 'cancel', by: 'user' } })
    driver.cancel()
  }
  if (kind === 'pause') {
    store.step({ runId, event: 'control', body: { kind: 'pause', by: 'user' } })
    driver.pause()
  }
  if (kind === 'resume') {
    // 仅 paused 受理;其余状态回状态不符(先到先得口径)
    const accepted = driver.tabResume()
    if (!accepted) return { ok: false, error: '状态不符:resume 仅受理 paused' }
  }
  return { ok: true }
}

export function registerBoardRoutes(ctx) {
  const store = reportStore()
  ctx.inject(['webServer'], (wctx) => {
    const route = (path, handler, name) => wctx.effect(() => wctx.webServer.register({ kind: 'exact', path, handler }), name)
    route('/api/rsww/runs', guardedRoute(async (req, res) => {
      sendJson(res, 200, { runs: store.list() })
    }), 'rsww runs route')
    route('/api/rsww/run', guardedRoute(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const runId = url.searchParams.get('id') || ''
      const run = store.get(runId)
      if (!run) throw new Error('运行记录不存在:' + runId)
      sendJson(res, 200, run)
    }), 'rsww run detail route')
    route('/api/rsww/control', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      sendJson(res, 200, handleControl(body ?? {}))
    }), 'rsww control route')
    route('/api/rsww/resume-from', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const runId = typeof body.runId === 'string' ? body.runId : ''
      const record = store.get(runId)
      if (!record) throw new Error('运行记录不存在:' + runId)
      if (isRunActive(runId, record)) throw new Error('运行进行中,不可续跑')
      // 挂靠守卫:新 run 由原会话的推进器(orchestrator 行注册的 initiator)重建,engine/parent 闭包在其域内
      const start = initiatorOf(record.sessionId)
      if (!start) throw new Error('请先打开对应模式会话再重跑')
      const fromStepId = typeof body.fromStepId === 'string' && body.fromStepId !== '' ? body.fromStepId : undefined
      // 非法 fromStepId 显式报错(不静默退化为纯断点续跑)
      if (fromStepId !== undefined && record.plan?.steps?.some((p) => p.ref === fromStepId) !== true) {
        throw new Error('fromStepId 不在剧本中:' + fromStepId)
      }
      // inputs 须为字符串值对象:数组/嵌套值在种子展开中失真
      let inputs
      if (body.inputs !== undefined && body.inputs !== null) {
        if (typeof body.inputs !== 'object' || Array.isArray(body.inputs) || Object.values(body.inputs).some((v) => typeof v !== 'string')) {
          throw new Error('inputs 必须为字符串值对象(键→字符串)')
        }
        inputs = body.inputs
      }
      const outcome = start(record, fromStepId, inputs)
      if (!outcome.ok) throw new Error(outcome.error)
      // 纠偏消息不跨 run:旧 run 受理未消费的纠偏不带入种子(controls 属旧 run 审计)
      sendJson(res, 200, { ok: true, runId: outcome.runId, hint: '旧 run 未消费的纠偏消息不带入新 run' })
    }), 'rsww resume-from route')
    route('/api/rsww/run-remove', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const runId = typeof body.runId === 'string' ? body.runId : ''
      const record = store.has(runId) ? store.get(runId) : undefined
      if (record && isRunActive(runId, record)) throw new Error('运行进行中,不可删除')
      store.remove(runId)
      sendJson(res, 200, { ok: true })
    }), 'rsww run-remove route')
    route('/api/rsww/templates', guardedRoute(async (req, res) => {
      sendJson(res, 200, { templates: readTemplates() })
    }), 'rsww templates route')
    route('/api/rsww/template', guardedRoute(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('id') || ''
      const entry = readTemplates().find((t) => t.id === id)
      if (!entry) throw new Error('模板不存在:' + id)
      let parsed
      try {
        parsed = JSON.parse(entry.json)
      } catch (e) {
        throw new Error('模板文本解析失败:' + e.message)
      }
      sendJson(res, 200, { entry, parsed })
    }), 'rsww template detail route')
    route('/api/rsww/released', guardedRoute(async (req, res) => {
      sendJson(res, 200, { ids: releasedTemplateIds() })
    }), 'rsww released route')
    route('/api/rsww/spec', guardedRoute(async (req, res) => {
      sendJson(res, 200, { spec: SPEC_TEXT })
    }), 'rsww spec route')
    route('/api/rsww/template-save', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const { parsed, json } = parseTemplateEntry(id, body)
      if (body.dryRun === true) {
        sendJson(res, 200, { ok: true, dryRun: true })
        return
      }
      const templates = rawTemplates().filter((t) => t.id !== id)
      templates.push({
        id,
        label: typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : parsed.label || id,
        description: typeof body.description === 'string' && body.description.trim() !== '' ? body.description.trim() : parsed.description || '',
        enabled: body.enabled !== false,
        json,
      })
      writeTemplates(templates)
      sendJson(res, 200, { ok: true })
    }), 'rsww template-save route')
    route('/api/rsww/template-remove', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const outcome = removeTemplateById(id)
      if (!outcome.ok) throw new Error(outcome.error)
      sendJson(res, 200, { ok: true })
    }), 'rsww template-remove route')
    route('/api/rsww/release', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const entries = readTemplates()
      const entry = entries.find((t) => t.id === id)
      if (!entry) throw new Error('模板不存在:' + id)
      if (entry.enabled === false) throw new Error('模板已禁用,不可释放:' + id)
      // 跨流程校验(spec §9):flow 引用存在性+环/深度在释放权威点执行
      const parsedSet = entries.map((t) => {
        try { return JSON.parse(t.json) } catch { return null }
      }).filter((t) => t !== null)
      const setErrors = validateTemplateSet(parsedSet).filter((e) => e.target === 'top:id' && e.message.startsWith(id + ' '))
      if (setErrors.length > 0) throw new Error('模板集合校验失败:' + setErrors.map((e) => e.message).join(';'))
      const outcome = releaseFlowTemplate(entry)
      sendJson(res, 200, { ok: true, outcome })
    }), 'rsww release route')
    route('/api/rsww/unrelease', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const outcome = unreleaseFlowTemplate(id)
      sendJson(res, 200, { ok: true, outcome })
    }), 'rsww unrelease route')
    route('/api/rsww/config', guardedRoute(async (req, res) => {
      sendJson(res, 200, { config: normalizeConfig(loadJson('config.json', undefined)) })
    }), 'rsww config route')
    route('/api/rsww/config-save', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req, res))
      const patch = configSavePatch(body ?? {})
      const current = normalizeConfig(loadJson('config.json', undefined))
      // config.json 权威节集 = slots/budgets(data-design);templates 属 templates.json 独立存储
      const { templates: _drop, ...persistable } = current
      saveJson('config.json', { ...persistable, ...patch })
      sendJson(res, 200, { ok: true })
    }), 'rsww config-save route')
  })
}
