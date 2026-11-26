// 环境变量路由测试:CRUD / 打码 / 导入导出(设计 §4.4、§7 BDD)。
// ctx 桩形态对齐 usage-panel route.test.mjs;数据走临时目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createLogger } from '../src/logger.mjs'
import { createExecutor } from '../src/executor.mjs'
import { createApi } from '../src/api.mjs'
import { MAX_SCHEDULES, nextRunAtOf } from '../src/cron.mjs'
import { DEFAULT_LOG_TAIL_LINES } from '../src/config.mjs'
import { withRouteGate } from '../src/route-gate.mjs'

async function makeApi(t, { executorOptions, prepare, ...overrides } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-api-'))
  const dataDir = join(dir, 'data')
  if (prepare) await prepare(dataDir)
  const store = await createStore({ dir: dataDir })
  // 清理前等写链排空:终态只保证内存可见,收尾写(任务卡回填、日志裁剪)提交晚于 flush,
  // rmdir 与其赛跑会 ENOTEMPTY;retries 吸收(镜像 executor/scheduler 测试同款参数)
  t.after(async () => {
    await store.flush()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, readMaxConcurrent: () => 2, ...executorOptions })
  // 会话服务默认给镜像宿主的最小方法面(create/prompt/modelCatalog),需要缺失态时逐用例覆盖
  const sessionController = {
    create: async () => ({ sessionId: 's-api' }),
    prompt: async () => ({ accepted: true }),
    modelCatalog: async () => ({ groups: [], failures: [] }),
  }
  const api = createApi({ store, logger, executor, getAgentPresets: () => null, getSessionController: () => sessionController, ...overrides })
  return { store, api, logger }
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

async function callRaw(api, { method, path, headers = {}, body }) {
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => {
    res.raw = text
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
  }
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000', ...headers }
  req.url = 'http://localhost' + path
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  await api.handle(req, res)
  return res
}

test('写路由守卫:装配层 withRouteGate 对写方法统一执行同源与 JSON 门', async (t) => {
  const { store, api } = await makeApi(t)
  // 生产路径由 index.js 以 withRouteGate 包裹 api.handle;此处复现同一装配
  const gated = { handle: withRouteGate({ get: () => undefined }, (req, res) => api.handle(req, res)) }
  // Given 一条合法建任务请求
  const body = JSON.stringify({ name: 'n', command: 'echo 1', kind: 'shell', schedule: '* * * * *' })
  // When 跨源 Origin
  const cross = await callRaw(gated, { method: 'POST', path: '/api/cron-board/jobs', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body })
  // Then 403 且不落库
  assert.equal(cross.status, 403)
  assert.equal(store.jobs.list().length, 0)
  // When 同源但 text/plain(drive-by 表单载荷)
  const plain = await callRaw(gated, { method: 'POST', path: '/api/cron-board/jobs', headers: { origin: 'http://localhost:3000', 'content-type': 'text/plain' }, body })
  // Then 400 且不落库(共享闸门统一状态码)
  assert.equal(plain.status, 400)
  assert.equal(store.jobs.list().length, 0)
  // When 同源 application/json
  const ok = await callRaw(gated, { method: 'POST', path: '/api/cron-board/jobs', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json; charset=utf-8' }, body })
  // Then 正常受理
  assert.equal(ok.status, 200)
  assert.equal(store.jobs.list().length, 1)
  // When 无 Origin 的本地 CLI 调用但未带 content-type
  const cliNoType = await callRaw(gated, { method: 'POST', path: '/api/cron-board/jobs', body })
  // Then 写方法一律要求 JSON(无 Origin 也要给类型)
  assert.equal(cliNoType.status, 400)
  // When 无 Origin 且显式 application/json
  const cli = await callRaw(gated, { method: 'POST', path: '/api/cron-board/jobs', headers: { 'content-type': 'application/json' }, body })
  // Then 放行
  assert.equal(cli.status, 200)
})


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

test('envs 路由:导入预览不落盘,确认导入追加(client 契约形态)', async (t) => {
  // Given 已有一条 A=old
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'A', value: 'old', remarks: '', enabled: true })
  const text = 'A=1 #备注一\nB=2\n坏行\n'
  // When 预览(body.apply 缺省,契约:parsed 为解析行数组)
  const preview = await call(api, 'POST', '/api/cron-board/envs/import', { text })
  // Then 解析行数组与非法计数正确且未落盘
  assert.equal(preview.status, 200)
  assert.equal(preview.payload.parsed.length, 2)
  assert.deepEqual(preview.payload.parsed.map((row) => row.name), ['A', 'B'])
  assert.equal(preview.payload.invalid, 1)
  assert.equal(store.envs.list().length, 1)
  // When 确认导入(body.apply=true 且 overwrite 缺省 = 追加)
  const committed = await call(api, 'POST', '/api/cron-board/envs/import', { text, apply: true })
  // Then 追加两条,A 有新旧两条(同名多值)
  assert.equal(committed.status, 200)
  const rows = store.envs.list()
  assert.equal(rows.length, 3)
  assert.equal(rows.filter((row) => row.name === 'A').length, 2)
})

test('envs 路由:覆盖导入清空原集合再落盘(client 契约 overwrite 字段)', async (t) => {
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'OLD', value: 'x', remarks: '', enabled: true })
  // When 覆盖导入
  const committed = await call(api, 'POST', '/api/cron-board/envs/import', { text: 'N=1\n', apply: true, overwrite: true })
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

test('envs 路由:导出/导入无损往返(多值、值内 #、备注转义)', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 三类容易在文本格式中丢失的值:多行、值内 ` #`、首尾空白与含 # 的备注
  await store.envs.create({ name: 'MULTI', value: 'a\nb\nc', remarks: '', enabled: true, multi: true })
  await store.envs.create({ name: 'HASH', value: 'x # keep', remarks: 'note', enabled: true })
  await store.envs.create({ name: 'SPACE', value: '  padded  ', remarks: 'r # x', enabled: true })
  // When 导出再导入(覆盖)
  const exported = await call(api, 'GET', '/api/cron-board/envs/export')
  const preview = await call(api, 'POST', '/api/cron-board/envs/import', { text: exported.payload.text })
  assert.equal(preview.payload.invalid, 0)
  const imported = await call(api, 'POST', '/api/cron-board/envs/import', { text: exported.payload.text, apply: true, overwrite: true })
  assert.equal(imported.status, 200)
  // Then 值、备注、multi 全部还原
  const rows = store.envs.list()
  const byName = (name) => rows.find((row) => row.name === name)
  assert.equal(byName('MULTI').value, 'a\nb\nc')
  assert.equal(byName('MULTI').multi, true)
  assert.equal(byName('HASH').value, 'x # keep')
  assert.equal(byName('HASH').remarks, 'note')
  assert.equal(byName('SPACE').value, '  padded  ')
  assert.equal(byName('SPACE').remarks, 'r # x')
})

test('E4: 单行 multi 导出带 [multi] 标志,覆盖导入后多值语义不丢', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 单行值的多值行:值里没有换行,文本形态本身无法推断 multi
  await store.envs.create({ name: 'SINGLE', value: 'a,b', remarks: '备注', enabled: true, multi: true })
  await store.envs.create({ name: 'PLAIN', value: 'a,b', remarks: '', enabled: true })
  // When 导出
  const exported = await call(api, 'GET', '/api/cron-board/envs/export')
  const lines = exported.payload.text.split('\n').filter(Boolean)
  // Then 多值行强制加引号并带标志,普通行保持裸值(标志不污染普通值)
  assert.deepEqual(lines, ['SINGLE="a,b" [multi] #备注', 'PLAIN=a,b'])
  // When 覆盖导入
  const imported = await call(api, 'POST', '/api/cron-board/envs/import', { text: exported.payload.text, apply: true, overwrite: true })
  assert.equal(imported.status, 200)
  // Then multi 与值/备注全部还原(旧实现丢了 multi,UI 退化为单行)
  const rows = store.envs.list()
  const single = rows.find((row) => row.name === 'SINGLE')
  assert.equal(single.multi, true)
  assert.equal(single.value, 'a,b')
  assert.equal(single.remarks, '备注')
  assert.equal(rows.find((row) => row.name === 'PLAIN').multi, false)
})

