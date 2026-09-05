// 通知接线路由测试:查询评估入投影 / 凭据脱敏 / 配置校验 / 真实投递结果 / 账号 notify 归一。
// 数据目录经 env 注入临时路径,须在 import src/index.js 之前设置(模块顶层求值)。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'usage-notify-route-'))
process.env.DSH_USAGE_PANEL_DATA_DIR = tempDir

const { apply } = await import('../src/index.js')

after(async () => {
  delete process.env.DSH_USAGE_PANEL_DATA_DIR
  await rm(tempDir, { recursive: true, force: true })
})

const NOTIFY_ON = { pollIntervalSec: 600, notify: { enabled: true, quotaThresholdPct: 50 } }

function makeCtx({ settingsValue = {}, dshIm = undefined } = {}) {
  let value = settingsValue
  const routes = new Map()
  const settingsService = {
    register() {},
    get: () => value,
    update: async (_ns, patch) => {
      value = { ...value, ...patch }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'dshIm') return dshIm
      return undefined
    },
    effect(fn) {
      fn()
    },
    inject(_deps, fn) {
      fn({ settings: settingsService, interval: () => {} })
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
      },
    },
  }
  return { ctx, routes }
}

function makeReq(method, body, extraHeaders = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000', ...extraHeaders }
  if (body !== undefined) {
    if (req.headers['content-type'] === undefined) req.headers['content-type'] = 'application/json'
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    process.nextTick(() => {
      req.emit('data', Buffer.from(text))
      req.emit('end')
    })
  }
  return req
}

async function call(routes, path, req) {
  if (req.url === undefined) req.url = path
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null }
  await routes.get(path.split('?')[0])(req, res)
  return res
}

// kimi 形态响应:5 小时窗 utilization 95,7 天窗 75。
const KIMI_BODY = {
  limits: [{ detail: { limit: 100, remaining: 5, resetTime: 'T1' } }],
  usage: { limit: 200, remaining: 50, resetTime: 'T2' },
}

async function saveKimiAccount(routes) {
  return call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    accounts: [{ id: 'acct-1', name: '账号K', type: 'kimi', apiKey: 'sk-test' }],
  }))
}

test('评估接线: 查询成功后越阈窗口产生事件并进入投影', async () => {
  // Given 全局通知启用阈值 50, 已保存 kimi 账号, 平台接口桩返回超阈读数
  const { ctx, routes } = makeCtx({ settingsValue: NOTIFY_ON })
  apply(ctx)
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/v1/usages')) return { ok: true, text: async () => JSON.stringify(KIMI_BODY) }
    throw new Error('unexpected url: ' + url)
  }
  try {
    await saveKimiAccount(routes)
    // When 手动查询该账号
    const queryRes = await call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-1' }))
    // Then 查询成功
    assert.equal(queryRes.status, 200)
    assert.equal(queryRes.payload.ok, true)
    // When 读取通知投影
    const notifyRes = await call(routes, '/api/usage-panel/notifications', makeReq('GET'))
    // Then 两个越阈窗口各产生一条 quota 事件
    assert.equal(notifyRes.status, 200)
    assert.equal(notifyRes.payload.units.length, 2)
    assert.equal(notifyRes.payload.units[0].kind, 'quota')
    assert.match(notifyRes.payload.units[0].text, /账号K/)
  } finally {
    globalThis.fetch = original
  }
})

