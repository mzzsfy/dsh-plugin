// 环境变量路由测试:CRUD / 打码 / 导入导出(设计 §4.4、§7 BDD)。
// ctx 桩形态对齐 usage-panel route.test.mjs;数据走临时目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createLogger } from '../src/logger.mjs'
import { createApi } from '../src/api.mjs'

async function makeApi(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-api-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const api = createApi({ store, logger, ...overrides })
  return { store, api }
}

function makeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000' }
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

async function call(api, method, pathAndQuery, body) {
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => {
    res.raw = text
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
  }
  const req = makeReq(method, body)
  req.url = 'http://localhost' + pathAndQuery
  await api.handle(req, res)
  return res
}

test('envs 路由:新建后列表打码,长度不足四字符全打码', async (t) => {
  // Given 新建变量 value=abcdef123456
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'TOKEN', value: 'abcdef123456', remarks: 'r', enabled: true })
  await store.envs.create({ name: 'SHORT', value: 'abc', remarks: '', enabled: true })
  // When 列表
  const res = await call(api, 'GET', '/api/cron-board/envs')
  // Then 打码:前2后2中间***;短值全 ***
  assert.equal(res.status, 200)
  const token = res.payload.items.find((row) => row.name === 'TOKEN')
  assert.equal(token.value, 'ab***56')
  const short = res.payload.items.find((row) => row.name === 'SHORT')
  assert.equal(short.value, '***')
})

test('envs 路由:PATCH 更新与 DELETE 删除', async (t) => {
  const { store, api } = await makeApi(t)
  const row = await store.envs.create({ name: 'K', value: 'v', remarks: '', enabled: true })
  // When 更新值与启停,再删除
  const patched = await call(api, 'PATCH', '/api/cron-board/envs/' + row.id, { value: 'v2', enabled: false })
  // Then 更新生效
  assert.equal(patched.status, 200)
  assert.equal(store.envs.get(row.id).value, 'v2')
  assert.equal(store.envs.get(row.id).enabled, false)
  const deleted = await call(api, 'DELETE', '/api/cron-board/envs/' + row.id)
  assert.equal(deleted.status, 200)
  assert.equal(store.envs.get(row.id), undefined)
  // 未知 id 删除报业务错误
  const missing = await call(api, 'DELETE', '/api/cron-board/envs/no-such-id')
  assert.equal(missing.status, 400)
  assert.match(missing.payload.error, /不存在/)
})

test('envs 路由:导入预览不落盘,确认导入追加', async (t) => {
  // Given 已有一条 A=old
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'A', value: 'old', remarks: '', enabled: true })
  const text = 'A=1 #备注一\nB=2\n坏行\n'
  // When 预览(preview=1)
  const preview = await call(api, 'POST', '/api/cron-board/import?preview=1', { text })
  // Then 解析统计正确且未落盘
  assert.equal(preview.status, 200)
  assert.equal(preview.payload.parsed, 2)
  assert.equal(preview.payload.invalid, 1)
  assert.equal(store.envs.list().length, 1)
  // When 确认导入(追加)
  const committed = await call(api, 'POST', '/api/cron-board/import', { text, mode: 'append' })
  // Then 追加两条,A 有新旧两条(同名多值)
  assert.equal(committed.status, 200)
  const rows = store.envs.list()
  assert.equal(rows.length, 3)
  assert.equal(rows.filter((row) => row.name === 'A').length, 2)
})

test('envs 路由:覆盖导入清空原集合再落盘', async (t) => {
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'OLD', value: 'x', remarks: '', enabled: true })
  // When 覆盖导入
  const committed = await call(api, 'POST', '/api/cron-board/import', { text: 'N=1\n', mode: 'overwrite' })
  // Then 原集合清空,仅剩新行
  assert.equal(committed.status, 200)
  assert.deepEqual(store.envs.list().map((row) => row.name), ['N'])
})