test('E4: 无标志的旧导出文本仍按值形态推断 multi(文本格式向下兼容)', async (t) => {
  const { api } = await makeApi(t)
  // Given 旧版导出文本:多行值只有引号转义,没有 [multi] 标志
  const text = 'OLD="a\\nb"\nONE="x"\n'
  const preview = await call(api, 'POST', '/api/cron-board/envs/import', { text })
  // Then 带换行的值判 multi,单行值判普通(不得因新格式把旧文本读坏)
  assert.deepEqual(preview.payload.parsed.map((row) => [row.name, row.value, row.multi]), [
    ['OLD', 'a\nb', true],
    ['ONE', 'x', false],
  ])
  // And 值里的同名字样不是标志(无引号值不做标志解析)
  const literal = await call(api, 'POST', '/api/cron-board/envs/import', { text: 'K=a [multi] b\nQ="x [multi]"\n' })
  assert.deepEqual(literal.payload.parsed.map((row) => [row.name, row.value, row.multi]), [
    ['K', 'a [multi] b', false],
    ['Q', 'x [multi]', false],
  ])
})

test('envs 路由:集合损坏时只读列表返回 broken/warning 而不是静默空表', async (t) => {
  // Given envs.json 是合法 JSON 对象(旧实现会显示空列表且无提示)
  const { api } = await makeApi(t, {
    prepare: async (dataDir) => {
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'envs.json'), '{"name":"旧数据"}', 'utf8')
    },
  })
  // When 读环境变量列表
  const res = await call(api, 'GET', '/api/cron-board/envs')
  // Then 空表但带 broken/warning
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.items, [])
  assert.deepEqual(res.payload.broken, ['envs'])
  assert.match(res.payload.warning, /损坏/)
})

test('envs 路由:multi 新建折叠 values 数组为换行存储(client 契约)', async (t) => {
  // Given 客户端 multi 提交形态:name+values 数组
  const { store, api } = await makeApi(t)
  // When 新建
  const created = await call(api, 'POST', '/api/cron-board/envs', { name: 'TOKEN', values: ['a', ' b ', '', 'c'], multi: true })
  // Then 单行存储 + multi 标志,值按行折叠,空白行剔除
  assert.equal(created.status, 200)
  const row = store.envs.get(created.payload.id)
  assert.equal(row.multi, true)
  assert.equal(row.value, 'a\nb\nc')
})

test('envs 路由:multi PATCH 折叠 values,非 multi 保留 value 语义', async (t) => {
  const { store, api } = await makeApi(t)
  const multiRow = await store.envs.create({ name: 'M', value: 'x', multi: true, enabled: true })
  const plainRow = await store.envs.create({ name: 'P', value: 'y', enabled: true })
  // When 多值行 PATCH values 数组;普通行 PATCH value 字符串
  const patchedMulti = await call(api, 'PATCH', '/api/cron-board/envs/' + multiRow.id, { values: ['u', 'v'], multi: true })
  const patchedPlain = await call(api, 'PATCH', '/api/cron-board/envs/' + plainRow.id, { value: 'z' })
  // Then 各按各自形态落库
  assert.equal(patchedMulti.status, 200)
  assert.equal(patchedPlain.status, 200)
  assert.equal(store.envs.get(multiRow.id).value, 'u\nv')
  assert.equal(store.envs.get(multiRow.id).multi, true)
  assert.equal(store.envs.get(plainRow.id).value, 'z')
  assert.equal(store.envs.get(plainRow.id).multi, undefined)
})

test('jobs 路由:缺必填字段报中文业务错误', async (t) => {
  const { api } = await makeApi(t)
  // When 缺 name 新建任务
  const res = await call(api, 'POST', '/api/cron-board/jobs', { kind: 'shell', command: 'x', schedule: '* * * * *' })
  // Then 400 且中文文案
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /名称/)
})

test('jobs 路由:concurrency 合法正整数透传落库(client 契约)', async (t) => {
  const { store, api } = await makeApi(t)
  // When 带并发上限新建
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '限流', kind: 'shell', command: 'x', schedule: '* * * * *', concurrency: 3,
  })
  // Then 落库透传,任务级闸门可读
  assert.equal(created.status, 200)
  assert.equal(created.payload.concurrency, 3)
  // When 非法值(0/负数/非整数)不落库
  const bad = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '不限', kind: 'shell', command: 'x', schedule: '* * * * *', concurrency: 0,
  })
  assert.equal(bad.status, 200)
  assert.equal(bad.payload.concurrency, undefined)
  assert.equal(store.jobs.list().filter((job) => job.name === '限流')[0].concurrency, 3)
})

test('jobs 路由:非法 cron 表达式被拒', async (t) => {
  const { api } = await makeApi(t)
  // When schedule 非法
  const res = await call(api, 'POST', '/api/cron-board/jobs', { name: 'j', kind: 'shell', command: 'x', schedule: 'not-a-cron' })
  // Then 400 且文案含表达式
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /cron/)
})

test('jobs 路由:无未来触发点的表达式 POST/PATCH 一律 400', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 一个合法但永不触发的表达式
  const impossible = '0 0 30 2 *'
  // When POST
  const created = await call(api, 'POST', '/api/cron-board/jobs', { name: '永不', kind: 'shell', command: 'x', schedule: impossible })
  // Then 400,不落库
  assert.equal(created.status, 400)
  assert.match(created.payload.error, /未来触发点/)
  assert.equal(store.jobs.list().length, 0)
  // When PATCH 已存在任务改成永不触发
  const job = await store.jobs.create({ name: '正常', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + job.id, { schedule: impossible })
  // Then 400 且原 schedule 不变
  assert.equal(patched.status, 400)
  assert.match(patched.payload.error, /未来触发点/)
  assert.equal(store.jobs.get(job.id).schedule, '* * * * *')
  // Then 旧数据已存在无触发点任务时,停用/改名等维护性 PATCH 仍可操作(不锁死)
  const legacy = await store.jobs.create({ name: '旧永不', kind: 'shell', command: 'x', schedule: impossible, enabled: true, timeoutMs: 1000, nextRunAt: null })
  const disabled = await call(api, 'PATCH', '/api/cron-board/jobs/' + legacy.id, { enabled: false })
  assert.equal(disabled.status, 200)
  assert.equal(store.jobs.get(legacy.id).enabled, false)
})

test('jobs 路由:编辑保存按当前 schedule 重算 nextRunAt', async (t) => {
  const { api } = await makeApi(t)
  // Given 任务按工作日 09:55 排期
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '改期', kind: 'shell', command: 'x', schedule: '55 9 * * 1-5',
  })
  assert.equal(created.status, 200)
  const jobId = created.payload.id
  const before = created.payload.nextRunAt
  // When 编辑改为每天 09:00(表单契约:请求体不带 nextRunAt)
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, { schedule: '0 9 * * *', prompt: 'x' })
  // Then 触发点随新表达式重算,不残留工作日旧值
  assert.equal(patched.status, 200)
  assert.notEqual(patched.payload.nextRunAt, before)
  assert.equal(patched.payload.nextRunAt, nextRunAtOf('0 9 * * *'))
})