test('评估接线: 全局通知关闭时查询不产生事件', async () => {
  // Given 通知总开关关闭
  const { ctx, routes } = makeCtx({ settingsValue: { pollIntervalSec: 600, notify: { enabled: false, quotaThresholdPct: 50 } } })
  apply(ctx)
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(KIMI_BODY) })
  try {
    await saveKimiAccount(routes)
    await call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-1' }))
    const notifyRes = await call(routes, '/api/usage-panel/notifications', makeReq('GET'))
    // Then 投影为空
    assert.equal(notifyRes.payload.units.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('notify-config: GET 不回显 webhookUrl 原文, 仅回是否已配置', async () => {
  // Given 已配置 webhook 的 settings
  const { ctx, routes } = makeCtx({ settingsValue: { pollIntervalSec: 600, notify: { enabled: true, webhookUrl: 'https://hooks.example.com/private' } } })
  apply(ctx)
  // When 读取通知配置
  const res = await call(routes, '/api/usage-panel/notify-config', makeReq('GET'))
  // Then 原文不出主机
  assert.equal(res.status, 200)
  assert.equal(res.payload.notify.webhookUrl, undefined)
  assert.equal(res.payload.notify.webhookConfigured, true)
  assert.equal(res.payload.imAvailable, false)
})

test('notify-config: 非法补丁 400, 合法补丁合并生效', async () => {
  // Given 合法 ctx
  const { ctx, routes } = makeCtx({ settingsValue: { pollIntervalSec: 600, notify: { enabled: true } } })
  apply(ctx)
  // When 提交越界阈值
  const bad = await call(routes, '/api/usage-panel/notify-config', makeReq('POST', { quotaThresholdPct: 0 }))
  // Then 拒绝
  assert.equal(bad.status, 400)
  // When 提交合法补丁(仅改阈值与余额阈值)
  const good = await call(routes, '/api/usage-panel/notify-config', makeReq('POST', { quotaThresholdPct: 80, balanceThreshold: 20 }))
  // Then 生效且未提供的键保持原值
  assert.equal(good.status, 200)
  const view = await call(routes, '/api/usage-panel/notify-config', makeReq('GET'))
  assert.equal(view.payload.notify.quotaThresholdPct, 80)
  assert.equal(view.payload.notify.balanceThreshold, 20)
  assert.equal(view.payload.notify.enabled, true)
})

test('test-webhook: 返回真实投递结果而非谎报成功', async () => {
  // Given webhook 已配置, fetch 桩标记调用
  const { ctx, routes } = makeCtx({ settingsValue: { pollIntervalSec: 600, notify: { enabled: true, webhookUrl: 'https://hooks.example.com/hook' } } })
  apply(ctx)
  const original = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) }
    return { ok: true, status: 200 }
  }
  try {
    // When 触发测试投递
    const res = await call(routes, '/api/usage-panel/test-webhook', makeReq('POST', {}, { origin: 'http://localhost:3000' }))
    // Then 返回真实结果且 payload 发往配置地址
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.match(captured.url, /hooks\.example\.com\/hook/)
    assert.match(captured.body.text, /测试/)
  } finally {
    globalThis.fetch = original
  }
})

test('test-im: dsh-im 缺失如实降级, 在场时逐目标返回结果', async () => {
  // Given dsh-im 未安装
  const off = makeCtx({ settingsValue: NOTIFY_ON })
  apply(off.ctx)
  const offRes = await call(off.routes, '/api/usage-panel/test-im', makeReq('POST', {}, { origin: 'http://localhost:3000' }))
  // Then 返回失败并注明未安装
  assert.equal(offRes.payload.ok, false)
  assert.match(offRes.payload.detail, /未安装/)

  // Given dsh-im 在场且已配置一个投递目标
  const sent = []
  const dshIm = { send: async (botId, targetId, text) => { sent.push({ botId, targetId, text }) } }
  const on = makeCtx({ settingsValue: { pollIntervalSec: 600, notify: { enabled: true, imTargets: [{ botId: 'wx_a', targetId: 'owner' }] } }, dshIm })
  apply(on.ctx)
  // When 触发测试投递
  const onRes = await call(on.routes, '/api/usage-panel/test-im', makeReq('POST', {}, { origin: 'http://localhost:3000' }))
  // Then 真实送达且结果逐目标可见
  assert.equal(onRes.payload.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].botId, 'wx_a')
})

test('账号保存: notify 覆盖字段归一, 非法键剔除', async () => {
  // Given 带混合 notify 字段与非法值的账号
  const { ctx, routes } = makeCtx({ settingsValue: NOTIFY_ON })
  apply(ctx)
  // When 保存
  const res = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    accounts: [{ id: 'acct-1', name: '账号K', type: 'kimi', apiKey: 'sk-test', notify: { quotaThresholdPct: 70, junk: 1, resetNotice: 'x' } }],
  }))
  // Then 响应与落盘账号仅保留值域合法的覆盖键
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.accounts[0].notify, { quotaThresholdPct: 70 })
})