test('envs 路由:导出默认仅启用行,备注折叠为行尾注释', async (t) => {
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'ON', value: '1', remarks: 'note', enabled: true })
  await store.envs.create({ name: 'OFF', value: '2', remarks: '', enabled: false })
  // When 导出(默认不含禁用)
  const res = await call(api, 'GET', '/api/cron-board/envs/export')
  // Then 行文本形态
  assert.equal(res.payload.text, 'ON=1 #note\n')
})

test('jobs 路由:缺必填字段报中文业务错误', async (t) => {
  const { api } = await makeApi(t)
  // When 缺 name 新建任务
  const res = await call(api, 'POST', '/api/cron-board/jobs', { kind: 'shell', command: 'x', schedule: '* * * * *' })
  // Then 400 且中文文案
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /名称/)
})

test('jobs 路由:非法 cron 表达式被拒', async (t) => {
  const { api } = await makeApi(t)
  // When schedule 非法
  const res = await call(api, 'POST', '/api/cron-board/jobs', { name: 'j', kind: 'shell', command: 'x', schedule: 'not-a-cron' })
  // Then 400 且文案含表达式
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /cron/)
})

test('jobs 路由:手动运行端到端——RunRecord 产生、日志可读、状态终态', async (t) => {
  // Given shell 任务(node -e 输出标记)
  const { store, api } = await makeApi(t)
  const job = await store.jobs.create({
    name: 'e2e', kind: 'shell',
    command: `${process.execPath} -e "console.log('e2e-marker')"`,
    schedule: '* * * * *', enabled: true, timeoutMs: 10 * 1000,
  })
  // When 手动运行
  const runRes = await call(api, 'POST', '/api/cron-board/jobs/' + job.id + '/run')
  assert.equal(runRes.status, 200)
  const { runIds } = runRes.payload
  assert.equal(runIds.length, 1)
  // Then 等待终态,记录与日志齐备
  const record = await waitFor(() => {
    const row = store.runs.get(runIds[0])
    return row && row.status !== 'queued' && row.status !== 'running' ? row : null
  })
  assert.equal(record.status, 'success')
  assert.equal(record.trigger, 'manual')
  const logRes = await call(api, 'GET', '/api/cron-board/runs/' + runIds[0] + '/log')
  assert.match(logRes.payload.text, /e2e-marker/)
})

test('jobs 路由:同名多值展开为多条 RunRecord 与多次运行', async (t) => {
  // Given 启用变量 A=1/A=2,任务回显变量值
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'CB_E2E', value: 'one', enabled: true })
  await store.envs.create({ name: 'CB_E2E', value: 'two', enabled: true })
  const job = await store.jobs.create({
    name: 'multi', kind: 'shell',
    command: `${process.execPath} -e "console.log('V=' + process.env.CB_E2E)"`,
    schedule: '* * * * *', enabled: true, timeoutMs: 10 * 1000,
  })
  // When 手动运行
  const runRes = await call(api, 'POST', '/api/cron-board/jobs/' + job.id + '/run')
  const { runIds } = runRes.payload
  // Then 两条记录、两条日志各注入一个值
  assert.equal(runIds.length, 2)
  const records = await waitFor(() => {
    const rows = runIds.map((id) => store.runs.get(id))
    return rows.every((row) => row && row.status !== 'queued' && row.status !== 'running') ? rows : null
  })
  assert.equal(records.length, 2)
  const logs = new Set()
  for (const id of runIds) {
    const logRes = await call(api, 'GET', '/api/cron-board/runs/' + id + '/log')
    logs.add(logRes.payload.text.match(/V=(\w+)/)[1])
  }
  assert.deepEqual([...logs].sort(), ['one', 'two'])
})

// 轮询等待:超时抛错(测试内时间敏感操作统一出口)
function waitFor(pick, timeoutMs = 10 * 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = pick()
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor 超时'))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}