test('jobs 路由:PATCH 显式 nextRunAt 优先于重算(导入保留原状态契约)', async (t) => {
  const { api } = await makeApi(t)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '导入', kind: 'shell', command: 'x', schedule: '* * * * *',
  })
  assert.equal(created.status, 200)
  // When 请求体显式携带 nextRunAt
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + created.payload.id, {
    schedule: '0 9 * * *', nextRunAt: 1750000000000,
  })
  // Then 显式值落库,不被重算覆盖
  assert.equal(patched.status, 200)
  assert.equal(patched.payload.nextRunAt, 1750000000000)
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

test('jobs 路由:DELETE 遇到无法终止的在途会话返回 409,任务保留且不误删(C3)', async (t) => {
  // Given 一个在途会话运行没有取消句柄,settle deadline 缩到 50ms
  let markStarted
  const runnerStarted = new Promise((resolve) => { markStarted = resolve })
  const { store, api } = await makeApi(t, {
    executorOptions: {
      settleTimeoutMs: 50,
      sessionRunner: { run: () => { markStarted(); return { promise: new Promise(() => {}) } } },
    },
  })
  const job = await store.jobs.create({
    name: '在途', kind: 'session', prompt: 'x', schedule: '* * * * *',
    enabled: true, session: { mode: 'fresh' },
  })
  // When 发起运行并删除(等 runner 真正开始:running 落库早于 runner 启动,不能作为在飞判据)
  const runRes = await call(api, 'POST', '/api/cron-board/jobs/' + job.id + '/run')
  assert.equal(runRes.status, 200)
  await runnerStarted
  await waitFor(() => store.runs.list(job.id).some((row) => row.status === 'running'))
  const del = await call(api, 'DELETE', '/api/cron-board/jobs/' + job.id)
  // Then 删除被明确拒绝,任务与运行记录仍在(后续不会静默投递)
  assert.equal(del.status, 409)
  assert.match(del.payload.error, /在途运行未能终止/)
  assert.ok(store.jobs.get(job.id), '任务不得被删除')
  assert.equal(store.runs.list(job.id)[0].status, 'running')
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

test('jobs 路由:慢盘下运行终态后清理不与收尾写赛跑(ENOTEMPTY 回归)', async (t) => {
  // Given 持久化注入慢盘延迟(放大终态内存可见与收尾写落盘的窗口)
  const { store, api } = await makeApi(t)
  const rawUpdate = store.runs.update.bind(store.runs)
  store.runs.update = (runId, patch) => new Promise((resolve) => {
    setTimeout(() => rawUpdate(runId, patch).then(resolve, resolve), 25)
  })
  const job = await store.jobs.create({
    name: 'slowdisk', kind: 'shell',
    command: `${process.execPath} -e ""`,
    schedule: '* * * * *', enabled: true, timeoutMs: 10 * 1000,
  })
  // When 手动运行到终态后测试即结束(清理走 makeApi 的 flush+retries)
  const runRes = await call(api, 'POST', '/api/cron-board/jobs/' + job.id + '/run')
  const { runIds } = runRes.payload
  await waitFor(() => {
    const row = store.runs.get(runIds[0])
    return row && row.status !== 'queued' && row.status !== 'running' ? row : null
  })
})

test('status 路由:报告调度器与 timer 可用性', async (t) => {
  // Given scheduler 桩与 timer 运行标记
  const { api } = await makeApi(t, {
    scheduler: { status: () => ({ active: 1, queued: 2 }), nextRunAt: () => 1750000000000 },
    periodic: { running: true, reason: null },
  })
  // When GET /status
  const res = await call(api, 'GET', '/api/cron-board/status')
  // Then 状态齐备;ui 偏好缺省为关(默认主界面)
  assert.equal(res.status, 200)
  assert.equal(res.payload.timerRunning, true)
  assert.deepEqual(res.payload.scheduler, { active: 1, queued: 2 })
  assert.equal(res.payload.nextAt, 1750000000000)
  assert.deepEqual(res.payload.ui, { sidebarTab: false, showAutomationTasks: false, toolsAppend: false, toolsOverlay: false })
  assert.deepEqual(res.payload.toolStatus, { appendActive: false, overlayActive: false })
  // 覆盖未生效时的对账现场:缺省 readToolDiagnostics 也要有稳定形态
  assert.deepEqual(res.payload.toolDiagnostics, { overlay: null })
})

test('status 路由:ui.sidebarTab 透出用户侧边栏移入偏好', async (t) => {
  // Given readSidebarTab 桩返回开
  const { api } = await makeApi(t, { readSidebarTab: () => true })
  // When GET /status
  const res = await call(api, 'GET', '/api/cron-board/status')
  // Then ui.sidebarTab=true(client 据此移入扩展槽)
  assert.equal(res.payload.ui.sidebarTab, true)
})

test('ui-settings 路由:布尔补丁经 updateUiSettings 写入并回读', async (t) => {
  // Given 写入桩记录补丁,读取桩翻转返回(模拟 settings.update 后生效);
  // 写入桩 async 返回 true 镜像持久化成功契约(宿主 update 为异步面)
  let stored = false
  let storedAutomation = false
  const { api } = await makeApi(t, {
    updateUiSettings: async (patch) => {
      if (typeof patch.sidebarTab === 'boolean') stored = patch.sidebarTab
      if (typeof patch.showAutomationTasks === 'boolean') storedAutomation = patch.showAutomationTasks
      return true
    },
    readSidebarTab: () => stored,
    readShowAutomationTasks: () => storedAutomation,
  })
  // When POST 开关开
  const res = await call(api, 'POST', '/api/cron-board/ui-settings', { sidebarTab: true })
  // Then ok 且回读 true;写桩收到布尔补丁
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.ui.sidebarTab, true)
  assert.equal(stored, true)
})

test('ui-settings 路由:showAutomationTasks 布尔补丁独立持久化,不回滚 sidebarTab', async (t) => {
  // Given 两项偏好各自独立,只有 showAutomationTasks 被切换
  let storedSidebar = true
  let storedAutomation = false
  const { api } = await makeApi(t, {
    updateUiSettings: async (patch) => {
      if (typeof patch.sidebarTab === 'boolean') storedSidebar = patch.sidebarTab
      if (typeof patch.showAutomationTasks === 'boolean') storedAutomation = patch.showAutomationTasks
      return true
    },
    readSidebarTab: () => storedSidebar,
    readShowAutomationTasks: () => storedAutomation,
  })
  // When POST 只写 showAutomationTasks
  const res = await call(api, 'POST', '/api/cron-board/ui-settings', { showAutomationTasks: true })
  // Then 回读两项均正确,sidebarTab 保持原值
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.ui.showAutomationTasks, true)
  assert.equal(res.payload.ui.sidebarTab, true)
  assert.equal(storedSidebar, true)
  assert.equal(storedAutomation, true)
})

test('ui-settings 读写模型工具开关时保留另一开关', async (t) => {
  const settings = { toolsAppend: false, toolsOverlay: true }
  const { api } = await makeApi(t, {
    readToolsAppend: () => settings.toolsAppend,
    readToolsOverlay: () => settings.toolsOverlay,
    updateUiSettings: async (patch) => { Object.assign(settings, patch); return true },
  })
  const enabled = await call(api, 'POST', '/api/cron-board/ui-settings', { toolsAppend: true })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.payload.ui.toolsAppend, true)
  assert.equal(enabled.payload.ui.toolsOverlay, true)
  const disabled = await call(api, 'POST', '/api/cron-board/ui-settings', { toolsOverlay: false })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.payload.ui.toolsAppend, true)
  assert.equal(disabled.payload.ui.toolsOverlay, false)
})

test('status 路由:ui.showAutomationTasks 透出自动化任务只读聚合偏好', async (t) => {
  // Given readShowAutomationTasks 桩返回开
  const { api } = await makeApi(t, { readShowAutomationTasks: () => true })
  // When GET /status
  const res = await call(api, 'GET', '/api/cron-board/status')
  // Then ui.showAutomationTasks=true(client 据此加加载宿主目录)
  assert.equal(res.payload.ui.showAutomationTasks, true)
  assert.equal(res.payload.ui.sidebarTab, false)
})