test('沿触发状态持久化: 查询后账号携带 notifyState, 再次 GET accounts 可见', async () => {
  // Given 通知启用且已保存账号
  const { ctx, routes } = makeCtx({ settingsValue: NOTIFY_ON })
  apply(ctx)
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(KIMI_BODY) })
  try {
    await saveKimiAccount(routes)
    // When 查询一次后重新拉取账号
    await call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-1' }))
    const res = await call(routes, '/api/usage-panel/accounts', makeReq('GET'))
    // Then 账号携带沿触发状态(窗口基线), 重启后不重发的锚点
    const account = res.payload.accounts[0]
    assert.ok(account.notifyState && account.notifyState.windows)
    assert.equal(account.notifyState.windows['5小时'].armed, false)
  } finally {
    globalThis.fetch = original
  }
})

test('编辑账号保留沿触发状态与读数: 提交对象缺 last/notifyState 时回填旧值', async () => {
  // Given 已查询产生沿触发状态的账号
  const { ctx, routes } = makeCtx({ settingsValue: NOTIFY_ON })
  apply(ctx)
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(KIMI_BODY) })
  try {
    await saveKimiAccount(routes)
    await call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-1' }))
    // When 仅改名重新保存(客户端提交对象不含 last/notifyState)
    const saveRes = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
      accounts: [{ id: 'acct-1', name: '改名账号', type: 'kimi', apiKey: '' }],
    }))
    // Then 旧 Key/读数/沿触发状态全部保留
    assert.equal(saveRes.status, 200)
    const account = saveRes.payload.accounts[0]
    assert.equal(account.name, '改名账号')
    assert.equal(account.hasKey, true)
    assert.ok(account.last && account.last.ok === true)
    assert.equal(account.notifyState.windows['5小时'].armed, false)
  } finally {
    globalThis.fetch = original
  }
})

test('toast 开关: 关闭后事件不进投影(出站通道不受影响无直接断言)', async () => {
  // Given 通知启用但页内 toast 关闭
  const settings = { pollIntervalSec: 600, notify: { enabled: true, quotaThresholdPct: 50, toast: false } }
  const { ctx, routes } = makeCtx({ settingsValue: settings })
  apply(ctx)
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(KIMI_BODY) })
  try {
    await saveKimiAccount(routes)
    await call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-1' }))
    const res = await call(routes, '/api/usage-panel/notifications', makeReq('GET'))
    // Then 投影为空
    assert.equal(res.payload.units.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('写路由守卫: 跨源 403, 非 JSON 400', async () => {
  // Given 合法 ctx
  const { ctx, routes } = makeCtx({ settingsValue: NOTIFY_ON })
  apply(ctx)
  // When 跨源 POST notify-config
  const cross = await call(routes, '/api/usage-panel/notify-config', makeReq('POST', '{}', { origin: 'https://evil.example' }))
  // Then 403
  assert.equal(cross.status, 403)
  // When 同源但 text/plain 简单请求
  const plain = await call(routes, '/api/usage-panel/notify-config', makeReq('POST', '{}', {
    origin: 'http://localhost:3000',
    'content-type': 'text/plain',
  }))
  // Then 400
  assert.equal(plain.status, 400)
  // When 同源 JSON 合法请求
  const ok = await call(routes, '/api/usage-panel/notify-config', makeReq('POST', { resetNotice: false }, { origin: 'http://localhost:3000' }))
  // Then 通过
  assert.equal(ok.status, 200)
})

test('im-targets: dsh-im 缺失 503, botId 非法 400, 在场时字段裁剪返回', async () => {
  // Given dsh-im 未安装
  const off = makeCtx({ settingsValue: NOTIFY_ON })
  apply(off.ctx)
  const offRes = await call(off.routes, '/api/usage-panel/im-targets?botId=wx_a', makeReq('GET'))
  assert.equal(offRes.status, 503)

  // Given dsh-im 在场
  const dshIm = {
    listTargets: async () => [{ targetId: 'owner', name: '机主', kind: 'wechat', route: 'native-xyz' }],
  }
  const on = makeCtx({ settingsValue: NOTIFY_ON, dshIm })
  apply(on.ctx)
  // When botId 非法
  const bad = await call(on.routes, '/api/usage-panel/im-targets?botId=', makeReq('GET'))
  // Then 400
  assert.equal(bad.status, 400)
  // When 合法查询
  const good = await call(on.routes, '/api/usage-panel/im-targets?botId=wx_a', makeReq('GET'))
  // Then route 字段不出主机
  assert.equal(good.status, 200)
  assert.deepEqual(good.payload.targets, [{ targetId: 'owner', name: '机主', kind: 'wechat' }])
})
