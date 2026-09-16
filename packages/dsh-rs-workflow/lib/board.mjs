// board — /api/rsww/* 路由薄分发(设置子域):数据权威态在 settings,路由无业务状态
// 运行时路由(runs/run/control/resume-from/run-remove)随 v4 运行时移除,仅保留设置页所需
import JSON5 from 'json5'
import { join } from 'node:path'
import { validateTemplate } from './template-v4.mjs'
import { SPEC_TEXT } from './spec.mjs'
import { builtinTemplates } from './builtin-templates.mjs'
import { NAMESPACE, normalizeConfig, BUDGET_KEYS, SLOT_KEYS } from './settings-schema.mjs'

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

function rejectNonJson(req, res) {
  const contentType = req.headers ? String(req.headers['content-type'] || '') : ''
  if (contentType.includes('application/json')) return false
  sendJson(res, 400, { error: 'content-type 须为 application/json' })
  return true
}

function guardedRoute(handler) {
  return async (req, res) => {
    try {
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
      sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
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

function readJsonBody(req) {
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

// ── settings 模板读写(与 v3 合并/防固化语义一致) ──────────────────────────
function readTemplates(ctx) {
  try {
    const settings = ctx.get('settings')
    const value = settings ? settings.get(NAMESPACE) : undefined
    if (value && Array.isArray(value.templates)) return mergeBuiltin(value.templates)
  } catch { /* 设置服务缺失/损坏:仅内置表 */ }
  return builtinTemplates()
}

function mergeBuiltin(userTemplates) {
  const byId = new Map(userTemplates.map((t) => [t.id, t]))
  const merged = [...userTemplates]
  for (const builtin of builtinTemplates()) {
    if (byId.has(builtin.id)) continue
    merged.push(builtin)
  }
  return merged
}

function rawTemplates(ctx) {
  try {
    const settings = ctx.get('settings')
    const value = settings ? settings.get(NAMESPACE) : undefined
    return value && Array.isArray(value.templates) ? value.templates : []
  } catch { return [] }
}

async function writeTemplates(ctx, templates) {
  const settings = ctx.get('settings')
  if (!settings) throw new Error('设置服务不可用,无法保存模板')
  const builtins = builtinTemplates()
  const userEntries = templates.filter((t) => {
    const builtin = builtins.find((b) => b.id === t.id)
    return !(builtin && t.enabled === builtin.enabled && t.label === builtin.label && t.description === builtin.description && t.json5 === builtin.json5)
  })
  await settings.update(NAMESPACE, { templates: userEntries })
}

async function removeTemplateById(ctx, id) {
  const raw = rawTemplates(ctx)
  const next = raw.filter((t) => t.id !== id)
  const builtin = builtinTemplates().find((t) => t.id === id)
  if (builtin) {
    next.push({ ...builtin, enabled: false })
  } else if (next.length === raw.length) {
    return { ok: false, error: '模板不存在: ' + id }
  }
  await writeTemplates(ctx, next)
  return { ok: true, templates: mergeBuiltin(next) }
}

function parseTemplateEntry(id, body) {
  const json5 = typeof body.json5 === 'string' ? body.json5 : ''
  let parsed
  try {
    parsed = JSON5.parse(json5)
  } catch (error) {
    const err = new Error('JSON5 解析失败:' + (error?.message ?? error))
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
  return { parsed, json5 }
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

export function registerBoardRoutes(ctx) {
  ctx.inject(['webServer'], (wctx) => {
    const route = (path, handler, name) => wctx.effect(() => wctx.webServer.register({ kind: 'exact', path, handler }), name)
    route('/api/rsww/templates', guardedRoute(async (req, res) => {
      const templates = readTemplates(ctx).map((t) => ({ ...t, builtin: !!builtinTemplates().find((b) => b.id === t.id) }))
      sendJson(res, 200, { templates })
    }), 'rsww templates route')
    route('/api/rsww/template', guardedRoute(async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('id') || ''
      const entry = readTemplates(ctx).find((t) => t.id === id)
      if (!entry) throw new Error('模板不存在:' + id)
      let parsed
      try {
        parsed = JSON5.parse(entry.json5)
      } catch (e) {
        throw new Error('模板文本解析失败:' + e.message)
      }
      sendJson(res, 200, { entry, parsed })
    }), 'rsww template detail route')
    route('/api/rsww/spec', guardedRoute(async (req, res) => {
      sendJson(res, 200, { spec: SPEC_TEXT })
    }), 'rsww spec route')
    route('/api/rsww/template-save', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const { parsed, json5 } = parseTemplateEntry(id, body)
      if (body.dryRun === true) {
        sendJson(res, 200, { ok: true, dryRun: true })
        return
      }
      const templates = rawTemplates(ctx).filter((t) => t.id !== id)
      templates.push({
        id,
        label: typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : parsed.label || id,
        description: typeof body.description === 'string' && body.description.trim() !== '' ? body.description.trim() : parsed.description || '',
        enabled: body.enabled !== false,
        json5,
      })
      await writeTemplates(ctx, templates)
      sendJson(res, 200, { ok: true })
    }), 'rsww template-save route')
    route('/api/rsww/template-remove', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req))
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const outcome = await removeTemplateById(ctx, id)
      if (!outcome.ok) throw new Error(outcome.error)
      sendJson(res, 200, { ok: true })
    }), 'rsww template-remove route')
    route('/api/rsww/config', guardedRoute(async (req, res) => {
      const settings = ctx.get('settings')
      const value = settings ? settings.get(NAMESPACE) : undefined
      sendJson(res, 200, { config: normalizeConfig(value) })
    }), 'rsww config route')
    route('/api/rsww/config-save', guardedRoute.post(async (req, res) => {
      const body = JSON.parse(await readJsonBody(req))
      const patch = configSavePatch(body ?? {})
      const settings = ctx.get('settings')
      if (!settings) throw new Error('设置服务不可用')
      await settings.update(NAMESPACE, patch)
      sendJson(res, 200, { ok: true })
    }), 'rsww config-save route')
  })
}