test('ui-settings 路由:无效字段 400,服务缺失降级 ok=false', async (t) => {
  const noHandler = await makeApi(t, { updateUiSettings: undefined })
  const res1 = await call(noHandler.api, 'POST', '/api/cron-board/ui-settings', { sidebarTab: true })
  assert.equal(res1.status, 200)
  assert.equal(res1.payload.ok, false)
  const { api } = await makeApi(t)
  const res2 = await call(api, 'POST', '/api/cron-board/ui-settings', { other: 1 })
  assert.equal(res2.status, 400)
})

test('status 路由:timer 缺失降级时 timerRunning=false 且带原因', async (t) => {
  const { api } = await makeApi(t, { periodic: { running: false, reason: '宿主定时服务不可用' } })
  const res = await call(api, 'GET', '/api/cron-board/status')
  assert.equal(res.payload.timerRunning, false)
  assert.equal(res.payload.timerReason, '宿主定时服务不可用')
})

test('jobs 路由:名称长度只在提交名称时校验,存量超长名仍可停用', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 一个存量超长名称的任务
  const job = await store.jobs.create({ name: 'x'.repeat(121), kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  // When 不提交名称只改成停用
  const disabled = await call(api, 'PATCH', '/api/cron-board/jobs/' + job.id, { enabled: false, updatedAt: job.updatedAt })
  // Then 受理(否则这类任务再也改不动)
  assert.equal(disabled.status, 200)
  assert.equal(disabled.payload.enabled, false)
  // When 提交超长名称
  const tooLong = await call(api, 'PATCH', '/api/cron-board/jobs/' + job.id, { name: 'y'.repeat(121), updatedAt: disabled.payload.updatedAt })
  // Then 400 且原值不变
  assert.equal(tooLong.status, 400)
  assert.match(tooLong.payload.error, /名称最多/)
  assert.equal(store.jobs.get(job.id).name, 'x'.repeat(121))
  // When 新建时提交超长名称
  const created = await call(api, 'POST', '/api/cron-board/jobs', { name: 'z'.repeat(121), kind: 'shell', command: 'x', schedule: '* * * * *' })
  assert.equal(created.status, 400)
})

test('jobs 路由:会话任务字段校验与默认值', async (t) => {
  const { store, api } = await makeApi(t)
  // When 建 pinned 会话任务(携带已废弃的窗口字段与执行预设)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '日报', kind: 'session', prompt: '写日报',
    schedule: '0 9 * * *', enabled: true, timeoutMs: 60 * 1000,
    session: { mode: 'pinned', pinnedSessionId: ' s-9 ', windowStart: '09:00', windowEnd: '23:00', onMiss: 'defer', agentPreset: ' coder ' },
  })
  // Then 会话子对象仅落合法字段(窗口三字段已随功能删除,不再产出),id 已裁剪
  assert.equal(created.status, 200)
  assert.deepEqual(created.payload.session, { mode: 'pinned', pinnedSessionId: 's-9', agentPreset: 'coder' })
  assert.equal(created.payload.timeoutMs, undefined)
  // When shell 任务不带 session 字段
  const shellJob = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 's1', kind: 'shell', command: 'echo x', schedule: '* * * * *', enabled: true, timeoutMs: 1000,
  })
  // Then session 字段缺省,shell 保留显式超时
  assert.equal(shellJob.payload.session, undefined)
  assert.equal(shellJob.payload.timeoutMs, 1000)
  // When 单次运行开关
  const once = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'once', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true, runOnce: true,
    session: { mode: 'fresh' },
  })
  // Then 落库 true;缺省 false
  assert.equal(once.payload.runOnce, true)
  assert.equal(shellJob.payload.runOnce, false)
  // When 非法会话模式
  const badMode = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 's2', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { mode: 'orphan' },
  })
  // Then 400
  assert.equal(badMode.status, 400)
  // When 宿主声明的预设 id 不在目录形态白名单内(大写/下划线)
  const oddPreset = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 's3', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { agentPreset: 'Coder_X' },
  })
  // Then 照原样受理:预设 id 由宿主定义,任务写入不校验其形态
  assert.equal(oddPreset.status, 200)
  assert.equal(oddPreset.payload.session.agentPreset, 'Coder_X')
})

test('jobs 路由:会话任务 model 字段归一与校验(跟随默认=缺省)', async (t) => {
  const { store, api } = await makeApi(t)
  // When 指定 provider+model+effort(带空白)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'm1', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { mode: 'fresh', model: { provider: ' deepseek ', model: ' deepseek-chat ', reasoningEffort: ' high ' } },
  })
  // Then trim 后落库,形态合法
  assert.equal(created.status, 200)
  assert.deepEqual(created.payload.session.model, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  // When model 空对象 = 未指定(跟随宿主默认,字段删除)
  const empty = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'm2', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { mode: 'fresh', model: { provider: '  ', model: '' } },
  })
  assert.equal(empty.status, 200)
  assert.equal(empty.payload.session.model, undefined)
  // When model 缺失(旧任务形态)
  const legacy = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'm3', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { mode: 'fresh' },
  })
  assert.equal(legacy.status, 200)
  assert.equal(legacy.payload.session.model, undefined)
  // When provider 或 model 非字符串/为空字符串(指定形态残缺)
  for (const [name, model] of [['m4', { provider: 123, model: 'm' }], ['m5', { provider: 'p' }], ['m6', { provider: '', model: 'm' }]]) {
    const bad = await call(api, 'POST', '/api/cron-board/jobs', {
      name, kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
      session: { mode: 'fresh', model },
    })
    assert.equal(bad.status, 400, name)
    assert.match(bad.payload.error, /模型指定不合法/)
  }
  // When reasoningEffort 非字符串
  const badEffort = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'm7', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { mode: 'fresh', model: { provider: 'p', model: 'm', reasoningEffort: 9 } },
  })
  assert.equal(badEffort.status, 400)
  assert.match(badEffort.payload.error, /模型指定不合法/)
})

test('agent-presets 路由:目录来自宿主服务,缺失降级空目录', async (t) => {
  // Given 宿主 agentPresets 服务返回混合形态列表
  const service = {
    defaultId: 'deepseek',
    list: async () => [
      { id: 'deepseek', name: 'DeepSeek 默认' },
      { id: 'coder' },
      'broken-str',
      { id: 'Bad_Id' },
      { id: 'dup' },
      { id: 'dup', name: '重复项' },
      { id: 'damaged', broken: true },
    ],
  }
  const { api } = await makeApi(t, { getAgentPresets: () => service })
  // When 拉取目录
  const listed = await call(api, 'GET', '/api/cron-board/agent-presets')
  // Then 空 id/重复/损坏项剔除,字符串条目按 {id,label:id} 接受(dsh-im catalogItem 同构),
  // 形态特殊的宿主 id 照实展示(与任务写入口径一致)
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.payload.items, [
    { id: 'deepseek', label: 'DeepSeek 默认' },
    { id: 'coder', label: 'coder' },
    { id: 'broken-str', label: 'broken-str' },
    { id: 'Bad_Id', label: 'Bad_Id' },
    { id: 'dup', label: 'dup' },
  ])
  // When 服务缺失
  const bare = await makeApi(t, { getAgentPresets: () => null })
  const empty = await call(bare.api, 'GET', '/api/cron-board/agent-presets')
  // Then 空目录 200(前端仅「跟随宿主默认」)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.payload, { items: [] })
  // When 服务异常
  const throwing = await makeApi(t, { getAgentPresets: () => ({ list: async () => { throw new Error('boom') } }) })
  const failed = await call(throwing.api, 'GET', '/api/cron-board/agent-presets')
  // Then 仍空目录 200
  assert.equal(failed.status, 200)
  assert.deepEqual(failed.payload, { items: [] })
})

