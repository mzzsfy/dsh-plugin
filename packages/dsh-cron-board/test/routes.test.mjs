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
import { createExecutor } from '../src/executor.mjs'
import { createApi } from '../src/api.mjs'

async function makeApi(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-api-'))
  const store = await createStore({ dir: join(dir, 'data') })
  // 清理前等写链排空:终态只保证内存可见,收尾写(任务卡回填、日志裁剪)提交晚于 flush,
  // rmdir 与其赛跑会 ENOTEMPTY;retries 吸收(镜像 executor/scheduler 测试同款参数)
  t.after(async () => {
    await store.flush()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, readMaxConcurrent: () => 2 })
  const api = createApi({ store, logger, executor, ...overrides })
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
  assert.deepEqual(res.payload.ui, { sidebarTab: false })
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
  // Given 写入桩记录补丁,读取桩翻转返回(模拟 settings.update 后生效)
  let stored = false
  const { api } = await makeApi(t, {
    updateUiSettings: (patch) => { if (typeof patch.sidebarTab === 'boolean') stored = patch.sidebarTab },
    readSidebarTab: () => stored,
  })
  // When POST 开关开
  const res = await call(api, 'POST', '/api/cron-board/ui-settings', { sidebarTab: true })
  // Then ok 且回读 true;写桩收到布尔补丁
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.ui.sidebarTab, true)
  assert.equal(stored, true)
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

test('jobs 路由:会话任务字段校验与默认值', async (t) => {
  const { store, api } = await makeApi(t)
  // When 建 pinned 会话任务(携带已废弃的窗口字段)
  const created = await call(api, 'POST', '/api/cron-board/jobs', {
    name: '日报', kind: 'session', prompt: '写日报',
    schedule: '0 9 * * *', enabled: true, timeoutMs: 60 * 1000,
    session: { mode: 'pinned', pinnedSessionId: ' s-9 ', windowStart: '09:00', windowEnd: '23:00', onMiss: 'defer' },
  })
  // Then 会话子对象仅落合法字段(窗口三字段已随功能删除,不再产出),id 已裁剪
  assert.equal(created.status, 200)
  assert.deepEqual(created.payload.session, { mode: 'pinned', pinnedSessionId: 's-9' })
  assert.equal(created.payload.timeoutMs, undefined)
  // When shell 任务不带 session 字段
  const shellJob = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 's1', kind: 'shell', command: 'echo x', schedule: '* * * * *', enabled: true, timeoutMs: 1000,
  })
  // Then session 字段缺省,shell 保留显式超时
  assert.equal(shellJob.payload.session, undefined)
  assert.equal(shellJob.payload.timeoutMs, 1000)
  // When 非法会话模式
  const badMode = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 's2', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
    session: { mode: 'orphan' },
  })
  // Then 400
  assert.equal(badMode.status, 400)
})

test('jobs 路由:会话通道禁用时建会话任务 400,脚本任务不受限', async (t) => {
  // Given sessionState.disabled(等价 0.1.1-rc.2 超时禁用态)
  const sessionState = { ready: false, disabled: true }
  const { api } = await makeApi(t, { sessionState })
  const sess = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'sv', kind: 'session', prompt: 'x', schedule: '* * * * *', enabled: true,
  })
  assert.equal(sess.status, 400)
  assert.match(sess.payload.error, /会话任务通道已禁用/)
  const shell = await call(api, 'POST', '/api/cron-board/jobs', {
    name: 'sh', kind: 'shell', command: 'echo x', schedule: '* * * * *', enabled: true,
  })
  assert.equal(shell.status, 200)
})

test('status 路由:透出会话通道就绪状态', async (t) => {
  const sessionState = { ready: true, disabled: false }
  const { api } = await makeApi(t, { sessionState })
  const res = await call(api, 'GET', '/api/cron-board/status')
  assert.deepEqual(res.payload.session, { ready: true, disabled: false })
})

test('cron preview 路由:人话摘要与下三次触发', async (t) => {
  const { api } = await makeApi(t)
  // When 预览「每天 08:30」
  const ok = await call(api, 'POST', '/api/cron-board/cron/preview', { schedule: '30 8 * * *' })
  // Then 摘要含每天与时刻,三次触发时间戳齐备
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.summary, '每天 08:30')
  assert.equal(ok.payload.nextAt.length, 3)
  assert.ok(ok.payload.nextAt.every((value) => typeof value === 'number' && value > Date.now()))
  // When 非法表达式
  const bad = await call(api, 'POST', '/api/cron-board/cron/preview', { schedule: 'not-cron' })
  // Then 400 中文报错
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /cron/i)
})

test('runs 路由:无参数查全量,带 jobId 查单任务', async (t) => {
  // Given 两个任务各有一条运行记录
  const { store, api } = await makeApi(t)
  const j1 = await store.jobs.create({ name: 'j1', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  const j2 = await store.jobs.create({ name: 'j2', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  await store.runs.create({ jobId: j1.id, trigger: 'cron', status: 'success' })
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
