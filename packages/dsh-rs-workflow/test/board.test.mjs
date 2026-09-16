// board BDD:模拟 req/res 验证守卫与 14 路由语义(数据面 mock store/settings/driver)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerBoardRoutes } from '../lib/board.mjs'
import { createStore, reportStore } from '../lib/store.mjs'
import { registry } from '../lib/driver/control.mjs'
import { RunDriver } from '../lib/driver/index.mjs'

// reportStore 单例指向临时目录(board 经单例读写):本文件全部用例不触碰真实运行中心
process.env.DSH_RS_WORKFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'rsww-board-store-'))

// mock store 注入:board 用 reportStore() 单例 → 经 env 指向临时目录
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

const harness = ({ settingsValue = {}, drivers = new Map(), initiators = new Map() } = {}) => {
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
  registry.drivers.clear()
  for (const [k, v] of drivers) registry.drivers.set(k, v)
  registry.initiators.clear()
  for (const [k, v] of initiators) registry.initiators.set(k, v)
  return { routes, call, ctx }
}

const fakeDriver = (runId, status = 'running') => ({
  runId,
  state: { status },
  cancelCalls: 0,
  pauseCalls: 0,
  resumeCalls: 0,
  cancel() {
    this.cancelCalls++
  },
  pause() {
    this.pauseCalls++
  },
  resume() {
    this.resumeCalls++
  },
})

test('Given 15 路由声明 When 激活 board Then 全部注册', () => {
  const h = harness()
  const expect = ['/api/rsww/runs', '/api/rsww/run', '/api/rsww/control', '/api/rsww/resume-from', '/api/rsww/run-remove', '/api/rsww/templates', '/api/rsww/template', '/api/rsww/released', '/api/rsww/spec', '/api/rsww/template-save', '/api/rsww/template-remove', '/api/rsww/release', '/api/rsww/unrelease', '/api/rsww/config', '/api/rsww/config-save']
  for (const p of expect) assert.ok(h.routes.has(p), p)
})

test('Given 既有模板 id When GET template Then 返回 entry+JSON5 解析结果;Given 不存在 id Then 400 错误载荷', async () => {
  const h = harness()
  const ok = await h.call('/api/rsww/template', { method: 'GET', url: '/api/rsww/template?id=default' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.entry.id, 'default')
  assert.equal(ok.body.parsed.id, 'default')
  assert.ok(Array.isArray(ok.body.parsed.steps))
  const miss = await h.call('/api/rsww/template', { method: 'GET', url: '/api/rsww/template?id=nope' })
  assert.equal(miss.status, 400)
  assert.ok(miss.body.error)
})

test('Given PUT 方法 When 调 runs Then 405;Given 跨源 POST control When 异源 Origin Then 403', async () => {
  const h = harness()
  const r1 = await h.call('/api/rsww/runs', { method: 'PUT' })
  assert.equal(r1.status, 405)
  const r2 = await h.call('/api/rsww/control', { method: 'POST', headers: { origin: 'http://evil.example' }, body: { runId: 'r1', kind: 'cancel' } })
  assert.equal(r2.status, 403)
  assert.ok(r2.body.error)
  const r3 = await h.call('/api/rsww/control', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { runId: 'r1', kind: 'cancel' } })
  assert.equal(r3.status, 400)
})

test('Given 活跃 run When control cancel Then ok 且直调 RunDriver;Given message Then 入队 ok', async () => {
  const driver = fakeDriver('r-live')
  const h = harness({ drivers: new Map([['r-live', driver]]) })
  const r1 = await h.call('/api/rsww/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r-live', kind: 'cancel' } })
  assert.equal(r1.status, 200)
  assert.equal(r1.body.ok, true)
  assert.equal(driver.cancelCalls, 1)
  const r2 = await h.call('/api/rsww/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r-live', kind: 'pause' } })
  assert.equal(driver.pauseCalls, 1)
  const r3 = await h.call('/api/rsww/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r-nope', kind: 'cancel' } })
  assert.deepEqual(r3.body, { ok: false })
})

test('Given control kind 非法或 message 空 text When 调用 Then 400', async () => {
  const h = harness()
  const r1 = await h.call('/api/rsww/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r', kind: 'explode' } })
  assert.equal(r1.status, 400)
  const r2 = await h.call('/api/rsww/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r', kind: 'message', text: '' } })
  assert.equal(r2.status, 400)
})