test('model-catalog 路由:宿主目录归一,缺失与异常降级空目录', async (t) => {
  // Given 宿主 sessionController.modelCatalog 返回官方形态
  const catalog = {
    default: { provider: 'deepseek-account', model: 'deepseek-chat' },
    routableProviders: ['deepseek-account', 'custom'],
    groups: [
      { id: 'deepseek-account', name: 'DeepSeek', models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } },
      ] },
      { id: 'custom', name: 'Custom', models: [] },
    ],
    failures: [{ id: 'broken', name: 'Broken', message: '凭据未配置' }],
  }
  const { api } = await makeApi(t, { getSessionController: () => ({ modelCatalog: async () => catalog }) })
  // When 拉取
  const res = await call(api, 'GET', '/api/cron-board/model-catalog')
  // Then 只保留有模型的组,模型带 efforts,default 透传,failures 原样
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, {
    default: { provider: 'deepseek-account', model: 'deepseek-chat' },
    items: [
      { provider: 'deepseek-account', name: 'DeepSeek', models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', efforts: [] },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' },
      ] },
    ],
    failures: [{ id: 'broken', name: 'Broken', message: '凭据未配置' }],
  })
  // When 服务缺失
  const bare = await makeApi(t, { getSessionController: () => undefined })
  const empty = await call(bare.api, 'GET', '/api/cron-board/model-catalog')
  // Then 空目录 200
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.payload, { default: null, items: [], failures: [] })
  // When 服务异常
  const throwing = await makeApi(t, { getSessionController: () => ({ modelCatalog: async () => { throw new Error('boom') } }) })
  const failed = await call(throwing.api, 'GET', '/api/cron-board/model-catalog')
  assert.equal(failed.status, 200)
  assert.deepEqual(failed.payload, { default: null, items: [], failures: [] })
})

test('jobs 路由:会话服务缺失时建/改会话任务 400,脚本任务不受限', async (t) => {
  // Given 宿主无 sessionController(等价 0.1.1-rc.2)且告警回调被记录
  const reported = []
  const { api } = await makeApi(t, { getSessionController: () => undefined, reportSessionMissing: () => reported.push(1) })
  // When 建会话任务
  const sess = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'sv', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
  })
  // Then 400 中文文案,缺失告警上报
  assert.equal(sess.status, 400)
  assert.match(sess.payload.error, /会话任务通道不可用/)
  assert.deepEqual(reported, [1])
  // When 建脚本任务
  const shell = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'sh', kind: 'shell', command: 'echo x', schedule: '* * * * *', enabled: true,
  })
  // Then 不受会话通道影响
  assert.equal(shell.status, 200)
  // When 把已有脚本任务改成会话任务
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + shell.payload.id, {
    kind: 'session', prompt: 'x',
  })
  // Then 同一闸门拦截
  assert.equal(patched.status, 400)
  assert.match(patched.payload.error, /会话任务通道不可用/)
})

test('jobs 路由:服务缺失期既有会话任务的停用/改名照旧可用', async (t) => {
  // Given 服务在场时建好的会话任务,随后服务下线(宿主卸载 / HMR 窗口 / 旧宿主切换)
  let controller = { create: async () => ({ sessionId: 's-1' }), prompt: async () => ({ accepted: true }) }
  const { api } = await makeApi(t, { getSessionController: () => controller })
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'sv', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
  })
  assert.equal(created.status, 200)
  controller = undefined
  // When 停用开关(客户端开关走同一条 PATCH 写路由)
  const toggled = await call(api, 'PATCH', '/api/cron-board/jobs/' + created.payload.id, { enabled: false })
  // Then 不受会话通道影响
  assert.equal(toggled.status, 200)
  assert.equal(toggled.payload.enabled, false)
  // When 改名
  const renamed = await call(api, 'PATCH', '/api/cron-board/jobs/' + created.payload.id, { name: '改名' })
  // Then 同样放行
  assert.equal(renamed.status, 200)
  assert.equal(renamed.payload.name, '改名')
})

test('status 路由:会话通道就绪按请求时刻现算', async (t) => {
  // Given 服务缺失的宿主
  let controller
  const { api } = await makeApi(t, { getSessionController: () => controller })
  // Then 未就绪
  const before = await call(api, 'GET', '/api/cron-board/status')
  assert.deepEqual(before.payload.session, { ready: false })
  // When 宿主晚到挂载服务(慢启动不再永久误判)
  controller = {}
  const after = await call(api, 'GET', '/api/cron-board/status')
  // Then 同一实例即就绪
  assert.deepEqual(after.payload.session, { ready: true })
})

test('cron preview 路由:人话摘要与下三次触发', async (t) => {
  const { api } = await makeApi(t)
  // When 预览「每天 08:30」
  const ok = await call(api, 'POST', '/api/cron-board/cron/preview', { schedule: '30 8 * * *' })
  // Then 摘要含每天与时刻并带宿主时区尾注,三次触发时间戳齐备
  assert.equal(ok.status, 200)
  assert.match(ok.payload.summary, /^每天 08:30\(宿主 UTC[+-]\d/)
  assert.equal(ok.payload.nextAt.length, 3)
  assert.ok(ok.payload.nextAt.every((value) => typeof value === 'number' && value > Date.now()))
  // When 非法表达式
  const bad = await call(api, 'POST', '/api/cron-board/cron/preview', { schedule: 'not-cron' })
  // Then 400 中文报错
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /cron/i)
})

test('jobs 与 preview 路由:时区后缀表达式的调度与校验', async (t) => {
  const { api } = await makeApi(t)
  // Given 带 T+8 后缀的任务
  const created = await call(api, 'POST', '/api/cron-board/jobs', { name: 'tz', kind: 'shell', command: 'x', schedule: '0 9 * * *T+8' })
  assert.equal(created.status, 200)
  // Then 默认触发点按东八区 9:00(01:00Z),与宿主自身时区无关
  assert.equal(new Date(created.payload.nextRunAt).toISOString().slice(11, 16), '01:00')
  // When 非法后缀创建任务
  const bad = await call(api, 'POST', '/api/cron-board/jobs', { name: 'tz2', kind: 'shell', command: 'x', schedule: '0 9 * * *T+15' })
  // Then 400 且报后缀不合法
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /时区后缀不合法/)
  // When 带后缀预览
  const preview = await call(api, 'POST', '/api/cron-board/cron/preview', { schedule: '30 8 * * *T+8' })
  // Then 摘要尾注与触发点均为东八区语义
  assert.equal(preview.status, 200)
  assert.equal(preview.payload.summary, '每天 08:30(UTC+8)')
  assert.equal(new Date(preview.payload.nextAt[0]).toISOString().slice(11, 16), '00:30')
})

test('status 路由:暴露宿主时区偏移 serverTzOffset', async (t) => {
  const { api } = await makeApi(t)
  const res = await call(api, 'GET', '/api/cron-board/status')
  assert.equal(res.status, 200)
  assert.equal(typeof res.payload.serverTzOffset, 'number')
})

