// board BDD:模拟 req/res 验证守卫与设置子域路由语义(数据面 mock settings)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerBoardRoutes } from '../lib/board.mjs'

// board 不再依赖运行时单例;保留临时目录隔离惯例
process.env.DSH_RS_WORKFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'rsww-board-store-'))

const mockRes = () => {
  const res = {
    headers: null, status: 0, body: null, ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.ended = true
      this.body = payload ? JSON.parse(payload) : null
    },
  }
  return res
}

const mockReq = ({ method = 'GET', url = '/', headers = {}, body = null } = {}) => {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      listeners[event] = fn
      return req
    },
    destroy() {
      req.destroyed = true
    },
    destroyed: false,
  }
  req.emit = () => {
    if (body !== null) {
      listeners.data?.(Buffer.from(JSON.stringify(body)))
    }
    listeners.end?.()
  }
  return req
}

const harness = ({ settingsValue = {} } = {}) => {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'settings' ? { get: () => settingsValue, update: async (ns, patch) => Object.assign(settingsValue, patch) } : undefined),
    inject: (names, fn) => {
      fn({
        effect: (reg) => reg(),
        webServer: { register: ({ path, handler }) => routes.set(path, handler) },
      })
    },
  }
  registerBoardRoutes(ctx)
  const call = async (path, reqOpts) => {
    const handler = routes.get(path)
    if (!handler) throw new Error('路由未注册: ' + path)
    const req = mockReq(reqOpts)
    const res = mockRes()
    const p = handler(req, res)
    req.emit()
    await p
    return res
  }
  return { routes, call, ctx }
}

test('Given 设置子域 8 路由声明 When 激活 board Then 全部注册', () => {
  const h = harness()
  const expect = ['/api/rsww/templates', '/api/rsww/template', '/api/rsww/spec', '/api/rsww/template-save', '/api/rsww/template-remove', '/api/rsww/config', '/api/rsww/config-save']
  for (const p of expect) assert.ok(h.routes.has(p), p)
})

test('Given 既有模板 id When GET template Then 返回 entry+JSON5 解析结果;Given 不存在 id Then 400 错误载荷', async () => {
  const tplJson5 = JSON.stringify({ id: 'user-1', label: 'u', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] })
  const settingsValue = { templates: [{ id: 'user-1', label: 'u', description: '', enabled: true, json5: tplJson5 }] }
  const h = harness({ settingsValue })
  const ok = await h.call('/api/rsww/template', { method: 'GET', url: '/api/rsww/template?id=user-1' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.entry.id, 'user-1')
  assert.equal(ok.body.parsed.id, 'user-1')
  assert.ok(Array.isArray(ok.body.parsed.steps))
  const miss = await h.call('/api/rsww/template', { method: 'GET', url: '/api/rsww/template?id=nope' })
  assert.equal(miss.status, 400)
  assert.ok(miss.body.error)
})

test('Given PUT 方法 When 调 templates Then 405;Given 跨源 POST template-save When 异源 Origin Then 403;非 JSON content-type Then 400', async () => {
  const h = harness()
  const r1 = await h.call('/api/rsww/templates', { method: 'PUT' })
  assert.equal(r1.status, 405)
  const r2 = await h.call('/api/rsww/template-save', { method: 'POST', headers: { origin: 'http://evil.example' }, body: { id: 'x', json5: '{}' } })
  assert.equal(r2.status, 403)
  assert.ok(r2.body.error)
  const r3 = await h.call('/api/rsww/template-save', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { id: 'x', json5: '{}' } })
  assert.equal(r3.status, 400)
})

test('Given config-save budgets 越界 When 调用 Then clamp 至 10;错型 Then 400', async () => {
  const settingsValue = {}
  const h = harness({ settingsValue })
  const r1 = await h.call('/api/rsww/config-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { budgets: { maxStepFail: 99 } } })
  assert.equal(r1.status, 200)
  assert.equal(settingsValue.budgets.maxStepFail, 10)
  const r2 = await h.call('/api/rsww/config-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { budgets: { maxStepFail: 'fast' } } })
  assert.equal(r2.status, 400)
  const r3 = await h.call('/api/rsww/config-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { slots: { ghost: 'x' } } })
  assert.equal(r3.status, 400)
})

test('Given template-save 携带未知步骤字段 When 调用 Then 400 且 errors 逐条', async () => {
  const settingsValue = {}
  const h = harness({ settingsValue })
  const tpl = { id: 'x', label: 'x', steps: [{ id: 'a', unknownField: 1, prompt: 'p', outputs: { o: 'o' } }] }
  const r = await h.call('/api/rsww/template-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 'x', json5: JSON.stringify(tpl) } })
  assert.equal(r.status, 400)
  assert.equal(settingsValue.templates, undefined)
})

test('Given dryRun When template-save Then 仅校验返回 ok 不落盘', async () => {
  const settingsValue = {}
  const h = harness({ settingsValue })
  const tpl = { id: 'x', label: 'x', steps: [{ id: 'a', prompt: 'p', outputs: { o: 'o' } }] }
  const r = await h.call('/api/rsww/template-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 'x', json5: JSON.stringify(tpl), dryRun: true } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, dryRun: true })
  assert.equal(settingsValue.templates, undefined)
})

test('Given GET spec/config/templates When 调用 Then 载荷形态正确', async () => {
  const h = harness()
  const r1 = await h.call('/api/rsww/spec')
  assert.equal(r1.status, 200)
  assert.ok(r1.body.spec.includes('type: "approve"'))
  assert.equal(r1.body.spec.includes('教学重问'), false)
  const r3 = await h.call('/api/rsww/config')
  assert.ok(r3.body.config.slots)
  const r4 = await h.call('/api/rsww/templates')
  assert.ok(Array.isArray(r4.body.templates))
})

test('Given 用户模板 When template-remove Then 物理删除;Given 内置语义 id 不在用户表 Then 400', async () => {
  const tplJson5 = JSON.stringify({ id: 'user-1', label: 'u', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] })
  const settingsValue = { templates: [{ id: 'user-1', label: 'u', description: '', enabled: true, json5: tplJson5 }] }
  const h = harness({ settingsValue })
  const r = await h.call('/api/rsww/template-remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 'user-1' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(settingsValue.templates.length, 0)
  const r2 = await h.call('/api/rsww/template-remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 'ghost' } })
  assert.equal(r2.status, 400)
})