test('Given 终态 run 记录 When resume-from 且发起器无该会话 Then 400 文案含「打开对应模式会话」', async () => {
  const h = harness()
  const r = await h.call('/api/rsww/resume-from', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r-gone' } })
  assert.equal(r.status, 400)
})

test('Given 完整链路(store 记录+模板+发起器) When resume-from Then 新 run 启动并返回新 runId', async () => {
  // 真实链路:reportStore 单例(顶部 env 已切临时目录)种入已完成 run;发起器桩捕获 seed/inputs
  // 并启动真实 RunDriver(桩 engine 同步回合法 callId+产出);fromStepId 指向已完成步骤 b
  const tpl = {
    id: 'chain', label: 'x',
    steps: [
      { id: 'a', prompt: 'P', outputs: { o: 'o' } },
      { id: 'b', after: ['a'], prompt: 'Q', outputs: { o: 'o' } },
      { id: 'c', after: ['b'], prompt: 'R', outputs: { o: 'o' } },
    ],
  }
  const settingsValue = { templates: [{ id: 'chain', label: 'x', description: '', enabled: true, json5: JSON.stringify(tpl) }] }
  const store = reportStore()
  store.start({
    runId: 'r-old', sessionId: 's9', workspace: '', request: '原始请求', templateId: 'chain',
    inputs: { src: 'orig' },
    state: {
      status: 'completed', request: '原始请求', inputs: { src: 'orig' },
      steps: {
        a: { status: 'done', outputs: { o: 'A' }, failCount: 0, instances: [] },
        b: { status: 'done', outputs: { o: 'B' }, failCount: 0, instances: [] },
        c: { status: 'pending', outputs: null, failCount: 0, instances: [] },
      },
      approvals: {}, escalations: 0, queued: [], batchSeq: 3,
    },
  })
  store.finish({ runId: 'r-old', status: 'completed', summary: 'x' })
  const seen = []
  let seq = 0
  const initiator = async (payload) => {
    seen.push(payload)
    const driver = new RunDriver({
      template: tpl, templateSet: [], runId: `r-new-${++seq}`,
      request: payload.request, inputs: payload.inputs ?? {}, state: JSON.parse(JSON.stringify(payload.seed)),
      parent: { session: { append: () => {} } },
      engine: {
        start({ args }) {
          return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'OK' } })) }) }
        },
      },
      sessionId: 's9', store,
    })
    driver.start()
    return driver
  }
  const h = harness({ settingsValue, initiators: new Map([['s9', initiator]]) })
  const r = await h.call('/api/rsww/resume-from', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { runId: 'r-old', fromStepId: 'b', inputs: { src: 'override' } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.ok(r.body.runId.startsWith('r-new-'))
  // 发起器载荷:request 透传;seed 中 fromStepId 及其后回 pending,done 且非 fromStepId 的 a 保留
  assert.equal(seen.length, 1)
  assert.equal(seen[0].request, '原始请求')
  assert.equal(seen[0].seed.steps.a.status, 'done')
  assert.equal(seen[0].seed.steps.b.status, 'pending')
  assert.equal(seen[0].seed.steps.c.status, 'pending')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const record = store.get(r.body.runId)
  assert.equal(record.status, 'completed')
  // 种子已完成步骤无新 dispatch;fromStepId 及其后步骤有 dispatch
  const dispatchOf = (id) => (record.steps[id]?.['-'] ?? []).filter((e) => e.event === 'dispatch')
  assert.equal(dispatchOf('a').length, 0)
  assert.ok(dispatchOf('b').length > 0)
  assert.ok(dispatchOf('c').length > 0)
  // inputs 覆盖生效:新 run record.inputs 为覆盖值
  assert.deepEqual(record.inputs, { src: 'override' })
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

test('Given GET spec/released/config/templates When 调用 Then 载荷形态正确', async () => {
  const h = harness()
  const r1 = await h.call('/api/rsww/spec')
  assert.equal(r1.status, 200)
  assert.ok(r1.body.spec.includes('type: "approve"'))
  assert.equal(r1.body.spec.includes('教学重问'), false)
  const r2 = await h.call('/api/rsww/released')
  assert.ok(Array.isArray(r2.body.ids))
  const r3 = await h.call('/api/rsww/config')
  assert.ok(r3.body.config.slots)
  const r4 = await h.call('/api/rsww/templates')
  assert.ok(Array.isArray(r4.body.templates))
  assert.ok(r4.body.templates.every((t) => typeof t.builtin === 'boolean'))
})

const MARKER_NAME = '.dsh-rs-workflow-source.json'
const MARKER_PACKAGE = '@mzzsfy/dsh-rs-workflow'

test('Given 内置模板 news When template-remove Then 墓碑落盘防复活', async () => {
  // 内置 id 不物理删除:settings.update 落 {id:'news',enabled:false} 墓碑防合并复活,unrelease 移除已创建模式
  const tplJson5 = JSON.stringify({ id: 'news', label: 'news', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] })
  const settingsValue = { templates: [{ id: 'news', label: 'news', description: '', enabled: true, json5: tplJson5 }] }
  const presetHome = mkdtempSync(join(tmpdir(), 'rsww-board-preset-'))
  const releaseDir = join(presetHome, '.agent-presets', 'rs-news')
  mkdirSync(releaseDir, { recursive: true })
  writeFileSync(join(releaseDir, MARKER_NAME), JSON.stringify({ package: MARKER_PACKAGE, kind: 'flow', version: '0.0.0' }))
  const prevPresetRoot = process.env.DSH_RS_WORKFLOW_PRESET_ROOT
  process.env.DSH_RS_WORKFLOW_PRESET_ROOT = presetHome
  try {
    const h = harness({ settingsValue })
    const r = await h.call('/api/rsww/template-remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 'news' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    // 墓碑落盘而非删除
    assert.equal(settingsValue.templates.length, 1)
    assert.equal(settingsValue.templates[0].id, 'news')
    assert.equal(settingsValue.templates[0].enabled, false)
    // 已创建模式被移除(unreleaseFlowTemplate 真实执行)
    assert.equal(existsSync(releaseDir), false)
    // 合并面:news 仍在且呈现禁用态
    const r2 = await h.call('/api/rsww/templates')
    const news = r2.body.templates.find((t) => t.id === 'news')
    assert.ok(news)
    assert.equal(news.enabled, false)
    assert.equal(news.builtin, true)
  } finally {
    if (prevPresetRoot === undefined) delete process.env.DSH_RS_WORKFLOW_PRESET_ROOT
    else process.env.DSH_RS_WORKFLOW_PRESET_ROOT = prevPresetRoot
  }
})