test('runs 路由:无参数查全量,带 jobId 查单任务', async (t) => {  // Given 两个任务各有一条运行记录
  const { store, api } = await makeApi(t)
  const j1 = await store.jobs.create({ name: 'j1', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  const j2 = await store.jobs.create({ name: 'j2', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  await store.runs.create({ jobId: j1.id, trigger: 'cron', status: 'success', schedules: ['0 9 * * *T+8', '30 8 * * 1-5T+0'] })
  await store.runs.create({ jobId: j2.id, trigger: 'manual', status: 'success' })
  // When 无参数查全量
  const all = await call(api, 'GET', '/api/cron-board/runs')
  // Then 两条齐全(新记录在前)
  assert.equal(all.status, 200)
  assert.equal(all.payload.items.length, 2)
  assert.equal(all.payload.items[0].trigger, 'manual')
  // When 带 jobId 过滤
  const mine = await call(api, 'GET', '/api/cron-board/runs?jobId=' + j1.id)
  // Then 仅该任务记录
  assert.equal(mine.payload.items.length, 1)
  assert.equal(mine.payload.items[0].jobId, j1.id)
  // Then 命中计划行原文与合并摘要一起返回,手动触发摘要为空
  assert.deepEqual(mine.payload.items[0].schedules, ['0 9 * * *T+8', '30 8 * * 1-5T+0'])
  assert.equal(mine.payload.items[0].scheduleSummary, '每天 09:00(UTC+8) · 工作日 08:30(UTC+0)')
  assert.equal(all.payload.items[0].scheduleSummary, null)
})

test('S1: 看板更改会话执行预设时收回模型写权限', async (t) => {
  const { api, store } = await makeApi(t)
  const original = await store.jobs.create({
    name: '会话夹具', kind: 'session', schedule: '0 9 * * *', enabled: false,
    session: { mode: 'fresh', agentPreset: 'standard' }, createdBySessionId: 'session-fixture',
  })
  const path = '/api/cron-board/jobs/' + original.id
  const renamed = await call(api, 'PATCH', path, { name: '改名' })
  assert.equal(renamed.payload.createdBySessionId, 'session-fixture')
  const changed = await call(api, 'PATCH', path, { session: { mode: 'fresh', agentPreset: 'minimal' } })
  assert.equal(changed.status, 200)
  assert.equal(changed.payload.session.agentPreset, 'minimal')
  assert.equal(store.jobs.get(original.id).createdBySessionId, undefined)
})

test('S1: 只看板改任务模型不收回模型写权(投递范围未变)', async (t) => {
  const { api, store } = await makeApi(t)
  const original = await store.jobs.create({
    name: '会话夹具', kind: 'session', schedule: '0 9 * * *', enabled: false,
    session: { mode: 'fresh', agentPreset: 'standard' }, createdBySessionId: 'session-fixture',
  })
  const path = '/api/cron-board/jobs/' + original.id
  const moved = await call(api, 'PATCH', path, { session: { mode: 'fresh', agentPreset: 'standard', model: { provider: 'p', model: 'm' } } })
  assert.equal(moved.status, 200)
  // 模型选择不影响投递目标,来源会话保留
  assert.equal(store.jobs.get(original.id).createdBySessionId, 'session-fixture')
  // 改目录仍收回
  const escaped = await call(api, 'PATCH', path, { workdir: '/other' })
  assert.equal(escaped.status, 200)
  assert.equal(store.jobs.get(original.id).createdBySessionId, undefined)
})

test('jobs 路由:PATCH 只认显式字段,他处变更不被旧快照回滚', async (t) => {
  // Given 编辑期间任务被别处停用(自动禁用/开关/状态回填)
  const { store, api } = await makeApi(t)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '原名', kind: 'shell', command: 'echo x', schedule: '0 9 * * *', enabled: true, concurrency: 3,
  })
  const jobId = created.payload.id
  await store.jobs.update(jobId, { enabled: false, nextRunAt: 1750000000000 })
  // When 编辑器只提交 dirty 字段(不带 enabled/concurrency/command)
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, { name: '改名' })
  // Then 改名生效,停用与并发上限保持别处写入的现状
  assert.equal(patched.status, 200)
  assert.equal(patched.payload.name, '改名')
  assert.equal(patched.payload.enabled, false)
  assert.equal(patched.payload.concurrency, 3)
  // 未携带 schedule 的局部更新不得推进 nextRunAt(否则临近的待触发运行被推走)
  assert.equal(store.jobs.get(jobId).nextRunAt, 1750000000000)
})

test('jobs 路由:PATCH 携带过期 updatedAt 冲突 409 且不落库', async (t) => {
  // Given 客户端打开编辑器时拿到的行版本
  const { store, api } = await makeApi(t)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '并发', kind: 'shell', command: 'echo x', schedule: '0 9 * * *', enabled: true,
  })
  const jobId = created.payload.id
  const staleAt = created.payload.updatedAt
  // When 他处已改(时间戳需可区分,避免同毫秒写入使锁失效)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await store.jobs.update(jobId, { enabled: false })
  assert.notEqual(store.jobs.get(jobId).updatedAt, staleAt, '他处写入必须推进 updatedAt')
  const conflict = await call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, { name: '覆盖', updatedAt: staleAt })
  // Then 409 且未落库
  assert.equal(conflict.status, 409)
  assert.match(conflict.payload.error, /已被其他操作修改/)
  assert.equal(store.jobs.get(jobId).name, '并发')
  // When 携带当前版本重试
  const fresh = await call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, {
    name: '覆盖', updatedAt: store.jobs.get(jobId).updatedAt,
  })
  // Then 受理
  assert.equal(fresh.status, 200)
  assert.equal(fresh.payload.name, '覆盖')
})

test('jobs 路由:并发两个 PATCH 携带同一基线,仅一个成功另一个 409(CAS)', async (t) => {
  // Given 客户端 A/B 同时打开编辑器拿到同一 updatedAt
  const { store, api } = await makeApi(t)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '并发', kind: 'shell', command: 'echo x', schedule: '0 9 * * *', enabled: true,
  })
  const jobId = created.payload.id
  const baseline = created.payload.updatedAt
  // When 两个 PATCH 同时到达(比较与写入若分离会双 200 后写覆盖先写)
  const [first, second] = await Promise.all([
    call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, { name: 'A', updatedAt: baseline }),
    call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, { name: 'B', updatedAt: baseline }),
  ])
  // Then 恰一个 200、一个 409,库内名字属于成功方
  assert.deepEqual([first.status, second.status].sort(), [200, 409])
  const winner = first.status === 200 ? 'A' : 'B'
  assert.equal(store.jobs.get(jobId).name, winner)
})

test('jobs 路由:运行回填(nextRunAt/lastStatus)后旧基线编辑仍受理', async (t) => {
  // Given 编辑器打开后调度器推进了 nextRunAt/状态回填
  const { store, api } = await makeApi(t)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '回填', kind: 'shell', command: 'echo x', schedule: '0 9 * * *', enabled: true,
  })
  const jobId = created.payload.id
  const baseline = created.payload.updatedAt
  await store.jobs.updateRuntime(jobId, { nextRunAt: 1750000000000, lastRunAt: 1750000000000, lastStatus: 'success' })
  // When 保存改名仍使用打开时的 updatedAt
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + jobId, { name: '改名', updatedAt: baseline })
  // Then 不被运行态变化误判 409
  assert.equal(patched.status, 200)
  assert.equal(patched.payload.name, '改名')
  // Then 运行期字段未被旧快照覆盖
  assert.equal(store.jobs.get(jobId).nextRunAt, 1750000000000)
  assert.equal(store.jobs.get(jobId).lastStatus, 'success')
})

test('jobs 路由:concurrency 显式 null 清空键(表达不限并发)', async (t) => {
  const { store, api } = await makeApi(t)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '清并发', kind: 'shell', command: 'x', schedule: '* * * * *', concurrency: 3,
  })
  assert.equal(created.payload.concurrency, 3)
  // When 客户端把并发输入清空(提交 null)
  const cleared = await call(api, 'PATCH', '/api/cron-board/jobs/' + created.payload.id, { concurrency: null })
  // Then 键真删(不是残留 undefined 的幽灵键)
  assert.equal(cleared.status, 200)
  assert.equal('concurrency' in cleared.payload, false)
  assert.equal('concurrency' in store.jobs.get(created.payload.id), false)
})

test('envs 路由:导入走单次集合写,不再逐行 create/remove(半导入不可回滚)', async (t) => {
  // Given 已有集合与逐行写计数器
  const { store, api } = await makeApi(t)
  await store.envs.create({ name: 'OLD', value: 'x', remarks: '', enabled: true })
  let rowWrites = 0
  const rawCreate = store.envs.create.bind(store.envs)
  const rawRemove = store.envs.remove.bind(store.envs)
  store.envs.create = (...args) => { rowWrites += 1; return rawCreate(...args) }
  store.envs.remove = (...args) => { rowWrites += 1; return rawRemove(...args) }
  const text = Array.from({ length: 5 }, (_, index) => 'K' + index + '=' + index).join('\n') + '\n'
  // When 覆盖导入 5 行
  const committed = await call(api, 'POST', '/api/cron-board/envs/import', { text, apply: true, overwrite: true })
  store.envs.create = rawCreate
  store.envs.remove = rawRemove
  // Then 一次集合写完成清空 + 全部追加
  assert.equal(committed.status, 200)
  assert.equal(committed.payload.imported, 5)
  assert.equal(rowWrites, 0, '导入不得逐行写(原先 N 行 2N 次写)')
  assert.deepEqual(store.envs.list().map((row) => row.name), ['K0', 'K1', 'K2', 'K3', 'K4'])
})

test('runs 路由:日志默认只回尾部窗口,truncated 标记与 tail=all 全文', async (t) => {
  const { store, api, logger } = await makeApi(t)
  const job = await store.jobs.create({ name: 'log', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  const record = await store.runs.create({ jobId: job.id, trigger: 'manual', status: 'success' })
  const total = DEFAULT_LOG_TAIL_LINES + 5
  const lines = Array.from({ length: total }, (_, index) => 'L' + index)
  const lineCount = (text) => text.split('\n').filter(Boolean).length
  // Given 一份超过缺省窗口的日志
  await logger.append(job.id, record.runId, lines.join('\n') + '\n')
  // When 缺省 GET(不带 tail)
  const def = await call(api, 'GET', '/api/cron-board/runs/' + record.runId + '/log')
  // Then 只回最后 DEFAULT_LOG_TAIL_LINES 行,并标记截断与窗口行数
  assert.equal(def.status, 200)
  assert.equal(lineCount(def.payload.text), DEFAULT_LOG_TAIL_LINES)
  assert.ok(def.payload.text.startsWith('L5\n'), '缺省窗口必须从截断后的首行开始')
  assert.equal(def.payload.truncated, true)
  assert.equal(def.payload.tailLines, DEFAULT_LOG_TAIL_LINES)
  // When 显式窗口
  const small = await call(api, 'GET', '/api/cron-board/runs/' + record.runId + '/log?tail=5')
  assert.equal(lineCount(small.payload.text), 5)
  assert.equal(small.payload.truncated, true)
  // When 显式全文(导出用)
  const full = await call(api, 'GET', '/api/cron-board/runs/' + record.runId + '/log?tail=all')
  assert.equal(lineCount(full.payload.text), total)
  assert.equal(full.payload.truncated, false)
  assert.equal(full.payload.tailLines, null)
  // When 短日志走缺省窗口
  const short = await store.runs.create({ jobId: job.id, trigger: 'manual', status: 'success' })
  await logger.append(job.id, short.runId, 'only\n')
  const shortRes = await call(api, 'GET', '/api/cron-board/runs/' + short.runId + '/log')
  // Then 未截断
  assert.equal(shortRes.payload.text, 'only\n')
  assert.equal(shortRes.payload.truncated, false)
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

// 收敛守卫:悬挂型缺陷必须在测试里变成红,不能靠测试超时兜底
function settlesWithin(promise, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('处理链未在 ' + ms + 'ms 内收敛(悬挂)')), ms)
    promise.then(
      () => { clearTimeout(timer); resolve() },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

test('M3-1: 请求体读到一半客户端断开(aborted/close)以 400 收敛,不悬挂且监听清空', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 一个只读了一半请求体就断开的请求(客户端 socket 已消失,不会再有任何事件)
  const disconnected = async (emitBreak) => {
    const res = { status: null }
    res.writeHead = (status) => { res.status = status }
    res.end = (text) => { res.raw = text }
    const req = new EventEmitter()
    req.method = 'POST'
    req.complete = false
    req.headers = { host: 'localhost:3000', 'content-type': 'application/json', 'content-length': String(4 * 1024) }
    req.url = 'http://localhost/api/cron-board/jobs'
    const handling = api.handle(req, res)
    process.nextTick(() => {
      req.emit('data', Buffer.from('{"name":"half'))
      emitBreak(req)
    })
    await settlesWithin(handling)
    return { req, res }
  }
  // When 只发 aborted(连接被中断;运行时未把该中断升级成 req error 的情形)
  const aborted = await disconnected((req) => req.emit('aborted'))
  // Then 400 且归因为读取中断,不是非法 JSON,也不得悬挂
  assert.equal(aborted.res.status, 400)
  assert.deepEqual(JSON.parse(aborted.res.raw), { error: '请求体读取中断' })
  // And 监听清空
  assert.equal(aborted.req.listenerCount('data'), 0)
  assert.equal(aborted.req.listenerCount('end'), 0)
  assert.equal(aborted.req.listenerCount('error'), 0)
  assert.equal(aborted.req.listenerCount('aborted'), 0)
  assert.equal(aborted.req.listenerCount('close'), 0)
  // When 只发 close(complete=false,请求体未读完)
  const closed = await disconnected((req) => req.emit('close'))
  // Then 同样是 400 收敛
  assert.equal(closed.res.status, 400)
  assert.deepEqual(JSON.parse(closed.res.raw), { error: '请求体读取中断' })
  assert.equal(store.jobs.list().length, 0)
})

// 预占窗口夹具:把 runs.create 挂起,直到测试显式放行(复现 DELETE 与 dispatch 并发)
function suspendRunCreate(store) {
  const rawCreate = store.runs.create.bind(store.runs)
  let release
  let markEntered
  const entered = new Promise((resolve) => { markEntered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  store.runs.create = async (data) => {
    markEntered()
    await gate
    return rawCreate(data)
  }
  return {
    entered,
    release,
    restore: () => { store.runs.create = rawCreate },
  }
}

test('E2: 删除窗口内手动运行以 409 拒绝,运行记录不落库(无孤儿 run)', async (t) => {
  // Given 一个任务,预占记录被挂在 create 的 await 内
  const { store, api } = await makeApi(t)
  const job = await store.jobs.create({
    name: '窗口', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000,
  })
  const suspended = suspendRunCreate(store)
  // When 运行请求先进入预占窗口,删除在同一窗口内完成
  const dispatching = call(api, 'POST', '/api/cron-board/jobs/' + job.id + '/run')
  await suspended.entered
  const del = await call(api, 'DELETE', '/api/cron-board/jobs/' + job.id)
  suspended.release()
  const runRes = await dispatching
  suspended.restore()
  // Then 删除成功;运行请求明确 409(旧实现回 200 + runId,留下 jobId 已不存在的 queued→cancelled 行)
  assert.equal(del.status, 200)
  assert.equal(runRes.status, 409)
  assert.match(runRes.payload.error, /删除中|不存在/)
  assert.deepEqual(store.runs.list(job.id), [])
})

test('E3: 删除持久化失败后解除「删除中」拒绝态,任务仍可运行', async (t) => {
  const { store, api } = await makeApi(t)
  const job = await store.jobs.create({
    name: '写失败', kind: 'shell', command: `${process.execPath} -e ""`,
    schedule: '* * * * *', enabled: true, timeoutMs: 10 * 1000,
  })
  // Given 删除持久化失败(集合损坏/磁盘满同形态)
  const rawRemove = store.jobs.remove.bind(store.jobs)
  store.jobs.remove = async () => { throw new Error('数据文件已损坏已备份,已暂停写入以防数据丢失') }
  const del = await call(api, 'DELETE', '/api/cron-board/jobs/' + job.id)
  store.jobs.remove = rawRemove
  // Then 删除失败且任务保留
  assert.equal(del.status, 400)
  assert.ok(store.jobs.get(job.id), '任务不得在地面失败时消失')
  // Then 拒绝态已释放:紧接着运行照常受理并执行(旧实现恒 400「任务删除中」直到重启)
  const runRes = await call(api, 'POST', '/api/cron-board/jobs/' + job.id + '/run')
  assert.equal(runRes.status, 200)
  await waitFor(() => store.runs.list(job.id).some((row) => row.status === 'success'))
})

test('E3: 日志目录清理失败不翻案删除成败(任务行已删即回 ok)', async (t) => {
  // Given 一个删除成功后清日志必失败的 logger(任务行移除与日志清理是两个面)
  const brokenLogger = {
    append: async () => {},
    clear: async () => {},
    prune: async () => {},
    removeJob: async () => { throw new Error('EBUSY: 目录被占用') },
  }
  const { store, api } = await makeApi(t, { logger: brokenLogger })
  const job = await store.jobs.create({ name: '日志残留', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  // When 删除
  const del = await call(api, 'DELETE', '/api/cron-board/jobs/' + job.id)
  // Then 任务已删除即回 ok:再删只会 400「任务不存在」,不能把收尾失败翻成删除失败
  assert.equal(del.status, 200)
  assert.deepEqual(del.payload, { ok: true })
  assert.equal(store.jobs.get(job.id), undefined)
})

test('多计划:POST 落库按行归一,摘要合并,nextRunAt 取最早触发', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 两条不同时区的表达式(含空行与重复行)
  const schedule = ' 0 9 * * *T+8 \n\n0 9 * * *T+8\n0 1 * * *T-8\n'
  // When 新建任务
  const created = await call(api, 'POST', '/api/cron-board/jobs', { name: '多计划', kind: 'shell', command: 'x', schedule })
  // Then 落库文本归一(去空白/空行/重复行)
  assert.equal(created.status, 200)
  assert.equal(created.payload.schedule, '0 9 * * *T+8\n0 1 * * *T-8')
  // Then nextRunAt 取两条中最先到期的一次
  const from = new Date()
  const expected = Math.min(nextRunAtOf('0 9 * * *T+8', from), nextRunAtOf('0 1 * * *T-8', from))
  assert.equal(created.payload.nextRunAt, expected)
  // Then 列表摘要把两条计划都展开
  const listed = await call(api, 'GET', '/api/cron-board/jobs')
  const row = listed.payload.items.find((item) => item.id === created.payload.id)
  assert.equal(row.summary, '每天 09:00(UTC+8) · 每天 01:00(UTC-8)')
  assert.equal(store.jobs.get(created.payload.id).schedule.split('\n').length, 2)
})

test('多计划:PATCH 改计划重算最早触发,未改计划不动 nextRunAt', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 单条计划任务
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '改多计划', kind: 'shell', command: 'x', schedule: '0 9 * * *T+0',
  })
  const before = created.payload.nextRunAt
  // When 只改名(不带 schedule)
  const renamed = await call(api, 'PATCH', '/api/cron-board/jobs/' + created.payload.id, { name: '改名', updatedAt: created.payload.updatedAt })
  // Then nextRunAt 保持原值,不因局部更新推进
  assert.equal(renamed.status, 200)
  assert.equal(store.jobs.get(created.payload.id).nextRunAt, before)
  // When 改成两条计划
  const patched = await call(api, 'PATCH', '/api/cron-board/jobs/' + created.payload.id, {
    schedule: '0 9 * * *T+0\n30 8 1 * *',
    updatedAt: renamed.payload.updatedAt,
  })
  // Then 触发点按两条重新取最早
  assert.equal(patched.status, 200)
  const from = new Date()
  const expected = Math.min(nextRunAtOf('30 8 1 * *', from), nextRunAtOf('0 9 * * *T+0', from))
  assert.equal(store.jobs.get(created.payload.id).nextRunAt, expected)
})

test('多计划:任一条非法或永不触发即整份计划 400', async (t) => {
  const { store, api } = await makeApi(t)
  // When 第二条非法表达式
  const bad = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '坏第二条', kind: 'shell', command: 'x', schedule: '0 9 * * *\nnot-a-cron',
  })
  // Then 400 且文案带该行原文
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /cron 表达式不合法: not-a-cron/)
  assert.equal(store.jobs.list().length, 0)
  // When 一条正常一条永不触发
  const impossible = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '混合', kind: 'shell', command: 'x', schedule: '0 9 * * *\n0 0 30 2 *',
  })
  // Then 整份计划拒绝(不静默丢弃无未来触发点的那条)
  assert.equal(impossible.status, 400)
  assert.match(impossible.payload.error, /未来触发点/)
  assert.equal(store.jobs.list().length, 0)
  // When 空计划
  const empty = await call(api, 'POST', '/api/cron-board/jobs', { name: '空', kind: 'shell', command: 'x', schedule: ' \n ' })
  // Then 400
  assert.equal(empty.status, 400)
  assert.match(empty.payload.error, /调度计划不能为空/)
})

test('多计划:超过上限的计划整份 400', async (t) => {
  const { store, api } = await makeApi(t)
  // Given 上限 + 1 条互不重复的合法表达式
  const lines = Array.from({ length: MAX_SCHEDULES + 1 }, (_, index) => index + ' 9 * * *')
  // When 新建
  const res = await call(api, 'POST', '/api/cron-board/jobs', { name: '超限', kind: 'shell', command: 'x', schedule: lines.join('\n') })
  // Then 400 且提示上限,不落库
  assert.equal(res.status, 400)
  assert.match(res.payload.error, new RegExp('最多 ' + MAX_SCHEDULES + ' 条'))
  assert.equal(store.jobs.list().length, 0)
})

test('多计划:cron preview 对重复表达式去重(表单按表达式匹配行)', async (t) => {
  const { api } = await makeApi(t)
  // When 同一条表达式写两行
  const res = await call(api, 'POST', '/api/cron-board/cron/preview', {
    schedule: '0 9 * * *T+8\n0 9 * * *T+8',
  })
  // Then items 去重为一条(重复行不产生额外触发点),合并不重复
  assert.equal(res.status, 200)
  assert.equal(res.payload.items.length, 1)
  assert.equal(res.payload.summary, '每天 09:00(UTC+8)')
})

test('多计划:cron preview 返回逐条摘要与合并触发点', async (t) => {
  const { api } = await makeApi(t)
  // When 预览两条表达式
  const res = await call(api, 'POST', '/api/cron-board/cron/preview', {
    schedule: '0 9 * * *T+8\n30 8 * * 1-5T+0',
  })
  // Then 逐条给出摘要与三次触发点,顺序与计划行一致
  assert.equal(res.status, 200)
  assert.equal(res.payload.items.length, 2)
  assert.equal(res.payload.items[0].summary, '每天 09:00(UTC+8)')
  assert.equal(res.payload.items[1].summary, '工作日 08:30(UTC+0)')
  assert.equal(res.payload.items[0].nextAt.length, 3)
  // Then 合并摘要与合并触发点(升序、去重)同口径
  assert.equal(res.payload.summary, '每天 09:00(UTC+8) · 工作日 08:30(UTC+0)')
  assert.equal(res.payload.nextAt.length, 3)
  assert.deepEqual([...res.payload.nextAt].sort((a, b) => a - b), res.payload.nextAt)
  // Then 单条表达式同样返回 items(表单按行对齐读取)
  const single = await call(api, 'POST', '/api/cron-board/cron/preview', { schedule: '0 9 * * *T+0' })
  assert.equal(single.payload.items.length, 1)
  assert.equal(single.payload.items[0].schedule, '0 9 * * *T+0')
})
