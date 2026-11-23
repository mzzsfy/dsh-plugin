// host 路由集成测试:stub 宿主 ctx 后经 apply 挂载,直接调用捕获的 handler。
// 覆盖:方法守卫 405、跨源守卫 403、各路由业务分支(400/409/500)、
// restart 硬退出、readBody 超限。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { EventEmitter } from 'node:events'

import { apply, BODY_MAX_BYTES, Config, DEFAULT_CHANNEL, DEFAULT_POLL_INTERVAL_SEC, DEFAULT_REGISTRY_BASE, RESTART_DELAY_MS, RESTART_EXIT_CODE, RELEASE_NOTES_CACHE_MAX, collectActiveWork, discoverRunningInstall } from '../src/index.js'
import { saveManagedState } from '../src/managed-state.mjs'
import { performManagedUpgrade } from '../src/managed-upgrade.mjs'
import { runPreflight } from '../src/preflight.mjs'
import { activateInstallation, createLayout, writeEntry } from '../src/managed-layout.mjs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const TEST_RUNTIME_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const TEST_GATE_ROOT = await mkdtemp(join(tmpdir(), 'maintain-route-gates-'))
const TEST_PROFILE_DIR = join(TEST_GATE_ROOT, 'profiles', 'web')
await mkdir(TEST_PROFILE_DIR, { recursive: true })
const TEST_PROFILE_ID = await realpath(TEST_PROFILE_DIR)
after(() => rm(TEST_GATE_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))

// 受管安装桩:测试进程 argv[1] 不是 DSH 包,真实发现必失败;全部用例注入可用桩,
// 失败面由 discoverRunningInstall 自身的专项用例覆盖
const RUNNING_INSTALL = {
  prefix: 'C:/fake-prefix',
  originalPackage: 'C:/fake-prefix/node_modules/@deepseek-ai/dsh',
  runningVersion: '0.1.1',
  error: null,
}

// 受管升级 runner 桩:记录入参并返回可控结果/异常,禁止测试触发真实 npm
function makeRunnerStub(overrides = {}) {
  const calls = []
  const stub = Object.assign((input) => {
    calls.push(input)
    return typeof overrides.result === 'function' ? overrides.result(input) : Promise.resolve({ operationId: 'op-1', switched: true, phase: 'awaiting-restart', slot: 'a', targetVersion: input.targetVersion })
  }, overrides)
  stub.calls = calls
  return stub
}

// 全局 fetch 拦截:core.fetchDistTags 默认绑定全局 fetch,测试期返回与 dist-tags.test
// 同形的流式响应(tags 就绪),防止启动检查/refresh 触发真实网络请求
const MOCK_TAGS = { latest: '9.9.9', next: '10.0.0' }

// 与文件顶部全局 fetch 拦截同形的流式响应体
function tagsBody(tags) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        const chunks = [new TextEncoder().encode(JSON.stringify(tags))]
        return {
          read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
          cancel: async () => {},
        }
      },
    },
  }
}

globalThis.fetch = async () => tagsBody(MOCK_TAGS)

// exits:退出证据收集器,经 dependencies.exitHost 注入——调度退出只记录,不真杀测试进程
function makeCtx({ settingsStore, settingsAvailable = true, legacySettings = false, configEditorAvailable = true, timerAvailable = true, services = {}, dependencies = {}, installAnchor = TEST_RUNTIME_MANIFEST, hostVersionProbeAvailable = true, home, profileName = 'web', profileDir = TEST_PROFILE_DIR, exits = [], applyPlugin = apply } = {}) {
  const routes = new Map()
  let tick = null
  // 条目配置桩:settingsStore 对象即 apply 入参 config(0.1.7 形态的宿主解析配置);
  // configEditor 桩经 change 合并后原样写回,模拟 loader 仅 volatile 变化的原地热更。
  // legacy 形态下 settingsStore 别名 settings 命名空间存储,config 为空对象
  const config = legacySettings ? {} : (settingsStore ?? {})
  const legacyStore = legacySettings ? (settingsStore ?? {}) : {}
  const calls = { exits: [], registered: [], disposers: [], editCalls: [], configureCalls: [], registerCalls: [], hooks: [] }
  const settingsService = {
    configure(presentation, owner) {
      calls.configureCalls.push({ presentation, owner })
      return () => {}
    },
  }
  if (legacySettings) {
    // legacy(≤0.1.6)settings 服务方法面:register 声明命名空间,get/update 命名空间语义
    settingsService.register = (ns, schema) => {
      calls.registerCalls.push({ ns, schema })
    }
    settingsService.get = (ns) => legacyStore
    settingsService.update = async (ns, patch) => {
      Object.assign(legacyStore, patch)
    }
  }
  const configEditor = {
    async edit(entry, change) {
      calls.editCalls.push(entry)
      const next = change({ ...config }, {})
      for (const [key, value] of Object.entries(next)) config[key] = value
    },
  }
  const ctx = {
    calls,
    connectionAdmission: undefined,
    // fiber 桩:0.1.7 写路径经 fiber.entry 定位 profile 条目
    fiber: { entry: { options: { id: 'maintain', name: '@mzzsfy/dsh-maintain' } } },
    profileContext: installAnchor === null ? {} : { installAnchor, name: profileName, dir: profileDir, ...(home === undefined ? {} : { home }) },
    // 事件面桩:按事件名收集监听,pre-step hook 另存 agentHook 供既有用例读取
    on(event, listener) {
      const entry = { event, listener }
      calls.hooks.push(entry)
      if (event === 'agent/pre-step') calls.agentHook = entry
      return () => {
        const index = calls.hooks.indexOf(entry)
        if (index >= 0) calls.hooks.splice(index, 1)
        if (calls.agentHook === entry) calls.agentHook = undefined
      }
    },
    get(name) {
      if (name === 'hostVersionProbe') return hostVersionProbeAvailable ? services.hostVersionProbe || (() => '1.0.0') : undefined
      if (name === 'connection') {
        return services.connection ?? {
          requestRejection: () => ctx.connectionAdmission,
        }
      }
      if (name === 'settings') return settingsAvailable ? settingsService : undefined
      if (name === 'configEditor') return configEditorAvailable ? configEditor : undefined
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return undefined
    },
    // effect 桩:执行装配函数并捕获其返回的 disposer,供测试模拟 fiber 停用
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') calls.disposers.push(disposer)
    },
    inject(deps, fn) {
      // timer 服务桩:模拟宿主 timer 激活后的 interval(返回 disposer 同官方契约);
      // timerAvailable=false 模拟服务缺失
      fn({
        settings: settingsAvailable ? settingsService : undefined,
        effect(stubEffect) {
          const disposer = stubEffect()
          if (typeof disposer === 'function') calls.disposers.push(disposer)
        },
        interval: timerAvailable
          ? (intervalFn) => {
              tick = intervalFn
              return () => { if (tick === intervalFn) tick = null }
            }
          : undefined,
      })
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        calls.registered.push(route.path)
      },
    },
    fireTick() {
      if (tick) tick()
    },
    disposeEffects() {
      for (const disposer of calls.disposers) disposer()
    },
  }
  const runningInstall = Object.hasOwn(dependencies, 'runningInstall') ? dependencies.runningInstall
    : { ...RUNNING_INSTALL, prefix: mkdtempSync(join(TEST_GATE_ROOT, 'prefix-')) }
  applyPlugin(ctx, config, { ...dependencies, runningInstall, exitHost: (code) => exits.push(code) })
  return { ctx, routes, config, exits }
}

function makeReq({ method = 'POST', body, headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  // 写路由统一过 withRouteGate 的 JSON content-type 门:测试默认带合法头,
  // 负向用例(缺头/text-plain)单独覆盖
  req.headers = { host: 'localhost:3000', 'content-type': 'application/json', ...headers }
  req.destroy = () => {
    req.destroyed = true
  }
  // 无 body 也须发 end:路由侧读体(如 restart 的 force)对空体解析为空对象
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = { status: null, payload: null }
  res.writeHead = (status) => {
    res.status = status
  }
  res.end = (text) => {
    res.raw = text
    // 宿主闸门路径回纯文本 status,业务路径回 JSON
    try {
      res.payload = text ? JSON.parse(text) : null
    } catch {
      res.payload = null
    }
  }
  return res
}

async function call(routes, path, req) {
  const handler = routes.get(path)
  assert.ok(handler, '路由未注册: ' + path)
  const res = makeRes()
  await handler(req, res)
  return res
}

const post = (routes, path, body, headers) => call(routes, path, makeReq({ method: 'POST', body, headers }))
const get = (routes, path) => call(routes, path, makeReq({ method: 'GET' }))

// 排空微任务链(setImmediate 为宏任务,先于其执行的全部微任务此后必已完成)
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve))
// 真实时间等待:mock timers 域内 setTimeout 不再真实计时,以 setImmediate 自旋让出事件循环
const realSleep = (ms) => new Promise((resolve) => {
  const start = Date.now()
  const spin = () => { if (Date.now() - start >= ms) resolve(); else setImmediate(spin) }
  setImmediate(spin)
})

test('upgrade:启动、状态查询和弹窗预检均不写文件，开始安装后生成救援指南', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'maintain-rescue-guide-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const guidePath = join(root, 'rescue.txt')
  let guideAtInstall
  const runner = makeRunnerStub({ result: async () => {
    guideAtInstall = await readFile(guidePath, 'utf8')
    return { switched: true }
  } })
  const { routes } = makeCtx({ home: root, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.rescueHome, root)
  await assert.rejects(readFile(guidePath, 'utf8'), { code: 'ENOENT' })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const report = await post(routes, '/api/maintain/preflight', { targetVersion: '9.9.9' })
    assert.equal(report.status, 200)
    await assert.rejects(readFile(guidePath, 'utf8'), { code: 'ENOENT' })
  }
  const response = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(response.status, 200)
  assert.equal(response.payload.rescueGuideWritten, true)
  await waitForUpgradeResult(routes)
  const guide = await readFile(guidePath, 'utf8')
  assert.equal(guideAtInstall, guide)
  assert.match(guide, /dsh rescue --from-default-profile web --no-open --port 3081/)
  assert.match(guide, /dsh plugin --profile web remove/)
  assert.match(guide, /独立 profile/)
  assert.match(guide, /不会修复原 profile/)
  assert.ok(guide.includes('\n'), '指南须使用真实换行')
  assert.ok(guide.includes(root))
  assert.match(guide, /默认空数组 \[\].*替换/)
  assert.match(guide, /同一组件若被其他层引入仍可能加载/)
})

test('upgrade:每次开始安装都更新现有救援指南', async (t) => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'maintain-rescue-existing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'rescue.txt')
  await writeFile(file, '上个版本的指南', 'utf8')
  const { routes } = makeCtx({ home: root, profileName: 'Rescue', services: IDLE_SERVICES, dependencies: DEPS() })
  const status = await get(routes, '/api/maintain/status')
  const command = 'dsh dsh-rescue --from-default-profile web --no-open --port 3081'
  assert.equal(status.payload.rescueCommand, command)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(await readFile(file, 'utf8'), '上个版本的指南')
    const response = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
    assert.equal(response.status, 200)
    assert.equal(response.payload.rescueGuideWritten, true)
    assert.ok((await readFile(file, 'utf8')).includes(command))
    await waitForUpgradeResult(routes)
    if (attempt === 0) await writeFile(file, '上个版本的指南', 'utf8')
  }
})

test('upgrade:无法写入救援文件时仍受理安装', async (t) => {
  const { mkdtemp, mkdir, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'maintain-rescue-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'rescue.txt'))
  const runner = makeRunnerStub()
  const { routes } = makeCtx({ home: root, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const response = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(response.status, 200)
  assert.equal(response.payload.rescueGuideWritten, false)
  await waitForUpgradeResult(routes)
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(await readdir(root), ['rescue.txt'])
})

test('upgrade:安装未通过服务端检查时不写救援指南', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'maintain-rescue-preflight-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { routes } = makeCtx({ home: root, services: IDLE_SERVICES, dependencies: DEPS({ runPreflight: async () => { throw new Error('检查异常') } }) })
  const response = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(response.status, 409)
  await assert.rejects(readFile(join(root, 'rescue.txt'), 'utf8'), { code: 'ENOENT' })
})

test('缺失宿主安装锚点时插件仍挂载并以未知版本提供状态', async () => {
  const { routes } = makeCtx({ installAnchor: 'C:/missing-maintain-runtime/package.json', hostVersionProbeAvailable: false })
  assert.ok(await waitSnapshotReady(routes))
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.runningVersion, null)
})

test('宿主清单损坏时插件仍挂载并以未知版本提供状态', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-bad-manifest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = join(root, 'package.json')
  await writeFile(manifest, '{')
  const { routes } = makeCtx({ installAnchor: manifest, hostVersionProbeAvailable: false })
  assert.ok(await waitSnapshotReady(routes))
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.runningVersion, null)
})

test('挂载:13 条路由注册,启动检查后快照就绪', async () => {
  const { ctx, routes } = makeCtx()
  assert.equal(routes.size, 13)
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      '/api/maintain/channel',
      '/api/maintain/plugins',
      '/api/maintain/poll-interval',
      '/api/maintain/preflight',
      '/api/maintain/refresh',
      '/api/maintain/registry-base',
      '/api/maintain/release-notes',
      '/api/maintain/restart',
      '/api/maintain/safe-mode-whitelist',
      '/api/maintain/safe-mode/restore',
      '/api/maintain/status',
      '/api/maintain/upgrade',
      '/api/maintain/upgrade/receipt-ack',
    ],
  )
  // 启动检查是异步链(mock fetch 微任务 + resolveHostVersion 真实文件读),
  // 轮询等快照落定后再断言
  assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
  const res = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
  assert.equal(res.status, 200)
  assert.equal(res.payload.packageName, '@deepseek-ai/dsh')
  assert.equal(res.payload.channel, 'latest')
  assert.deepEqual(res.payload.tags, MOCK_TAGS, '启动检查后 dist-tags 必须就绪')
  assert.equal(res.payload.checkError, null)
  assert.ok(res.payload.checkedAt !== null)
  assert.equal(res.payload.pollRunning, true, 'timer 服务激活时自动轮询应武装')
})

test('Config 导出契约:根级 volatile 包装,validate 产出整节单 ref,默认值对拍 DEFAULT_* 常量', () => {
  const resolved = Config['~standard'].validate({})
  assert.equal(resolved.issues, undefined)
  const value = resolved.value
  assert.equal(typeof value?.get, 'function', '根级 volatile 须产出整节单 ref(get 协议)')
  const section = value.get()
  assert.equal(section.channel, DEFAULT_CHANNEL)
  assert.equal(section.pollIntervalSec, DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(section.registryBase, DEFAULT_REGISTRY_BASE)
  assert.deepEqual(section.safeModeWhitelist, [])
  assert.equal('upgradeCommandTemplate' in section, false, '模板配置字段必须移除')
  const provided = Config['~standard'].validate({ channel: 'next', safeModeWhitelist: ['@scope/a'] }).value.get()
  assert.equal(provided.channel, 'next')
  assert.deepEqual(provided.safeModeWhitelist, ['@scope/a'])
})

test('0.1.7 形态:configure 关闭原生自动页,owner 为本插件 fiber', () => {
  const { ctx } = makeCtx()
  assert.deepEqual(ctx.calls.configureCalls, [{ presentation: { auto: false }, owner: ctx.fiber }])
})

test('0.1.7 形态:通道切换经 configEditor.edit 定位 maintain 条目并合并写回', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  const switched = await post(routes, '/api/maintain/channel', { channel: 'next' })
  assert.equal(switched.status, 200)
  assert.equal(ctx.calls.editCalls.length, 1)
  assert.equal(ctx.calls.editCalls[0].options.id, 'maintain')
  assert.equal(ctx.calls.editCalls[0].options.name, '@mzzsfy/dsh-maintain')
  assert.equal(store.channel, 'next')
})

test('0.1.7 形态:settings 缺席干净降级——挂载照常、自动页策略缺席、写走 configEditor', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsAvailable: false, settingsStore: store })
  assert.deepEqual(ctx.calls.configureCalls, [])
  const switched = await post(routes, '/api/maintain/channel', { channel: 'next' })
  assert.equal(switched.status, 200)
  assert.equal(store.channel, 'next')
})

test('0.1.7 形态:configEditor 缺失即 500,条目配置不被改动', async () => {
  const store = {}
  const { routes } = makeCtx({ configEditorAvailable: false, settingsStore: store })
  const denied = await post(routes, '/api/maintain/channel', { channel: 'next' })
  assert.equal(denied.status, 500)
  assert.deepEqual(denied.payload, { error: 'configEditor 服务不可用' })
  assert.equal(store.channel, undefined)
})

test('legacy 形态:register 注册 maintain 命名空间,get 读预设,写走 settings.update', async () => {
  const store = { channel: 'next' }
  const { ctx, routes } = makeCtx({ legacySettings: true, settingsStore: store })
  assert.deepEqual(ctx.calls.registerCalls.map((row) => row.ns), ['maintain'])
  assert.equal(ctx.calls.registerCalls[0].schema, Config, 'legacy register 须复用 Config 导出')
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.payload.channel, 'next', 'legacy 形态读 settings 命名空间')
  const switched = await post(routes, '/api/maintain/channel', { channel: 'latest' })
  assert.equal(switched.status, 200)
  assert.equal(store.channel, 'latest')
  assert.equal(ctx.calls.editCalls.length, 0, 'legacy 形态不得触碰 configEditor')
})

test('timer 服务缺失:自动轮询降级,面板状态照常响应', async () => {
  const { ctx, routes } = makeCtx({ timerAvailable: false })
  const res = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
  assert.equal(res.status, 200)
  assert.equal(res.payload.pollRunning, false)
  // 手动检查通道不受影响:refresh 仍可拉取 dist-tags
  const refreshed = await call(routes, '/api/maintain/refresh', makeReq({ body: {} }))
  assert.equal(refreshed.status, 200)
  assert.ok(refreshed.payload.checkedAt !== null)
})

test('interval dispose 回归:fiber 停用后轮询 tick 失效(防双 interval 回归)', async () => {
  const { ctx, routes } = makeCtx()
  assert.equal(ctx.calls.disposers.length > 0, true, 'interval dispose 必须经 ctx.effect 挂回插件 fiber')
  // 等启动检查落定,排除其 checkedAt 变化对断言的干扰
  let baseline = null
  for (let waited = 0; waited < 5000; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) { baseline = poll.payload.checkedAt; break }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(baseline !== null, '启动检查 5 秒内未完成')
  ctx.disposeEffects()
  ctx.fireTick()
  const res = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
  assert.equal(res.payload.checkedAt, baseline, 'dispose 后 fireTick 不得触发新一轮检查')
})

test('方法守卫:全部路由错误方法一律 405', async () => {
  const { ctx, routes } = makeCtx()
  // GET 端点(status/release-notes/plugins)以 POST 拒绝,其余以 GET 拒绝
  const readPaths = ['/api/maintain/status', '/api/maintain/release-notes', '/api/maintain/plugins']
  for (const path of routes.keys()) {
    const expected = readPaths.indexOf(path) >= 0 ? 'POST' : 'GET'
    const res = await call(routes, path, makeReq({ method: expected }))
    assert.equal(res.status, 405, path + ' 应拒绝 ' + expected)
  }
})

test('写路由 JSON 门:缺 content-type 与伪装类型一律 400,application/json 放行', async () => {
  const { routes } = makeCtx()
  // Given 三种非法 Content-Type(空/表单/后缀伪装)
  for (const contentType of ['', 'text/plain', 'application/jsonp']) {
    const denied = await post(routes, '/api/maintain/refresh', undefined, { 'content-type': contentType })
    assert.equal(denied.status, 400, contentType + ' 必须拒绝')
    assert.match(denied.payload.error, /content-type/)
  }
  // When 合法 JSON
  const ok = await post(routes, '/api/maintain/refresh')
  // Then 业务执行
  assert.equal(ok.status, 200)
})

test('跨源守卫:Origin 与 Host 不符即 403;同源放行;Host 大小写归一', async () => {
  const { ctx, routes } = makeCtx()
  const evil = await post(routes, '/api/maintain/refresh', undefined, { origin: 'https://evil.example', host: 'localhost:3000' })
  assert.equal(evil.status, 403)
  const ok = await post(routes, '/api/maintain/refresh', undefined, { origin: 'http://localhost:3000' })
  assert.equal(ok.status, 200)
  const upper = await post(routes, '/api/maintain/refresh', undefined, { origin: 'http://LOCALHOST:3000', host: 'LOCALHOST:3000' })
  assert.equal(upper.status, 200, 'Host 头大小写不影响同源判定')
})

test('refresh:触发检查并返回 200 快照', async () => {
  const { ctx, routes } = makeCtx()
  const res = await post(routes, '/api/maintain/refresh')
  assert.equal(res.status, 200)
  assert.ok(res.payload.checkedAt !== null)
})

test('channel:空值 400;非法字符 400;不在 tags 400;合法通道走白名单放行', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })

  const empty = await post(routes, '/api/maintain/channel', { channel: '  ' })
  assert.equal(empty.status, 400)

  const malicious = await post(routes, '/api/maintain/channel', { channel: 'latest; rm -rf /' })
  assert.equal(malicious.status, 400)
  assert.match(malicious.payload.error, /非法字符/, '白名单与不在 tags 两条拒绝路径文案可区分')
  assert.equal(store.channel, undefined, '非法通道不得落盘')

  const ghost = await post(routes, '/api/maintain/channel', { channel: 'ghosttag' })
  assert.equal(ghost.status, 400)
  assert.match(ghost.payload.error, /不在当前 dist-tags/, 'tags 就绪时白名单分支生效')

  const ok = await post(routes, '/api/maintain/channel', { channel: 'next' })
  assert.equal(ok.status, 200)
  assert.equal(store.channel, 'next')
})

test('poll-interval:负数 400;合法值持久化', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  const bad = await post(routes, '/api/maintain/poll-interval', { seconds: -1 })
  assert.equal(bad.status, 400)
  const wide = await post(routes, '/api/maintain/poll-interval', { seconds: '60' })
  assert.equal(wide.status, 400, '字符串宽转必须拒绝')
  const ok = await post(routes, '/api/maintain/poll-interval', { seconds: 0 })
  assert.equal(ok.status, 200)
  assert.equal(store.pollIntervalSec, 0)
})

test('registry-base:非法 scheme 400;合法值持久化', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  const bad = await post(routes, '/api/maintain/registry-base', { base: 'ftp://mirror.example' })
  assert.equal(bad.status, 400)
  const ok = await post(routes, '/api/maintain/registry-base', { base: 'https://mirror.example' })
  assert.equal(ok.status, 200)
  assert.equal(store.registryBase, 'https://mirror.example')
})

test('plugins:只返回已安装 profile 插件并标记可加入白名单的插件', async () => {
  const rows = [
    { name: '@scope/z', version: '2.0.0', enabled: false, installed: true, availability: 'profile', official: false },
    { name: '@mzzsfy/dsh-tunnel', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@mzzsfy/dsh-auto-trust-all', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@scope/a', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@deepseek-ai/dsh-web-app', version: '0.1.0', enabled: true, installed: true, availability: 'installation', official: true },
    { name: '@scope/readonly', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false, readOnlyReason: 'management-required' },
    { name: '@scope/missing', version: null, enabled: false, installed: false, availability: 'missing', official: false },
    { name: '@scope/not-installed', version: '1.0.0', enabled: false, installed: false, availability: 'profile', official: false },
    { bad: true },
  ]
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      pluginManager: {
        listBundles: async () => rows,
        listVersions: async () => ({ status: 'listed', versions: [] }),
        updateBundle: async () => ({ result: { application: 'applied' } }),
        setBundleEnabled: async () => {},
      },
    },
  })
  const res = await get(routes, '/api/maintain/plugins')
  assert.equal(res.status, 200)
  assert.equal(res.payload.available, true)
  assert.deepEqual(res.payload.plugins.map((row) => row.name), [
    '@mzzsfy/dsh-tunnel',
    '@scope/a',
    '@scope/z',
    '@mzzsfy/dsh-auto-trust-all',
    '@scope/readonly',
  ])
  const byName = Object.fromEntries(res.payload.plugins.map((row) => [row.name, row]))
  assert.equal(byName['@scope/a'].selectable, true)
  assert.equal(byName['@scope/z'].selectable, true)
  assert.equal(byName['@scope/z'].enabled, false)
  assert.equal(byName['@mzzsfy/dsh-tunnel'].protected, false)
  assert.equal(byName['@mzzsfy/dsh-tunnel'].selectable, true)
  assert.equal(byName['@mzzsfy/dsh-auto-trust-all'].protected, true)
  assert.equal(byName['@mzzsfy/dsh-auto-trust-all'].selectable, false)
  assert.equal(byName['@scope/readonly'].selectable, false)
  assert.equal(byName['@deepseek-ai/dsh-web-app'], undefined)
  assert.equal(byName['@scope/missing'], undefined)
  assert.equal(byName['@scope/not-installed'], undefined)
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.payload.upgradePluginsAvailable, false)
  assert.equal(status.payload.pluginUpgradeMode, 'disabled')
})

test('plugins:pluginManager 缺失或读取失败时返回可解释的不可用状态', async () => {
  const missing = await get(makeCtx().routes, '/api/maintain/plugins')
  assert.equal(missing.status, 200)
  assert.equal(missing.payload.available, false)
  assert.match(missing.payload.reason, /pluginManager/)

  const failed = await get(makeCtx({
    services: { ...IDLE_SERVICES, pluginManager: { listBundles: async () => { throw new Error('boom') } } },
  }).routes, '/api/maintain/plugins')
  assert.equal(failed.status, 200)
  assert.equal(failed.payload.available, false)
  assert.match(failed.payload.reason, /boom/)
})

test('safe-mode-whitelist:非法类型 400;合法值去重持久化', async () => {
  const store = {}
  const { routes } = makeCtx({ settingsStore: store })
  const bad = await post(routes, '/api/maintain/safe-mode-whitelist', { plugins: 42 })
  assert.equal(bad.status, 400)
  const invalidItem = await post(routes, '/api/maintain/safe-mode-whitelist', { plugins: ['@scope/a', 1] })
  assert.equal(invalidItem.status, 400)
  const tooMany = await post(routes, '/api/maintain/safe-mode-whitelist', {
    plugins: Array.from({ length: 101 }, (_, index) => '@scope/plugin-' + index),
  })
  assert.equal(tooMany.status, 400)
  assert.match(tooMany.payload.error, /100/)
  const ok = await post(routes, '/api/maintain/safe-mode-whitelist', {
    plugins: ['@mzzsfy/dsh-auto-trust-all', ' @scope/a ', '@mzzsfy/dsh-auto-trust-all'],
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(store.safeModeWhitelist, ['@mzzsfy/dsh-auto-trust-all', '@scope/a'])
  assert.deepEqual(ok.payload.safeModeWhitelist, ['@mzzsfy/dsh-auto-trust-all', '@scope/a'])
})

// body 语法错误:设置类四路由体必填,空体与截断 JSON 都是语法错误,
// 必须与 upgrade/restart 同口径回统一中文 400,不把原生 JSON.parse 文案(含 position 细节)外泄
test('写路由 body 语法错误:设置类四路由空体/坏 JSON 统一中文 400', async () => {
  const store = {}
  const { routes } = makeCtx({ settingsStore: store })
  const settingsPaths = ['/api/maintain/channel', '/api/maintain/poll-interval', '/api/maintain/registry-base', '/api/maintain/safe-mode-whitelist']
  for (const path of settingsPaths) {
    for (const body of [undefined, '{"channel":']) {
      const res = await post(routes, path, body)
      assert.equal(res.status, 400, path + ' 空体/坏 JSON 必须 400')
      assert.deepEqual(res.payload, { error: '请求体不是合法 JSON' }, path + ' 必须回统一中文文案')
    }
  }
  assert.deepEqual(store, {}, '语法错误不得落盘任何字段')
})

test('写路由 body 语法错误:upgrade/restart 同口径中文 400,且不触发副作用', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { routes } = makeCtx({ exits })
  for (const path of ['/api/maintain/upgrade', '/api/maintain/restart']) {
    const res = await post(routes, path, '{"targetVersion":')
    assert.equal(res.status, 400, path + ' 坏 JSON 必须 400')
    assert.deepEqual(res.payload, { error: '请求体不是合法 JSON' }, path + ' 与设置类路由同文案')
  }
  assert.deepEqual(exits, [], '语法错误不得调度退出的副作用')
})

test('写路由 body 合法但非对象:按空体交业务校验,不误报语法错误', async () => {
  const { routes } = makeCtx()
  const cases = [
    ['/api/maintain/channel', 'channel 不能为空'],
    ['/api/maintain/poll-interval', '轮询间隔必须是不小于 0 的秒数'],
    ['/api/maintain/registry-base', 'registry 基地址须为 http(s) 地址且不带查询串或锚点'],
  ]
  for (const [path, message] of cases) {
    for (const body of ['null', '0', '"x"', '[]']) {
      const res = await post(routes, path, body)
      assert.equal(res.status, 400)
      assert.equal(res.payload.error, message, path + ' body=' + body + ' 应走业务文案')
    }
  }
})

// 受管布局桩:路由测试不触真实文件系统,layout 由依赖注入
const LAYOUT_STUB = {
  prefix: RUNNING_INSTALL.prefix,
  originalPackage: RUNNING_INSTALL.originalPackage,
  bin: 'lib/bin.js',
  root: 'C:/fake-prefix/.dsh-maintain',
  a: 'C:/fake-prefix/.dsh-maintain/install-a',
  b: 'C:/fake-prefix/.dsh-maintain/install-b',
  link: 'C:/fake-prefix/node_modules/@deepseek-ai/dsh/dsh_link',
}

// 受管升级路由:门控顺序 目标解析→互斥→受管可用→活跃工作,全部通过才进 runner。
// runner 注入桩,禁止测试触发真实 npm(未注入 runner 即真实编排器,fake 路径会被 mkdir);
// exit 调度经 mock timers 控制
const IDLE_SERVICES = { agents: { list: () => [] }, jobs: { list: () => [] } }
const PREFLIGHT_OK = {
  ok: true,
  environmentOk: true,
  pluginSummary: { block: 0, warn: 0, ok: 0, total: 0 },
  plugins: [],
  checks: [],
  safeMode: { available: false, candidates: [] },
}
const DEPS = (overrides = {}) => ({
  runManagedUpgrade: makeRunnerStub(),
  createLayout: async () => LAYOUT_STUB,
  runPreflight: async () => PREFLIGHT_OK,
  ...overrides,
})

test('upgrade:targetVersion 非精确一律 400,runner 不得启动', async () => {
  const runner = makeRunnerStub()
  const { ctx, routes } = makeCtx({ services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  for (const targetVersion of ['latest', '1.2', '', '1.0.0; rm -rf /', null, 3]) {
    const denied = await post(routes, '/api/maintain/upgrade', { targetVersion })
    assert.equal(denied.status, 400, '非法目标必须 400: ' + String(targetVersion))
    assert.match(denied.payload.error, /精确/)
  }
  await drainMicrotasks()
  assert.equal(runner.calls.length, 0, '拒绝路径不得进入 runner')
})

test('upgrade:目标缺省按通道 dist-tag 解析为精确版本;tags 未就绪 400', async () => {
  const runner = makeRunnerStub()
  const { ctx, routes } = makeCtx({ services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  await waitSnapshotReady(routes)
  const accepted = await post(routes, '/api/maintain/upgrade', {})
  assert.equal(accepted.status, 200)
  assert.equal(accepted.payload.targetVersion, MOCK_TAGS.latest, '缺省目标必须来自通道 dist-tag')
  await drainMicrotasks()
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].targetVersion, MOCK_TAGS.latest)
  assert.equal(runner.calls[0].registryBase, 'https://registry.npmjs.org', 'runner 收到配置镜像地址')
})

test('upgrade:受管安装不可用 409,runner 不得启动', async () => {
  const runner = makeRunnerStub()
  const brokenInstall = { ...RUNNING_INSTALL, error: 'DSH profileContext.installAnchor 不可用', prefix: null, originalPackage: null, runningPackage: null }
  const broken = makeCtx({
    services: IDLE_SERVICES,
    dependencies: DEPS({ runManagedUpgrade: runner, runningInstall: { ...RUNNING_INSTALL, ...brokenInstall } }),
  })
  const deniedManaged = await post(broken.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(deniedManaged.status, 409)
  assert.match(deniedManaged.payload.error, /受管安装不可用/)
  await drainMicrotasks()
  assert.equal(runner.calls.length, 0, '能力缺失路径不得进入 runner')
})

test('upgrade:活跃检测不可用 fail-closed 409,存在活跃工作 409 不可越', async () => {
  const runner = makeRunnerStub()
  const blind = makeCtx({ dependencies: DEPS({ runManagedUpgrade: runner }) })
  const blindDenied = await post(blind.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(blindDenied.status, 409)
  assert.match(blindDenied.payload.error, /检测不可用/)
  assert.equal(blindDenied.payload.detectionAvailable, false)
  const pendingTerminals = { list: () => [], hasOwnerActivity: (owner) => owner.id === 'session-pending' }
  const isolatedPending = makeCtx({
    services: {
      agents: { list: () => [{ id: 'session-pending', status: 'idle', ctx: { get: () => pendingTerminals } }] },
      jobs: { list: (caller) => caller === 'session-pending' ? [{ id: 'owned', status: 'running' }] : [] },
      terminals: pendingTerminals,
    },
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const pendingDenied = await post(isolatedPending.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(pendingDenied.status, 409)
  assert.equal(pendingDenied.payload.items.terminals, 1)
  assert.equal(pendingDenied.payload.detectionAvailable, true)
  const busy = makeCtx({
    services: { agents: { list: () => [{ id: 'a1', status: 'running' }] }, jobs: { list: () => [] }, terminals: { list: () => [], hasOwnerActivity: () => false } },
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const busyDenied = await post(busy.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(busyDenied.status, 409)
  assert.match(busyDenied.payload.error, /活跃工作/)
  assert.equal(busyDenied.payload.items.agents, 1)
  await drainMicrotasks()
  assert.equal(runner.calls.length, 0, '活跃工作路径不得进入 runner')
})

test('upgrade:terminals 面不可见属宿主常态,agents 计数照常门控', async () => {
  const runner = makeRunnerStub()
  // 0.2.0 真实形态:terminals 服务对插件 ctx 根与 agent realm 均不可探(agent.ctx.get 返回 undefined),
  // 活跃 agent 由 agents 计数覆盖,不得因此降级为"检测不可用"
  const noTerminalFace = makeCtx({
    services: { agents: { list: () => [{ id: 'a-live', status: 'running', ctx: { get: () => undefined } }] }, jobs: { list: () => [] } },
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const denied = await post(noTerminalFace.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /活跃工作/, 'agents 计数必须照常门控')
  assert.equal(denied.payload.items.agents, 1)
  assert.equal(denied.payload.items.terminals, 0)
  assert.equal(denied.payload.detectionAvailable, true, 'terminals 面不可见不得降级为检测不可用')
  const idle = makeCtx({
    services: { agents: { list: () => [{ id: 'a-idle', status: 'idle' }] }, jobs: { list: () => [] } },
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const accepted = await post(idle.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(accepted.status, 200, 'terminals 面不可见且无活跃工作时必须放行')
  await drainMicrotasks()
})

test('upgrade:terminals 面可见但方法面残缺仍降级(残余 fail-closed 路径)', async () => {
  const runner = makeRunnerStub()
  const brokenFace = makeCtx({
    services: { agents: { list: () => [] }, jobs: { list: () => [] }, terminals: {} },
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const denied = await post(brokenFace.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /检测不可用/, '面可见但残缺属真缺陷,保持 fail-closed')
  assert.match(denied.payload.error, /terminals\(/, '错误文案必须携带降级明细供定位')
  assert.equal(denied.payload.detectionAvailable, false)
  assert.match(denied.payload.items.degraded.terminals, /服务方法面不可用/)
  await drainMicrotasks()
  assert.equal(runner.calls.length, 0, '检测降级路径不得进入 runner')
})

test('upgrade:agent realm 面可见但残缺仍降级(per-agent fail-closed 对称)', async () => {
  const runner = makeRunnerStub()
  // realm 面 get('terminals') 返回 {} 与根面残缺同构:扫描 throw → 降级,不得静默当 0 计数
  const realmBroken = makeCtx({
    services: { agents: { list: () => [{ id: 'a-realm', status: 'idle', ctx: { get: () => ({}) } }] }, jobs: { list: () => [] } },
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const denied = await post(realmBroken.routes, '/api/maintain/upgrade', { targetVersion: '2.0.0' })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /检测不可用/, 'realm 面可见但残缺属真缺陷,保持 fail-closed')
  assert.equal(denied.payload.detectionAvailable, false)
  await drainMicrotasks()
  assert.equal(runner.calls.length, 0, '检测降级路径不得进入 runner')
})

test('upgrade:runner 成功调度一次硬退出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const runner = makeRunnerStub({ result: () => gate.then(() => ({ operationId: 'op-1', switched: true, phase: 'awaiting-restart', slot: 'a', targetVersion: '9.9.9' })) })
  const { routes } = makeCtx({ exits, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(accepted.status, 200)
  await drainMicrotasks()
  const second = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(second.status, 409)
  release()
  let settled = null
  for (let i = 0; i < 50 && settled === null; i += 1) {
    await realSleep(30)
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
  }
  assert.ok(settled)
  assert.equal(settled.upgrade.last.ok, null)
  assert.equal(settled.upgrade.last.pending, true)
  assert.deepEqual(exits, [])
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE])
})



test('upgrade:autoRestart 关闭时切换成功不调度退出,维护态复位后新回合可进', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const runner = makeRunnerStub({ result: async () => ({ operationId: 'op-3', switched: true, phase: 'awaiting-restart', slot: 'a' }) })
  const { ctx, routes } = makeCtx({
    exits,
    services: IDLE_SERVICES,
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const hook = ctx.calls.agentHook
  assert.ok(hook?.listener, 'pre-step 钩子必须已挂')
  const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(accepted.status, 200)
  let settled = null
  for (let i = 0; i < 50 && settled === null; i += 1) {
    await realSleep(30)
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
  }
  assert.ok(settled)
  assert.equal(settled.upgrade.last.ok, null)
  assert.equal(settled.upgrade.last.pending, true)
  assert.notEqual(settled.upgrade.last.exitScheduled, true, '自动重启关闭时不得标记退出调度')
  // 关闭自动重启即本进程继续服务:维护态必须随本次意图收尾解除,否则 pre-step 永久拒绝全量新回合
  assert.equal(settled.awaitingRestart, false, '未调度退出时维护态必须复位')
  const pass = await hook.listener({ signal: { aborted: false } }, async () => ({ kind: 'continue' }))
  assert.equal(pass.kind, 'continue', '维护态复位后 pre-step 必须放行新回合')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  assert.deepEqual(exits, [], '自动重启关闭时不得调度宿主退出')
})

test('upgrade:autoRestart 关闭时切换状态未知仍强制调度退出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const runner = makeRunnerStub({ result: async () => { const error = new Error('post-switch boom'); error.switched = true; throw error } })
  const { routes } = makeCtx({
    exits,
    services: IDLE_SERVICES,
    dependencies: DEPS({ runManagedUpgrade: runner }),
  })
  const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(accepted.status, 200)
  await drainMicrotasks()
  let settled = null
  for (let i = 0; i < 50 && settled === null; i += 1) {
    await realSleep(30)
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
  }
  assert.ok(settled)
  assert.equal(settled.upgrade.last.phase, 'indeterminate')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE], '切换状态未知必须无视意图强制退出')
})

test('upgrade:安装超时(indeterminate,未切换)同样强制调度退出且不虚报 switched', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  // 真实编排器把安装超时归为状态不确定且要求保护性退出。
  const runner = makeRunnerStub({
    result: async () => {
      const error = new Error('npm 安装超时')
      error.timedOut = true
      error.indeterminate = true
      error.requiresHostExit = true
      throw error
    },
  })
  const { routes } = makeCtx({ exits, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(accepted.status, 200)
  await drainMicrotasks()
  let settled = null
  for (let i = 0; i < 50 && settled === null; i += 1) {
    await realSleep(30)
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
  }
  assert.ok(settled)
  assert.equal(settled.upgrade.last.phase, 'indeterminate')
  assert.equal(settled.upgrade.last.switched, false, '未切换不得虚报 switched')
  assert.equal(settled.upgrade.last.exitScheduled, true)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE], '状态不确定必须强制退出')
})

test('upgrade:autoRestart 非布尔非缺省 400,runner 不得启动', async () => {
  const runner = makeRunnerStub()
  const { routes } = makeCtx({ services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  for (const autoRestart of ['yes', 0, null]) {
    const denied = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart })
    assert.equal(denied.status, 400, '非布尔必须 400: ' + String(autoRestart))
  }
  await drainMicrotasks()
  assert.equal(runner.calls.length, 0, '拒绝路径不得进入 runner')
})

// A1
for (const intent of [{ upgradePlugins: true }, { safeMode: true }, { safeMode: true, autoRestart: false }]) {
  test('M0 A1:在线写入意图在预检和启动编排前被拒绝 ' + JSON.stringify(intent), async (t) => {
    const { root, profileDir, managedRoot } = await makePackageAssets(t)
    const original = await snapshotPackageAssets(profileDir)
    const writes = []
    const rejectWrite = (name) => async () => {
      writes.push(name)
      throw new Error('不得修改活动 profile')
    }
    const plugin = { name: '@scope/a', installed: true, update: 'registry', version: '1.0.0', status: 'warn' }
    const pluginManager = {
      listBundles: async () => [plugin],
      listVersions: async () => ({ status: 'listed', versions: [{ version: '1.1.0' }] }),
      updateBundle: rejectWrite('updateBundle'),
      setBundleEnabled: rejectWrite('setBundleEnabled'),
    }
    const runner = makeRunnerStub({ result: async (input) => {
      await input.beforeSwitch({ candidatePackage: '/fake/slot/dsh' })
      return { phase: 'awaiting-restart', switched: true }
    } })
    let preflights = 0
    const { routes } = makeCtx({
      home: root,
      profileDir,
      services: { ...IDLE_SERVICES, pluginManager },
      dependencies: DEPS({
        createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }),
        runManagedUpgrade: runner,
        runPreflight: async () => { preflights += 1; return PREFLIGHT_OK },
        scanPlugins: async () => ({ available: true, plugins: [plugin], safeModeCandidates: [plugin] }),
      }),
    })
    const response = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', ...intent })
    await drainMicrotasks()
    assert.equal(response.status, 409)
    assert.match(response.payload.error, /已关闭/)
    assert.equal(preflights, 0)
    assert.deepEqual(runner.calls, [])
    assert.deepEqual(writes, [])
    const status = (await get(routes, '/api/maintain/status')).payload
    assert.equal(status.upgradePluginsAvailable, false)
    assert.equal(status.upgrade.last, null)
    assert.deepEqual(await snapshotPackageAssets(profileDir), original)
  })
}

test('M0 A1:预检不把活动宿主的在线禁用能力当作升级能力', async () => {
  const { routes } = makeCtx({ dependencies: DEPS({
    runPreflight: async () => ({ ...PREFLIGHT_OK, ok: false, okWithSafeMode: true, safeMode: {
      available: true, reason: null, candidates: [{ name: '@scope/a' }], protected: [{ name: '@scope/b' }],
    } }),
  }) })
  const response = await post(routes, '/api/maintain/preflight', { targetVersion: '9.9.9' })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.okWithSafeMode, false)
  assert.equal(response.payload.safeMode.available, false)
  assert.match(response.payload.safeMode.reason, /已关闭/)
  assert.deepEqual(response.payload.safeMode.candidates, [])
  assert.deepEqual(response.payload.safeMode.protected, [])
})

test('M0 A1:准备期间卸载维护插件后不得切槽或重启', async () => {
  const preparing = Promise.withResolvers()
  const preparationDone = Promise.withResolvers()
  const guardResult = Promise.withResolvers()
  let switched = false
  const exits = []
  const runner = makeRunnerStub({ result: async (input) => {
    preparing.resolve()
    await preparationDone.promise
    try {
      await input.beforeSwitch()
      switched = true
      guardResult.resolve(null)
      return { operationId: 'op-disposed', switched: true, phase: 'awaiting-restart' }
    } catch (error) {
      guardResult.resolve(error)
      throw error
    }
  } })
  const { ctx, routes } = makeCtx({ exits, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(accepted.status, 200)
  await preparing.promise
  ctx.disposeEffects()
  preparationDone.resolve()
  assert.match((await guardResult.promise)?.message ?? '', /维护插件已卸载/)
  assert.equal(switched, false)
  assert.deepEqual(exits, [])
})

async function snapshotPackageAssets(root) {
  const snapshot = {}
  async function visit(relative) {
    const path = join(root, relative)
    const stat = await lstat(path, { bigint: true })
    snapshot[relative] = { ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
    if (stat.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(relative, name))
    } else {
      snapshot[relative].contents = await readFile(path)
    }
  }
  for (const path of ['package.json', 'pnpm-lock.yaml', 'node_modules']) await visit(path)
  return snapshot
}

function rejectPluginCalls(calls, ...methods) {
  return Object.fromEntries(methods.map((method) => [method, async () => {
    calls.push(method)
    throw new Error('不应调用 ' + method)
  }]))
}

async function makePackageAssets(t) {
  const root = await mkdtemp(join(tmpdir(), 'maintain-host-only-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const profileDir = join(root, 'profiles', 'web')
  const managedRoot = join(root, '.dsh-maintain')
  const installedPlugin = join(profileDir, 'node_modules', '@scope', 'a')
  await mkdir(installedPlugin, { recursive: true })
  await mkdir(managedRoot)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { '@scope/a': '1.0.0' } }))
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@scope/a':\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  '@scope/a@1.0.0': {}\nsnapshots:\n  '@scope/a@1.0.0': {}\n")
  await writeFile(join(installedPlugin, 'package.json'), JSON.stringify({ name: '@scope/a', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(installedPlugin, 'cordis.patch.yml'), '{}\n')
  return { root, profileDir, managedRoot }
}

async function waitForUpgradeResult(routes) {
  const deadline = Date.now() + 5 * 1000
  do {
    const { upgrade } = (await get(routes, '/api/maintain/status')).payload
    if (!upgrade.running && upgrade.last) return upgrade.last
    await drainMicrotasks()
  } while (Date.now() < deadline)
  assert.fail('升级编排结束后未发布结果')
}

test('M0 A1:宿主单升准备期间状态可查，切槽检查前后活动包资产零写入', async (t) => {
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  const original = await snapshotPackageAssets(profileDir)

  const calls = []
  const installed = { name: '@scope/a', installed: true, enabled: true, update: 'registry', version: '1.0.0', availability: 'profile' }
  const preparation = Promise.withResolvers()
  const runner = makeRunnerStub({ result: async (input) => {
    await preparation.promise
    await input.beforeSwitch({ candidatePackage: join(managedRoot, 'candidate', 'node_modules', '@deepseek-ai', 'dsh') })
    return { operationId: 'op-host-only', switched: true, phase: 'awaiting-restart', slot: 'a', targetVersion: input.targetVersion }
  } })
  const { routes } = makeCtx({
    home: root,
    profileDir,
    services: {
      ...IDLE_SERVICES,
      appReady: { onReady: () => {} },
      pluginManager: {
        listBundles: async () => [installed],
        ...rejectPluginCalls(calls, 'listVersions', 'updateBundle', 'setBundleEnabled'),
      },
    },
    dependencies: DEPS({
      createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }),
      runManagedUpgrade: runner,
      scanPlugins: async () => ({ available: true, plugins: [{ ...installed, status: 'ok' }] }),
    }),
  })
  try {
    const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false, upgradePlugins: false, safeMode: false })
    assert.equal(accepted.status, 200)
    assert.equal(runner.calls.length, 1)
    const running = await get(routes, '/api/maintain/status')
    assert.equal(running.status, 200)
    assert.equal(running.payload.upgrade.running, true)
    assert.equal(running.payload.runningVersion, '1.0.0')
    assert.deepEqual(await snapshotPackageAssets(profileDir), original)
  } finally {
    preparation.resolve()
  }
  const settled = await waitForUpgradeResult(routes)
  assert.deepEqual(await snapshotPackageAssets(profileDir), original)
  assert.deepEqual(calls, [])
  assert.equal(settled?.switched, true, settled?.error)
  assert.equal(settled.ok, null)
  assert.equal(settled.pending, true)
})

test('M0 A1:准备期间新出现活跃工作时不得切槽或重启', async (t) => {
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  const original = await snapshotPackageAssets(profileDir)
  const preparation = Promise.withResolvers()
  const agents = []
  const exits = []
  let switched = false
  const runner = makeRunnerStub({ result: async (input) => {
    await preparation.promise
    await input.beforeSwitch()
    switched = true
    return { operationId: 'op-too-busy', switched, phase: 'awaiting-restart', slot: 'a' }
  } })
  const { routes } = makeCtx({
    home: root, profileDir, exits,
    services: { ...IDLE_SERVICES, agents: { list: () => agents } },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }), runManagedUpgrade: runner }),
  })
  try {
    const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
    assert.equal(accepted.status, 200)
    assert.equal(runner.calls.length, 1)
    agents.push({ id: 'started-during-preparation', status: 'running' })
  } finally {
    preparation.resolve()
  }
  const result = await waitForUpgradeResult(routes)
  assert.equal(switched, false)
  assert.equal(result.switched, false)
  assert.equal(result.ok, false)
  assert.match(result.error, /提交窗口.*活跃工作/)
  assert.notEqual(result.exitScheduled, true)
  assert.deepEqual(exits, [])
  assert.deepEqual(await snapshotPackageAssets(profileDir), original)
})

async function makeCandidate(t, { evaluator = true } = {}) {
  const assets = await makePackageAssets(t)
  const slot = join(assets.managedRoot, 'install-a')
  const candidatePackage = join(slot, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(candidatePackage, { recursive: true })
  await writeFile(join(candidatePackage, 'package.json'), '{}')
  if (evaluator) {
    const evaluatorDir = join(slot, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    await mkdir(evaluatorDir, { recursive: true })
    await writeFile(join(evaluatorDir, 'package.json'), '{"main":"index.cjs"}')
    await writeFile(join(evaluatorDir, 'index.cjs'), `module.exports = {
      readProfileVersionExemptions: () => ({}),
      evaluatePluginCompatibility: (manifest, exemptions, version) => manifest.name === '@scope/a' && version === '9.9.9'
        ? { requirements: { dsh: '<9' } } : undefined,
    }`)
  }
  return { ...assets, slot, candidatePackage }
}

for (const evaluator of [true, false]) {
  test('M0:临切槽复扫候选版本，' + (evaluator ? '新出现的明确不兼容必须拒绝' : '评估器不可用仍可切槽'), async (t) => {
    const { profileDir, managedRoot, slot, candidatePackage } = await makeCandidate(t, { evaluator })
    const before = await snapshotPackageAssets(profileDir)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const warns = t.mock.method(console, 'warn', () => {})
    const rows = []
    const calls = []
    const readyToSwitch = Promise.withResolvers()
    let switched = false
    const runner = makeRunnerStub({ result: async (input) => {
      await readyToSwitch.promise
      await input.beforeSwitch({ candidatePackage, slot })
      switched = true
      return { switched, phase: 'awaiting-restart' }
    } })
    const { routes, exits } = makeCtx({
      profileDir,
      services: { ...IDLE_SERVICES, pluginManager: {
        listBundles: async () => [...rows],
        ...rejectPluginCalls(calls, 'listVersions', 'updateBundle', 'setBundleEnabled'),
      } },
      dependencies: DEPS({
        createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot, a: slot }),
        runManagedUpgrade: runner,
      }),
    })
    try {
      const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: evaluator })
      assert.equal(accepted.status, 200)
      rows.push({ name: '@scope/a', enabled: true, installed: true, availability: 'profile' })
    } finally {
      readyToSwitch.resolve()
    }
    const result = await waitForUpgradeResult(routes)
    assert.equal(switched, !evaluator)
    if (evaluator) assert.match(result.error, /不兼容.*@scope\/a/)
    else assert.ok(warns.mock.calls.some(({ arguments: args }) => args[0].includes('outcome=plugin-rescan-unavailable')))
    t.mock.timers.tick(RESTART_DELAY_MS)
    await drainMicrotasks()
    assert.deepEqual(exits, [])
    assert.deepEqual(calls, [])
    assert.deepEqual(await snapshotPackageAssets(profileDir), before)
  })
}

for (const recheck of ['active-work', 'dispose']) {
  test('M0:异步复扫期间 ' + recheck + ' 变化须在切槽前再次检查', async (t) => {
    const { profileDir, managedRoot, slot, candidatePackage } = await makeCandidate(t, { evaluator: false })
    const scanning = Promise.withResolvers()
    const releaseScan = Promise.withResolvers()
    const gateFinished = Promise.withResolvers()
    const agents = []
    let switched = false
    const runner = makeRunnerStub({ result: async (input) => {
      try {
        await input.beforeSwitch({ candidatePackage, slot })
        switched = true
        return { switched, phase: 'awaiting-restart' }
      } finally {
        gateFinished.resolve('switch')
      }
    } })
    const { ctx, routes, exits } = makeCtx({
      profileDir,
      services: { ...IDLE_SERVICES, agents: { list: () => agents }, pluginManager: {
        async listBundles() {
          scanning.resolve('scan')
          await releaseScan.promise
          return []
        },
      } },
      dependencies: DEPS({
        createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot, a: slot }),
        runManagedUpgrade: runner,
      }),
    })
    try {
      assert.equal((await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })).status, 200)
      assert.equal(await Promise.race([scanning.promise, gateFinished.promise]), 'scan')
      if (recheck === 'dispose') ctx.disposeEffects()
      else agents.push({ id: 'started-during-scan', status: 'running' })
    } finally {
      releaseScan.resolve()
    }
    const result = await waitForUpgradeResult(routes)
    assert.equal(switched, false)
    assert.match(result.error, recheck === 'dispose' ? /维护插件已卸载/ : /提交窗口.*活跃工作/)
    assert.deepEqual(exits, [])
  })
}

const invokePreStep = (ctx, step) => ctx.calls.agentHook.listener({ step, messages: [], signal: new AbortController().signal }, () => ({ kind: 'allowed' }))

async function verifyProfileWriterBoundary(t, runRecord, { blockFailureWrite = false } = {}) {
  const { root, profileDir, managedRoot, candidatePackage } = await makeCandidate(t)
  const statePath = join(managedRoot, 'state.json')
  const stateLock = statePath + '.lock'
  const originalPackage = process.platform === 'win32'
    ? join(root, 'node_modules/@deepseek-ai/dsh') : join(root, 'lib/node_modules/@deepseek-ai/dsh')
  const anchor = join(originalPackage, 'package.json')
  const manifest = join(profileDir, 'package.json')
  const lockPath = manifest + '.lock'
  const recordDir = join(profileDir, '.plugin-manager')
  const record = join(recordDir, 'run.json')
  const hostPackage = (version) => JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } })
  for (const [pkg, version] of [[originalPackage, '1.0.0'], [candidatePackage, '9.9.9']]) {
    await mkdir(join(pkg, 'lib'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), hostPackage(version))
    await writeFile(join(pkg, 'lib', 'bin.js'), '')
  }
  if (process.platform === 'win32') {
    await writeFile(join(root, 'dsh.cmd'), '@"%dp0%node.exe" "%dp0%node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*')
  } else {
    await mkdir(join(root, 'bin'))
    await symlink(join(originalPackage, 'lib', 'bin.js'), join(root, 'bin', 'dsh'))
  }
  const manager = join(originalPackage, 'node_modules/@deepseek-ai/dsh-plugin-manager')
  const lockModule = join(manager, 'node_modules/@deepseek-ai/dsh-atomic-write')
  await mkdir(lockModule, { recursive: true })
  await writeFile(join(manager, 'package.json'), '{"main":"index.js"}')
  await writeFile(join(manager, 'index.js'), '')
  await writeFile(join(lockModule, 'package.json'), '{"type":"module","exports":"./index.js"}')
  await writeFile(join(lockModule, 'index.js'), `import { writeFile, unlink } from 'node:fs/promises'
    export async function withFileLock(filename, run) {
      const path = filename + '.lock'
      await writeFile(path, 'fixture', { flag: 'wx' })
      try {
        ${runRecord === null ? '' : `await writeFile(${JSON.stringify(record)}, ${JSON.stringify(runRecord)})`}
        ${blockFailureWrite ? `await writeFile(${JSON.stringify(stateLock)}, 'fixture', { flag: 'wx' })` : ''}
        return await run()
      } finally { await unlink(path) }
    }`)
  const scanEntered = join(root, 'scan-entered')
  const scanRelease = join(root, 'scan-release')
  await writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  const { withFileLock } = await import(pathToFileURL(join(lockModule, 'index.js')).href)
  const enablePlugin = () => withFileLock(manifest, () => writeFile(manifest, JSON.stringify({ dsh: { profile: { bundles: ['@scope/a'] } } })))
  let checkedEntryCommit = false
  const runnerFinished = Promise.withResolvers()
  const runner = (input) => performManagedUpgrade({
    ...input,
    install: async ({ slot }) => {
      const evaluator = join(slot, 'node_modules/@deepseek-ai/dsh-app-boot')
      await mkdir(evaluator, { recursive: true })
      await writeFile(join(evaluator, 'package.json'), '{"main":"index.cjs"}')
      await writeFile(join(evaluator, 'index.cjs'), `
        const { writeFile, access } = require('node:fs/promises')
        const { setTimeout: delay } = require('node:timers/promises')
        module.exports.readProfileVersionExemptions = async () => {
          await writeFile(${JSON.stringify(scanEntered)}, '')
          while (!await access(${JSON.stringify(scanRelease)}).then(() => true, () => false)) await delay(10)
          return {}
        }
        module.exports.evaluatePluginCompatibility = () => ({ requirements: { dsh: '<9' } })
      `)
      await mkdir(join(candidatePackage, 'lib'), { recursive: true })
      await writeFile(join(candidatePackage, 'package.json'), hostPackage('9.9.9'))
      await writeFile(join(candidatePackage, 'lib', 'bin.js'), '')
      return { ok: true }
    },
    validate: async () => ({ ok: true }),
    activate: (layout, candidate, options) => activateInstallation(layout, candidate, {
      ...options,
      writeEntryImpl: async (change, restore, platform) => {
        if (!restore) {
          assert.equal(await realpath(layout.link), await realpath(candidate))
          await assert.rejects(enablePlugin(), { code: 'EEXIST' })
          checkedEntryCommit = true
        }
        return writeEntry(change, restore, platform)
      },
    }),
  }).finally(() => runnerFinished.resolve())
  const { ctx, routes, exits } = makeCtx({
    installAnchor: anchor, profileDir,
    services: { ...IDLE_SERVICES, pluginManager: { async listBundles() {
      const selected = JSON.parse(await readFile(manifest, 'utf8')).dsh.profile.bundles
      return [{ name: '@scope/a', enabled: selected.includes('@scope/a'), installed: true, availability: 'profile' }]
    } } },
    dependencies: DEPS({
      runningInstall: { prefix: root, originalPackage, error: null },
      createLayout: async () => createLayout({ prefix: root, originalPackage }),
      runPreflight: (options) => runPreflight({
        ...options,
        findNpmCliImpl: async () => 'fixture-npm',
        fetchVersionManifestImpl: async () => ({ engines: {} }),
        statfsImpl: async () => ({ bsize: 4096, bavail: 1024 * 1024 }),
      }),
      runManagedUpgrade: runner,
    }),
  })
  if (runRecord !== null) {
    await mkdir(recordDir)
    await writeFile(scanRelease, '')
    const entry = process.platform === 'win32' ? join(root, 'dsh.cmd') : join(root, 'bin/dsh')
    const before = await readFile(entry)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    assert.equal((await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })).status, 200)
    await withDeadline(runnerFinished.promise, 5 * 1000)
    const result = await waitForUpgradeResult(routes)
    assert.equal(result.switched, false)
    t.mock.timers.tick(RESTART_DELAY_MS + 1)
    await drainMicrotasks()
    assert.deepEqual(exits, [], '切槽前拒绝后，失败落盘受阻也不得退出宿主')
    assert.equal(result.exitScheduled, false)
    assert.match(result.error, /遗留.*run\.json/)
    await assert.rejects(lstat(scanEntered), { code: 'ENOENT' })
    await assert.rejects(lstat(join(originalPackage, 'dsh_link')), { code: 'ENOENT' })
    assert.deepEqual(await readFile(entry), before)
    assert.equal(await readFile(record, 'utf8'), runRecord)
    await assert.rejects(lstat(lockPath), { code: 'ENOENT' })
    if (blockFailureWrite) {
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      assert.equal(state.phase, 'ready-to-switch')
      assert.equal(state.targetPackage, undefined)
      assert.equal(result.phase, 'indeterminate')
      assert.match(result.error, /状态.*写锁/)
      assert.equal((await invokePreStep(ctx, 1)).kind, 'allowed')
      assert.equal(await readFile(stateLock, 'utf8'), 'fixture')
      const held = JSON.parse(await readFile(join(managedRoot, 'upgrade.lock'), 'utf8'))
      assert.equal(held.operationId, state.operationId)
      await rm(stateLock)
      const retry = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
      assert.equal(retry.status, 409)
      assert.ok(retry.payload.checks.some((check) => check.id === 'lock' && check.status === 'block'))
      const restart = await post(routes, '/api/maintain/restart', { force: true })
      assert.equal(restart.status, 409)
      assert.match(restart.payload.error, /upgrade\.lock/)
    }
    return
  }
  assert.equal((await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })).status, 200)
  try {
    const deadline = Date.now() + 5 * 1000
    while (Date.now() < deadline && !await lstat(scanEntered).catch(() => null)) await realSleep(10)
    assert.ok(await lstat(scanEntered))
    await assert.rejects(enablePlugin(), { code: 'EEXIST' })
  } finally {
    await writeFile(scanRelease, '')
    await withDeadline(runnerFinished.promise, 5 * 1000)
    await waitForUpgradeResult(routes)
  }
  assert.equal(checkedEntryCommit, true)
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).dsh.profile.bundles, [])
  assert.equal(await realpath(join(originalPackage, 'dsh_link')), await realpath(candidatePackage))
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' })
  await enablePlugin()
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).dsh.profile.bundles, ['@scope/a'])
  assert.equal((await get(routes, '/api/maintain/status')).payload.upgrade.last.switched, true)
}

test('M0:候选 Worker 扫描期间，宿主的 profile 写锁阻止启用插件直至完成切槽', (t) => verifyProfileWriterBoundary(t, null))
for (const [kind, record] of [['存活 PID', JSON.stringify({ pid: process.pid, grouped: false })], ['无效内容', '{']]) {
  test('M0:取得 profile 写锁后发现遗留运行记录（' + kind + '）即拒绝切槽', (t) => verifyProfileWriterBoundary(t, record))
}

test('M0:遗留运行记录和失败状态写入受阻时，保留升级锁但继续服务', (t) =>
  verifyProfileWriterBoundary(t, JSON.stringify({ pid: process.pid, grouped: false }), { blockFailureWrite: true }))

test('M0:同一 canonical prefix 的 HMR 延续准备门闩，旧 runner 卸载后不能切槽', async (t) => {
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  const prefixAlias = join(root, 'prefix-alias')
  const prefix = join(root, 'prefix')
  await mkdir(prefix)
  await symlink(prefix, prefixAlias, process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(managedRoot, 'safe-mode.json'), JSON.stringify({ operationId: 'old', targetVersion: '9.9.9', disabled: [{ name: '@scope/a' }] }))
  const releaseRunner = Promise.withResolvers()
  const runnerReady = Promise.withResolvers()
  const calls = []
  let switched = false
  const runner = makeRunnerStub({ result: async (input) => {
    runnerReady.resolve()
    await releaseRunner.promise
    await input.beforeSwitch()
    switched = true
    return { switched, phase: 'awaiting-restart' }
  } })
  const createLayout = async () => ({ ...LAYOUT_STUB, root: managedRoot, prefix: await realpath(prefix) })
  const old = makeCtx({
    profileDir, services: IDLE_SERVICES,
    dependencies: DEPS({ runningInstall: { ...RUNNING_INSTALL, prefix: prefixAlias }, createLayout, runManagedUpgrade: runner }),
  })
  const otherRunner = makeRunnerStub()
  const freshApply = (await import('../src/index.js?gate-hmr-running')).apply
  try {
    assert.equal((await post(old.routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })).status, 200)
    await runnerReady.promise
    old.ctx.disposeEffects()
    const fresh = makeCtx({
      applyPlugin: freshApply,
      profileDir,
      services: { ...IDLE_SERVICES, pluginManager: rejectPluginCalls(calls, 'setBundleEnabled') },
      dependencies: DEPS({
        runningInstall: { ...RUNNING_INSTALL, prefix: process.platform === 'win32' ? join(root, 'PREFIX') : prefix },
        createLayout,
        runManagedUpgrade: otherRunner,
      }),
    })
    assert.equal((await get(fresh.routes, '/api/maintain/status')).payload.awaitingRestart, true)
    assert.equal((await invokePreStep(fresh.ctx, 1)).kind, 'reject')
    assert.equal((await post(fresh.routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })).status, 409)
    assert.equal((await post(fresh.routes, '/api/maintain/restart', { force: true })).status, 409)
    assert.equal((await post(fresh.routes, '/api/maintain/safe-mode/restore')).status, 409)
    assert.deepEqual(fresh.exits, [])
    assert.deepEqual(otherRunner.calls, [])
    assert.deepEqual(calls, [])
  } finally {
    releaseRunner.resolve()
  }
  const result = await waitForUpgradeResult(old.routes)
  assert.equal(switched, false)
  assert.match(result.error, /维护插件已卸载/)
  assert.deepEqual(old.exits, [])
})

test('M0:重新装载后已调度重启仍幂等,暂停持续到一次退出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  const exits = []
  const options = {
    profileDir, exits, services: IDLE_SERVICES,
    dependencies: DEPS({ runningInstall: { ...RUNNING_INSTALL, prefix: root }, createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot, prefix: root }) }),
  }
  const old = makeCtx(options)
  assert.equal((await post(old.routes, '/api/maintain/restart')).status, 200)
  old.ctx.disposeEffects()
  const fresh = makeCtx({ ...options, applyPlugin: (await import('../src/index.js?gate-hmr-restart')).apply })
  assert.equal((await get(fresh.routes, '/api/maintain/status')).payload.awaitingRestart, true)
  assert.equal((await invokePreStep(fresh.ctx, 1)).kind, 'reject')
  assert.equal((await post(fresh.routes, '/api/maintain/restart')).status, 200)
  assert.equal((await post(fresh.routes, '/api/maintain/safe-mode/restore')).status, 409)
  t.mock.timers.tick(RESTART_DELAY_MS)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE])
})

test('M0:切槽后 argv 入口指向新槽，HMR 仍识别原运行槽及退出门闩', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { root, profileDir } = await makePackageAssets(t)
  const prefix = join(root, 'npm')
  const originalPackage = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@deepseek-ai', 'dsh')
  const managedRoot = join(prefix, '.dsh-maintain')
  const runningPackage = join(managedRoot, 'install-a', 'node_modules', '@deepseek-ai', 'dsh')
  const candidatePackage = join(managedRoot, 'install-b', 'node_modules', '@deepseek-ai', 'dsh')
  const link = join(originalPackage, 'dsh_link')
  for (const [pkg, version] of [[originalPackage, '0.9.0'], [runningPackage, '1.0.0'], [candidatePackage, '9.9.9']]) {
    await mkdir(join(pkg, 'lib'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
    await writeFile(join(pkg, 'lib', 'bin.js'), '')
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(runningPackage, link, linkType)
  const priorArgv = process.argv[1]
  process.argv[1] = join(link, 'lib', 'bin.js')
  t.after(() => { process.argv[1] = priorArgv })
  const options = {
    profileDir, installAnchor: join(runningPackage, 'package.json'), services: IDLE_SERVICES,
    dependencies: { runningInstall: undefined },
  }
  const old = makeCtx(options)
  const accepted = await post(old.routes, '/api/maintain/restart')
  assert.equal(accepted.status, 200)
  await rm(link)
  await symlink(candidatePackage, link, linkType)
  old.ctx.disposeEffects()
  const fresh = makeCtx({ ...options, applyPlugin: (await import('../src/index.js?gate-hmr-changed-target')).apply })
  const status = (await get(fresh.routes, '/api/maintain/status')).payload
  assert.equal(status.managedReady, true)
  assert.equal(status.awaitingRestart, true)
  assert.equal((await invokePreStep(fresh.ctx, 1)).kind, 'reject')
})

test('M0:重启等待已排队的状态写入，调度后拒绝新的回执确认', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { root, managedRoot } = await makePackageAssets(t)
  const layout = { ...LAYOUT_STUB, root: managedRoot, prefix: root }
  const state = { operationId: 'old-failure', profileId: TEST_PROFILE_ID, targetVersion: '9.9.9', phase: 'failed' }
  await saveManagedState(layout, state)
  const { routes, exits } = makeCtx({
    services: IDLE_SERVICES,
    dependencies: DEPS({ runningInstall: { ...RUNNING_INSTALL, prefix: root }, createLayout: async () => layout }),
  })
  assert.equal((await post(routes, '/api/maintain/restart')).status, 200)
  const lockPath = join(managedRoot, 'state.json.lock')
  await writeFile(lockPath, '{}', { flag: 'wx' })
  const write = saveManagedState(layout, state)
  try {
    t.mock.timers.tick(RESTART_DELAY_MS)
    assert.deepEqual(exits, [])
    const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId: state.operationId, result: 'failed' })
    assert.equal(ack.status, 409)
    assert.deepEqual(exits, [], '锁尚未释放时，退出不会在后续微任务中提前触发')
  } finally {
    await rm(lockPath)
    await write
  }
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE])
})

test('M0:不同进程的 upgrade.lock 存在时拒绝强制重启和恢复', async (t) => {
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  await writeFile(join(managedRoot, 'upgrade.lock'), JSON.stringify({ operationId: 'other', pid: process.pid + 1, startedAt: Date.now() }))
  await writeFile(join(managedRoot, 'safe-mode.json'), JSON.stringify({ operationId: 'old', targetVersion: '9.9.9', disabled: [{ name: '@scope/a' }] }))
  const calls = []
  const { routes, exits } = makeCtx({
    profileDir, services: { ...IDLE_SERVICES, pluginManager: rejectPluginCalls(calls, 'setBundleEnabled') },
    dependencies: DEPS({ runningInstall: { ...RUNNING_INSTALL, prefix: root }, createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot, prefix: root }) }),
  })
  assert.equal((await post(routes, '/api/maintain/restart', { force: true })).status, 409)
  assert.equal((await post(routes, '/api/maintain/safe-mode/restore')).status, 409)
  assert.deepEqual(calls, [])
  assert.deepEqual(exits, [])
})

test('M0:能定位安装 prefix 但布局无效时，已有升级锁仍阻止强制重启', async (t) => {
  const { root, managedRoot } = await makePackageAssets(t)
  await writeFile(join(managedRoot, 'upgrade.lock'), '{}')
  const { routes, exits } = makeCtx({ services: IDLE_SERVICES, dependencies: DEPS({
    runningInstall: { ...RUNNING_INSTALL, prefix: root },
    createLayout: async () => { throw new Error('原包 bin 无效') },
  }) })
  const response = await post(routes, '/api/maintain/restart', { force: true })
  assert.equal(response.status, 409)
  assert.match(response.payload.error, /upgrade\.lock/)
  assert.deepEqual(exits, [])
})

for (const owner of [null, 'another-profile']) {
  test(`M0:安全模式旧记录归属为 ${owner ?? '未知'} 时，不能由当前 profile 恢复`, async (t) => {
    const { profileDir, managedRoot } = await makePackageAssets(t)
    const path = join(managedRoot, 'safe-mode.json')
    const record = JSON.stringify({ operationId: 'op-legacy', profileId: owner, disabled: [{ name: '@scope/a' }] })
    await writeFile(path, record)
    const writes = []
    const { routes } = makeCtx({ profileDir, services: { ...IDLE_SERVICES, pluginManager: rejectPluginCalls(writes, 'setBundleEnabled') },
      dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }) }) })
    assert.equal((await get(routes, '/api/maintain/status')).payload.safeMode.active, false)
    assert.equal((await post(routes, '/api/maintain/safe-mode/restore')).status, 409)
    assert.deepEqual(writes, [])
    assert.equal(await readFile(path, 'utf8'), record)
  })
}

test('M0:恢复操作正在等待宿主时，HMR 后的同 prefix 实例拒绝升级与重启', async (t) => {
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  await writeFile(join(managedRoot, 'safe-mode.json'), JSON.stringify({ operationId: 'old', profileId: await realpath(profileDir), targetVersion: '9.9.9', disabled: [{ name: '@scope/a', version: '1.0.0' }] }))
  const startRestore = Promise.withResolvers()
  const releaseRestore = Promise.withResolvers()
  const dependencies = DEPS({ runningInstall: { ...RUNNING_INSTALL, prefix: root }, createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot, prefix: root }) })
  const old = makeCtx({ profileDir, dependencies, services: { ...IDLE_SERVICES, pluginManager: {
    async setBundleEnabled() {
      startRestore.resolve()
      return releaseRestore.promise
    },
  } } })
  const restore = post(old.routes, '/api/maintain/safe-mode/restore')
  try {
    await Promise.race([startRestore.promise, restore.then(() => assert.fail('恢复请求未调用宿主'))])
    old.ctx.disposeEffects()
    const fresh = makeCtx({ profileDir, dependencies, services: IDLE_SERVICES, applyPlugin: (await import('../src/index.js?gate-hmr-restore')).apply })
    assert.equal((await post(fresh.routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })).status, 409)
    assert.equal((await post(fresh.routes, '/api/maintain/restart', { force: true })).status, 409)
    assert.equal((await post(fresh.routes, '/api/maintain/safe-mode/restore')).status, 409)
    assert.deepEqual(fresh.exits, [])
  } finally {
    releaseRestore.resolve({ application: 'applied' })
    await restore
  }
  assert.equal((await restore).payload.restored, true)
})

test('M0:缺少可靠 profile 身份时不受理宿主升级', async (t) => {
  const { root, managedRoot } = await makePackageAssets(t)
  const runner = makeRunnerStub()
  const { routes } = makeCtx({
    profileDir: join(root, 'missing-profile'),
    services: IDLE_SERVICES,
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }), runManagedUpgrade: runner }),
  })
  assert.equal((await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })).status, 409)
  assert.deepEqual(runner.calls, [])
})

test('M0:共享安装的异主 profile 不能查看、落定或确认升级回执', async (t) => {
  const { root, profileDir, managedRoot } = await makePackageAssets(t)
  const otherDir = join(root, 'profiles', 'other')
  await mkdir(otherDir)
  const profileId = await realpath(profileDir)
  const stateFile = join(managedRoot, 'state.json')
  const operationId = 'op-profile-owner'
  const persisted = JSON.stringify({
    operationId, profileId, targetVersion: '1.0.0', targetPackage: RUNNING_INSTALL.originalPackage,
    phase: 'awaiting-restart', switchedAt: Date.now(),
  })
  await writeFile(stateFile, persisted)
  let foreignReads = 0
  let foreignReady
  const dependencies = DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }) })
  const { routes } = makeCtx({ profileDir: otherDir, dependencies, services: {
    appReady: { onReady: (callback) => { foreignReady = callback } },
    pluginInventory: { list: () => { foreignReads += 1; return [] } },
    pluginManager: { listBundles: () => { foreignReads += 1; return [] } },
  } })
  const foreign = (await get(routes, '/api/maintain/status')).payload
  assert.equal(foreign.lastUpgrade, null)
  assert.equal(foreign.healthChecking, false)
  await foreignReady()
  const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId, result: 'succeeded' })
  assert.equal(ack.status, 409)
  assert.equal(foreignReads, 0)
  assert.equal(await readFile(stateFile, 'utf8'), persisted)
  const owner = makeCtx({ profileDir, dependencies })
  assert.equal((await get(owner.routes, '/api/maintain/status')).payload.lastUpgrade?.operationId, operationId)
})

for (const field of ['upgradePlugins', 'safeMode']) {
  test('upgrade:' + field + ' 非布尔 400,runner 不得启动', async () => {
    const runner = makeRunnerStub()
    const { routes } = makeCtx({ services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
    for (const value of ['true', 1, null]) {
      const denied = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', [field]: value })
      assert.equal(denied.status, 400)
      assert.ok(denied.payload.error.includes(field))
    }
    await drainMicrotasks()
    assert.equal(runner.calls.length, 0)
  })
}

test('upgrade:runner 失败不调度退出,状态落定失败,可再次发起', async () => {
  const exits = []
  let calls = 0
  const runner = makeRunnerStub({ result: async () => { calls += 1; if (calls === 1) throw new Error('npm 安装失败'); return { operationId: 'op-2', switched: true, phase: 'awaiting-restart', slot: 'b' } } })
  const { ctx, routes } = makeCtx({ exits, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const first = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(first.status, 200)
  let failed = null
  for (let i = 0; i < 50 && failed === null; i += 1) {
    await realSleep(30)
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) failed = status
  }
  assert.ok(failed, '失败必须落定,不得停留进行中')
  assert.equal(failed.upgrade.last.ok, false)
  assert.equal(failed.upgrade.last.receiptLocalOnly, true)
  assert.match(failed.upgrade.last.error, /npm 安装失败/)
  await realSleep(RESTART_DELAY_MS + 50)
  assert.deepEqual(exits, [], '失败路径禁止调度退出')
  const retried = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(retried.status, 200, '失败落定后新请求必须放行')
  await drainMicrotasks()
  assert.equal(calls, 2)
})

test('restart:升级进行中 409 拒绝且不调度退出', async () => {
  const exits = []
  // deferred runner:升级持续进行中,轮询 restart 互斥
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const runner = makeRunnerStub({ result: () => gate.then(() => ({ operationId: 'op-1', switched: true, phase: 'awaiting-restart', slot: 'a' })) })
  const { ctx, routes } = makeCtx({ exits, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
  const upgrade = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(upgrade.status, 200)
  await drainMicrotasks()
  const denied = await post(routes, '/api/maintain/restart')
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /升级进行中/)
  release()
  await drainMicrotasks()
  assert.deepEqual(exits, [], '409 拒绝路径不得调度 exit')
})

test('upgrade:重启调度后触发升级 409(双向互斥)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ exits })
  const restart = await post(routes, '/api/maintain/restart')
  assert.equal(restart.status, 200)
  const denied = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /重启已调度/)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE])
})

// Given 重启调度窗口
// When 延迟到点
// Then 以非零计划重启码直接终止进程,不经启动器 appExit 的优雅停机
// (appExit 的 dispose 把在跑回合收成 aborted(disposed),自动继续只认 interrupted,重启后不续跑)
test('restart:延迟到点直接终止进程,不经 appExit 优雅停机', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { routes } = makeCtx({ exits })
  const restart = await post(routes, '/api/maintain/restart')
  assert.equal(restart.status, 200)
  assert.deepEqual(exits, [], '响应窗口内不得提前退出')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE], '延迟到点必须退出')
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /ctx\.get\('appExit'\)|appExit\(0\)/, '退出不得回退到 appExit 优雅停机')
})

// 进程管理器按退出码决定是否拉起:0 会被 systemd 默认 Restart=on-failure 与
// supervisord 默认 autorestart=unexpected + exitcodes=0 视为正常退出而停机,计划重启必须非零
test('restart:退出码非零且为专用计划重启码,托管默认策略可拉起', () => {
  assert.equal(RESTART_EXIT_CODE, 75, '计划重启使用 sysexits EX_TEMPFAIL')
})

test('upgrade:重启调度窗口内 refresh 409,registry-base 保存但不发起检查', async (t) => {
  // 关机延迟窗口内网络请求与磁盘读取都是半写状态风险:refresh 全拒,registry-base 只落盘
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = { registryBase: 'https://registry.npmjs.org' }
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    fetchCalls += 1
    return originalFetch(...args)
  }
  try {
    const exits = []
    const { ctx, routes } = makeCtx({ settingsStore: store, exits })
    let baseline = null
    for (let waited = 0; waited < 5000 && baseline === null; waited += 25) {
      const poll = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (poll && poll.checkedAt !== null) baseline = fetchCalls
      else await realSleep(25)
    }
    assert.ok(baseline !== null, '启动检查 5 秒内未完成')
    const restart = await post(routes, '/api/maintain/restart')
    assert.equal(restart.status, 200)
    const refresh = await post(routes, '/api/maintain/refresh')
    assert.equal(refresh.status, 409, '关机窗口内检查更新必须拒绝')
    const saved = await post(routes, '/api/maintain/registry-base', { base: 'https://mirror.example.org' })
    assert.equal(saved.status, 200, '镜像地址保存照常落盘')
    assert.equal(store.registryBase, 'https://mirror.example.org')
    assert.equal(saved.payload.registryBase, 'https://mirror.example.org', 'status 回显新地址')
    assert.equal(fetchCalls, baseline, '关机窗口内不得发起任何网络检查')
    t.mock.timers.tick(RESTART_DELAY_MS + 1)
    await drainMicrotasks()
    assert.deepEqual(exits, [RESTART_EXIT_CODE])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('status:快照携带 bootAt 实例代际', async () => {
  const { ctx, routes } = makeCtx()
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.status, 200)
  assert.equal(typeof status.payload.bootAt, 'number')
  assert.ok(Number.isFinite(status.payload.bootAt) && status.payload.bootAt > 0)
})

test('status:运行版本与已装版本双字段,verdict 以运行版本为准', async () => {
  const { ctx, routes } = makeCtx()
  // 等启动检查落定:installedVersion 由检查快照填充
  let ready = null
  for (let waited = 0; waited < 5000 && ready === null; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) ready = poll.payload
    else await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ready, '启动检查 5 秒内未完成')
  assert.ok('runningVersion' in ready, 'status 必须返回 runningVersion')
  assert.ok('installedVersion' in ready, 'status 必须返回 installedVersion')
  assert.equal(ready.currentVersion, undefined, '旧 currentVersion 字段移除,不保留兼容层')
  // 默认桩的受管布局路径不存在:已装版本未知(null),不是复用运行版本
  assert.equal(ready.installedVersion, null)
  assert.equal(ready.restartPending, false)
  assert.equal(ready.channelLatest, MOCK_TAGS.latest)
  assert.equal(ready.channelLatestValid, true, '合法 tag 必须标 valid,客户端据此放行安装')
  // 运行版本与已装版本来源不同(apply 缓存 vs 受管链接读盘):缺失时 verdict 未知
  if (ready.runningVersion === null) {
    assert.equal(ready.verdict, 'unknown')
  }
})

test('status:运行旧版本而链接指向新版本 → installedVersion 取链接槽且 restartPending=true', async () => {
  // Given 宿主进程仍跑 1.0.0,受管 dsh_link 已指向 2.0.0 的安装槽
  const { routes } = makeCtx({
    dependencies: {
      createLayout: async () => LAYOUT_STUB,
      readSelectedVersion: async () => '2.0.0',
    },
  })
  let ready = null
  for (let waited = 0; waited < 5000 && ready === null; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) ready = poll.payload
    else await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ready, '启动检查 5 秒内未完成')
  assert.equal(ready.runningVersion, '1.0.0')
  assert.equal(ready.installedVersion, '2.0.0')
  assert.equal(ready.restartPending, true, '已装严格领先运行必须提示重启后生效')
})

test('status:通道 tag 不是合法 semver 时 channelLatestValid=false(安装入口禁用依据)', async () => {
  const original = MOCK_TAGS.latest
  MOCK_TAGS.latest = 'not-semver'
  try {
    const { routes } = makeCtx()
    let ready = null
    for (let waited = 0; waited < 5000 && ready === null; waited += 25) {
      const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
      if (poll.payload.checkedAt !== null) ready = poll.payload
      else await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(ready, '启动检查 5 秒内未完成')
    assert.equal(ready.channelLatest, 'not-semver')
    assert.equal(ready.channelLatestValid, false)
  } finally {
    MOCK_TAGS.latest = original
  }
})

test('status:受管链接读取失败时 installedVersion=null,不伪装成运行版本', async () => {
  const { routes } = makeCtx({
    dependencies: {
      createLayout: async () => LAYOUT_STUB,
      readSelectedVersion: async () => { throw new Error('dsh_link 缺失') },
    },
  })
  let ready = null
  for (let waited = 0; waited < 5000 && ready === null; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) ready = poll.payload
    else await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ready, '启动检查 5 秒内未完成')
  assert.equal(ready.installedVersion, null)
  assert.equal(ready.restartPending, false)
})

test('poll-interval:超上界 400(秒转毫秒溢出防护)', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  const huge = await post(routes, '/api/maintain/poll-interval', { seconds: 1e308 })
  assert.equal(huge.status, 400)
  assert.equal(store.pollIntervalSec, undefined, '超上界值不得落盘')
})

test('upgrade:非法 body 先于门控校验,门控命中时非法 targetVersion 仍 400', async (t) => {
  // 锁定 handler 顺序:readBody 在全部门控之前,门控到置位之间零 await
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ctx, routes } = makeCtx({ services: IDLE_SERVICES })
  await post(routes, '/api/maintain/restart')
  const denied = await post(routes, '/api/maintain/upgrade', { targetVersion: 'latest' })
  assert.equal(denied.status, 400, 'body 非法时即使门控(重启已调度)命中也必须 400')
})

test('registry-base:带 query 或 hash 的输入 400', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  const withQuery = await post(routes, '/api/maintain/registry-base', { base: 'https://example.com?mirror=1' })
  assert.equal(withQuery.status, 400)
  const withHash = await post(routes, '/api/maintain/registry-base', { base: 'https://example.com#frag' })
  assert.equal(withHash.status, 400)
  assert.equal(store.registryBase, undefined)
})

test('restart:响应立即返回,延迟到点才退出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ exits })
  const ok = await post(routes, '/api/maintain/restart')
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.restarting, true)
  // 响应交付瞬间宿主必须仍在:exit 只能在延迟窗口之后执行
  assert.deepEqual(exits, [], '响应返回时 exit 不得已触发')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE])
})

test('restart:延迟窗口内重复请求幂等,exit 仅调度一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ exits })
  const first = await post(routes, '/api/maintain/restart')
  assert.equal(first.status, 200)
  const second = await post(routes, '/api/maintain/restart')
  assert.equal(second.status, 200)
  assert.equal(second.payload.restarting, true)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE], '重复请求不得叠加调度 exit')
})

test('readBody 超限:请求体走完后归一 413 而非连接重置', async () => {
  const { ctx, routes } = makeCtx()
  const req = makeReq({ method: 'POST' })
  const res = makeRes()
  const done = routes.get('/api/maintain/channel')(req, res)
  req.emit('data', Buffer.alloc(BODY_MAX_BYTES + 1, 'x'))
  req.emit('end')
  await done
  assert.equal(res.status, 413)
  assert.match(res.payload.error, /上限/)
  assert.equal(req.destroyed, undefined, '超限不得 destroy 请求')
})

// 真实 socket:Content-Length 与 chunked 两条路径都必须先收到结构化 413,而不是 ECONNRESET
async function rawHttp(port, requestText) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = connect(port, '127.0.0.1', () => socket.end(requestText))
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(new Error('raw socket 超时'))
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
}

async function makeRawServer(t) {
  const { routes } = makeCtx()
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return server.address().port
}

test('readBody 真实 socket:Content-Length 超限返回 413 且不 ECONNRESET', async (t) => {
  const port = await makeRawServer(t)
  const payload = 'x'.repeat(64 * 1024 + 1)
  const response = await rawHttp(port,
    'POST /api/maintain/channel HTTP/1.1\r\n'
    + 'Host: localhost\r\n'
    + 'Content-Type: application/json\r\n'
    + 'Content-Length: ' + Buffer.byteLength(payload) + '\r\n'
    + 'Connection: close\r\n\r\n'
    + payload)
  assert.match(response, /^HTTP\/1\.1 413/)
  assert.match(response, /"error":"请求体超过上限"/)
})

test('readBody 真实 socket:chunked 超限返回 413 且不 ECONNRESET', async (t) => {
  const port = await makeRawServer(t)
  const payload = 'x'.repeat(64 * 1024 + 1)
  const response = await rawHttp(port,
    'POST /api/maintain/channel HTTP/1.1\r\n'
    + 'Host: localhost\r\n'
    + 'Content-Type: application/json\r\n'
    + 'Transfer-Encoding: chunked\r\n'
    + 'Connection: close\r\n\r\n'
    + payload.length.toString(16) + '\r\n' + payload + '\r\n0\r\n\r\n')
  assert.match(response, /^HTTP\/1\.1 413/)
  assert.match(response, /"error":"请求体超过上限"/)
})

// R2-M1:真实大体积/慢速上传。旧实现 pause 后立即 413+close,客户端仍在写出请求体,
// 会写失败(EPIPE/ECONNRESET)或读不到结构化响应;新实现摘 data 监听并 resume 排空,
// 请求体走完才以 413 收尾。http 客户端按块写出,覆盖「响应前体未写完」的窗口。
const oversizeChannelBody = (bytes) => '{"channel":"' + 'x'.repeat(bytes) + '"}'

function httpPostBody(agent, port, { body, declared = true, chunkBytes = 64 * 1024, paceMs = 0 }) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' }
    if (declared) headers['content-length'] = String(Buffer.byteLength(body))
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/maintain/channel', method: 'POST', headers, agent }, (res) => {
      const parts = []
      res.on('data', (chunk) => parts.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('error', reject)
    void (async () => {
      for (let offset = 0; offset < body.length; offset += chunkBytes) {
        if (req.destroyed) return
        req.write(body.slice(offset, offset + chunkBytes))
        if (paceMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, paceMs))
      }
      req.end()
    })().catch(reject)
  })
}

function httpGetStatus(agent, port) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/maintain/status', method: 'GET', agent }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', reject)
    req.end()
  })
}

// 连接若被拖死,后续请求会永久悬挂:用明确 deadline 把悬挂转成失败
function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('跟随请求超时:连接被拖死')), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

const newHttpAgent = (t) => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())
  return agent
}

test('R2-M1:65KB 声明体真实 socket 收到 413 而非 ECONNRESET', async (t) => {
  const port = await makeRawServer(t)
  const agent = newHttpAgent(t)
  // Given 刚超上限的声明体(落在 socket 缓冲区边缘,旧实现响应先于体写完)
  const body = oversizeChannelBody(BODY_MAX_BYTES + 1024)
  const over = await withDeadline(httpPostBody(agent, port, { body }), 10000)
  // Then 完整 413 + JSON,连接未在响应交付前被撕
  assert.equal(over.status, 413)
  assert.deepEqual(JSON.parse(over.text), { error: '请求体超过上限' })
  // Then 服务仍可响应下一请求(keep-alive 连接或重连均可)
  const next = await withDeadline(httpGetStatus(agent, port), 5000)
  assert.equal(next.status, 200)
})

test('R2-M1:4MB 慢速声明体真实 socket 排空后收到 413', async (t) => {
  const port = await makeRawServer(t)
  const agent = newHttpAgent(t)
  // Given 4MB 声明体且分块带节奏写出:服务端必须边排空边等请求体走完
  const body = oversizeChannelBody(4 * 1024 * 1024)
  const over = await withDeadline(httpPostBody(agent, port, { body, paceMs: 1 }), 30000)
  assert.equal(over.status, 413)
  assert.deepEqual(JSON.parse(over.text), { error: '请求体超过上限' })
  const next = await withDeadline(httpGetStatus(agent, port), 5000)
  assert.equal(next.status, 200)
})

test('R2-M1:13MB chunked 超限体真实 socket 排空后收到 413', async (t) => {
  const port = await makeRawServer(t)
  const agent = newHttpAgent(t)
  // Given 无 Content-Length 的 13MB 分块体(按 data 计数超限,非声明路径)
  const body = oversizeChannelBody(13 * 1024 * 1024)
  const over = await withDeadline(httpPostBody(agent, port, { body, declared: false }), 30000)
  assert.equal(over.status, 413)
  assert.deepEqual(JSON.parse(over.text), { error: '请求体超过上限' })
  const next = await withDeadline(httpGetStatus(agent, port), 5000)
  assert.equal(next.status, 200)
})

test('readBody 客户端中途断开:aborted 以 400 请求已中止收敛', async () => {
  const { routes } = makeCtx()
  const req = makeReq({ method: 'POST' })
  const res = makeRes()
  const done = routes.get('/api/maintain/channel')(req, res)
  req.emit('data', Buffer.from('{"channel":"next"'))
  req.emit('aborted')
  await done
  assert.equal(res.status, 400)
  assert.deepEqual(res.payload, { error: '请求已中止' })
})

test('readBody 客户端中途断开:未 complete 的 close 同样 400 收敛', async () => {
  const { routes } = makeCtx()
  const req = makeReq({ method: 'POST' })
  req.complete = false
  const res = makeRes()
  const done = routes.get('/api/maintain/channel')(req, res)
  req.emit('data', Buffer.from('{"channel":"next"'))
  req.emit('close')
  await done
  assert.equal(res.status, 400)
  assert.deepEqual(res.payload, { error: '请求已中止' })
})

test('readBody:请求体已 complete 的 close 不误判中止', async () => {
  const { routes } = makeCtx()
  const req = makeReq({ method: 'POST' })
  req.complete = true
  const res = makeRes()
  const done = routes.get('/api/maintain/channel')(req, res)
  req.emit('data', Buffer.from('{"channel":"  "}'))
  req.emit('close')
  req.emit('end')
  await done
  assert.equal(res.status, 400)
  assert.equal(res.payload.error, 'channel 不能为空', 'close 在 complete 后属正常收尾,不得覆盖业务响应')
})

// R3-M1:真实半开连接。声明 1MB 只发 1KB 即 destroy,只监听 data/end/error 的旧实现
// 会以引擎错误文案收尾(或永久悬挂);补 aborted/close 后 handler 必须以 400「请求已中止」收敛。
test('R3-M1:客户端声明 1MB 只发 1KB 即断开,handler 不悬挂并回 400 请求已中止', async (t) => {
  const { routes } = makeCtx()
  const handler = routes.get('/api/maintain/channel')
  let outcome = null
  // 响应写不到对端(客户端已断开),截获服务端实际写出的状态与体
  let captured = null
  const server = createServer((req, res) => {
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, headers) => {
      captured = { status }
      return writeHead(status, headers)
    }
    const end = res.end.bind(res)
    res.end = (text) => {
      captured = { ...captured, text }
      return end(text)
    }
    void handler(req, res).then(
      () => { outcome = { status: res.statusCode } },
      (error) => { outcome = { error } },
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  await new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/maintain/channel',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) },
    })
    req.on('error', () => resolve())
    req.write('{"channel":"' + 'x'.repeat(1024) + '"')
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 50)
  })
  const deadline = Date.now() + 3000
  while (outcome === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(outcome, '客户端断开后 handler 必须收敛,不得永久悬挂')
  assert.equal(outcome.error, undefined, '中断须以 400 响应收敛,而非路由异常')
  assert.equal(outcome.status, 400)
  assert.deepEqual(JSON.parse(captured.text), { error: '请求已中止' }, '不得把引擎错误文案透出')
})

// ---- 活跃工作门控(S10)----

test('collectActiveWork:按SessionId查询所属job并检测未发布终端活动', () => {
  const pendingOwner = { id: 'session-pending', status: 'idle', ctx: { get: () => terminals } }
  const ownedJob = { id: 'job-owned', owner: 'session-pending', status: 'running' }
  const agents = { list: () => [pendingOwner] }
  const jobs = { list: (caller) => caller === 'session-pending' ? [ownedJob] : [] }
  const terminals = { list: () => [], hasOwnerActivity: (owner) => owner === pendingOwner }
  const result = collectActiveWork({ get: (name) => ({ agents, jobs, terminals })[name] })
  assert.equal(result.jobs, 1, 'owned job 必须按 SessionId 传给 jobs.list')
  assert.equal(result.terminals, 1, 'spawn-to-close 未发布终端也必须计活')
  assert.equal(result.total, 2)
  assert.equal(result.detectionAvailable, true)
})

test('collectActiveWork:agents/jobs/terminals 计活与去重', () => {
  const terminals = { list: (owner) => owner?.id === 'a1'
    ? [{ sessionId: 't1', status: { kind: 'running' } }, { sessionId: 't3', status: { kind: 'exited' } }]
    : [{ sessionId: 't1', status: { kind: 'running' } }, { sessionId: 't2', status: { kind: 'running' } }] }
  const agentA = { id: 'a1', status: 'running', ctx: { get: (name) => name === 'terminals' ? terminals : undefined } }
  const agentB = { id: 'a2', status: 'idle' }
  const agents = { list: () => [agentA, agentB] }
  const jobs = { list: (caller) => caller === 'a1' || caller === undefined
    ? [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'stopping' }, { id: 'j3', status: 'done' }]
    : [] }
  const result = collectActiveWork({ get: (name) => ({ agents, jobs, terminals })[name] })
  assert.deepEqual({ agents: result.agents, jobs: result.jobs, terminals: result.terminals }, { agents: 1, jobs: 2, terminals: 2 })
  assert.equal(result.total, 5)
  assert.equal(result.detectionAvailable, true)
})

test('collectActiveWork:服务缺失或异常 fail-open 降级', () => {
  const empty = collectActiveWork({ get: () => undefined })
  assert.deepEqual([empty.agents, empty.jobs, empty.terminals], [0, 0, 0])
  assert.equal(empty.detectionAvailable, false)
  const throwing = { get: () => ({ list: () => { throw new Error('boom') } }) }
  const degraded = collectActiveWork(throwing)
  assert.equal(degraded.total, 0)
  assert.equal(degraded.detectionAvailable, false)
  // 根作用域 terminals 缺失但 agent realm 有,不算降级(realm 隔离常态)
  const agent = { id: 'a1', status: 'idle', ctx: { get: (n) => (n === 'terminals' ? { list: () => [{ sessionId: 't1', status: { kind: 'running' } }] } : undefined) } }
  const realmOnly = collectActiveWork({ get: (n) => (n === 'agents' ? { list: () => [agent] } : n === 'jobs' ? { list: () => [] } : undefined) })
  assert.equal(realmOnly.terminals, 1)
  assert.equal(realmOnly.detectionAvailable, true)
})

test('collectActiveWork:无 agent 时 terminals 服务面不可见属常态,不降级', () => {
  const warns = []
  const originalWarn = console.warn
  console.warn = (text) => warns.push(String(text))
  try {
    const agents = { list: () => [] }
    const jobs = { list: () => [] }
    const result = collectActiveWork({ get: (n) => (n === 'agents' ? agents : n === 'jobs' ? jobs : undefined) })
    assert.deepEqual([result.agents, result.jobs, result.terminals], [0, 0, 0])
    assert.equal(result.detectionAvailable, true)
    // 告警断言受模块级去重影响恒真,防线是上一行 detectionAvailable 断言
    assert.equal(warns.some((text) => text.includes('活跃工作检测降级')), false, '常态空窗不得打降级告警')
  } finally {
    console.warn = originalWarn
  }
})

test('upgrade:存在活跃工作 409 拒绝,不可越', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running' }] }
  const jobs = { list: () => [] }
  const terminals = { list: () => [] }
  const { routes } = makeCtx({ services: { agents, jobs, terminals } })
  const denied = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /活跃工作/)
  assert.equal(denied.payload.items.agents, 1)
  assert.equal(denied.payload.detectionAvailable, true)
  const status = await get(routes, '/api/maintain/status').then((r) => r.payload)
  assert.equal(status.upgrade.running, false, '拒绝路径不得触发升级')
})

test('restart:活跃工作 409,force 越过', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const agents = { list: () => [{ id: 'a1', status: 'running' }] }
  const jobs = { list: () => [] }
  const { ctx, routes } = makeCtx({ exits, services: { agents, jobs } })
  const denied = await post(routes, '/api/maintain/restart')
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /活跃工作/)
  assert.deepEqual(exits, [])
  const forced = await post(routes, '/api/maintain/restart', { force: true })
  assert.equal(forced.status, 200)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE], 'force 越过后必须正常调度退出')
})

test('status:activeWork 概要进快照,服务缺失标 detectionAvailable=false', async () => {
  const { ctx, routes } = makeCtx()
  const status = await get(routes, '/api/maintain/status').then((r) => r.payload)
  assert.equal(status.activeWork.total, 0)
  assert.equal(status.activeWork.detectionAvailable, false)
})

// ---- 批 2 审查建议落地 ----

test('restart:null 体按空体处理,内部形态不泄漏', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ exits })
  const ok = await post(routes, '/api/maintain/restart', 'null')
  assert.equal(ok.status, 200, 'null 体须按空体处理,不得以内部错误形态 400/500 泄漏')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  await drainMicrotasks()
  assert.deepEqual(exits, [RESTART_EXIT_CODE], 'null 体等价空体:正常调度退出')
})

test('受管切换接线:切换成功必经统一退出入口调度关机(源码形态锁定)', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(source, /reason=managed-upgrade-switched/, '切换成功必须经 scheduleHostExit 关机')
  assert.match(source, /beforeSwitch/, '编排必须带提交前门控')
  assert.doesNotMatch(source, /upgradeCommandTemplate|buildUpgradeCommand|runUpgradeWithRetry/, '模板与重试链必须整体移除')
  assert.doesNotMatch(source, /UPGRADE_LOCK_PATH|upgradeLockStale/, '全局 tmp 锁必须整体移除')
  assert.doesNotMatch(source, /candidate-validation-unavailable/, '候选验证已落地,runner 门闩不得回归')
  // 单次意图边界:配置节 schema 与持久化写入均不得携带 autoRestart(防降级回持久开关)
  const configSchema = source.slice(source.indexOf('export const Config'), source.indexOf('function volatileWrap'))
  assert.ok(!configSchema.includes('autoRestart'), '自动重启不得进入持久配置节')
  assert.equal(source.match(/persistPatch\([^)]*autoRestart/g), null, '自动重启不得经 persistPatch 落盘')
  assert.match(source, /autoRestart === false/, '自动重启意图必须接入升级收尾分流')
  assert.match(source, /reason=post-switch-state-indeterminate/, '切换状态未知必须无视意图强制退出')
  assert.match(source, /dependencies\.exitHost/, '退出执行点必须可注入,禁止硬绑 process.exit')
})

test('运行安装发现:原始安装 win/posix 布局与接管后槽位反解', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, sep } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'discover-test-'))
  try {
    const manifest = JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' } })
    // 原始安装 win 布局:P/node_modules/@deepseek-ai/dsh
    const winPrefix = join(base, 'win-prefix')
    const winPkg = join(winPrefix, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(winPkg, 'lib'), { recursive: true })
    await writeFile(join(winPkg, 'package.json'), manifest)
    await writeFile(join(winPkg, 'lib', 'bin.js'), '')
    const winFound = discoverRunningInstall({ argv1: join(winPkg, 'lib', 'bin.js'), installAnchor: join(winPkg, 'package.json'), platform: 'win32' })
    assert.equal(winFound.error, null, winFound.error)
    assert.equal(winFound.prefix, winPrefix, 'win prefix 必须上跳 scope+node_modules 共三级')
    assert.equal(winFound.originalPackage, winPkg)
    assert.equal(winFound.runningPackage, winPkg, '原始安装运行包即原包')
    // 原始安装 posix 布局:P/lib/node_modules/@deepseek-ai/dsh
    const posixPrefix = join(base, 'posix-prefix')
    const posixPkg = join(posixPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(posixPkg, 'lib'), { recursive: true })
    await writeFile(join(posixPkg, 'package.json'), manifest)
    await writeFile(join(posixPkg, 'lib', 'bin.js'), '')
    const posixFound = discoverRunningInstall({ argv1: join(posixPkg, 'lib', 'bin.js'), installAnchor: join(posixPkg, 'package.json'), platform: 'posix' })
    assert.equal(posixFound.error, null, posixFound.error)
    assert.equal(posixFound.prefix, posixPrefix, 'posix prefix 必须多上跳 lib 一级')
    // dsh_link 接管后:realpath 落在受管槽,运行包=槽内包,原包按标准布局反解
    const takeoverPrefix = join(base, 'takeover-prefix')
    const original = join(takeoverPrefix, 'node_modules', '@deepseek-ai', 'dsh')
    const slotPkg = join(takeoverPrefix, '.dsh-maintain', 'install-a', 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(slotPkg, 'lib'), { recursive: true })
    await writeFile(join(slotPkg, 'package.json'), manifest)
    await writeFile(join(slotPkg, 'lib', 'bin.js'), '')
    await mkdir(original, { recursive: true })
    await writeFile(join(original, 'package.json'), manifest)
    const takeover = discoverRunningInstall({ argv1: join(slotPkg, 'lib', 'bin.js'), installAnchor: join(slotPkg, 'package.json'), platform: 'win32' })
    assert.equal(takeover.error, null, takeover.error)
    assert.equal(takeover.prefix, takeoverPrefix, '接管后 prefix 必须反解到原全局根')
    assert.equal(takeover.originalPackage, original, '接管后原包按标准布局反解')
    assert.equal(takeover.runningPackage, slotPkg, '接管后运行包是受管槽包')
    assert.ok(!takeover.prefix.endsWith('.dsh-maintain'), '禁止把受管槽当 prefix')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('upgrade:运行环境不参与切换判定(env 注入 manual 仍正常调度退出)', async (t) => {
  // DSH_MAINTAIN_RUNTIME_ENV 已无消费者:注入历史值证明切换语义与运行环境彻底解耦
  process.env.DSH_MAINTAIN_RUNTIME_ENV = 'manual'
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const exits = []
    const runner = makeRunnerStub()
    const { ctx, routes } = makeCtx({ exits, services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: runner }) })
    await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
    await drainMicrotasks()
    t.mock.timers.tick(RESTART_DELAY_MS + 1)
    await drainMicrotasks()
    assert.deepEqual(exits, [RESTART_EXIT_CODE], '切换成功即调度退出,运行环境不得抑制')
  } finally {
    delete process.env.DSH_MAINTAIN_RUNTIME_ENV
  }
})

// ---- 审计日志(S12)----

test('audit:触发/落定/拒绝各留一行结构化日志', async () => {
  const warns = []
  const originalWarn = console.warn
  console.warn = (text) => warns.push(String(text))
  try {
    const agents = { list: () => [{ id: 'a1', status: 'running' }] }
    const { routes } = makeCtx({ services: { agents } })
    await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
    assert.equal(warns.some((text) => text.includes('audit endpoint=upgrade outcome=rejected reason=active-work')), true, '门控拒绝须留审计行')
    await post(routes, '/api/maintain/restart')
    assert.equal(warns.some((text) => text.includes('audit endpoint=restart outcome=rejected reason=active-work')), true, '重启门控拒绝须留审计行')
    await post(routes, '/api/maintain/restart', { force: true })
    assert.equal(warns.some((text) => /audit endpoint=restart outcome=triggered\b/.test(text) && text.includes('forced=true')), true, 'force 触发须留审计行')
  } finally {
    console.warn = originalWarn
  }
  // 升级触发与等待重启分别留痕，后者带 operationId
  const plainWarns = []
  const plainCtx = makeCtx({ services: IDLE_SERVICES, dependencies: DEPS({ runManagedUpgrade: makeRunnerStub() }) })
  console.warn = (text) => plainWarns.push(String(text))
  try {
    await post(plainCtx.routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
    await drainMicrotasks()
  } finally {
    console.warn = originalWarn
  }
  assert.equal(plainWarns.some((text) => /audit endpoint=upgrade outcome=triggered/.test(text)), true, '升级触发须留审计行')
  assert.equal(plainWarns.some((text) => /audit endpoint=upgrade outcome=awaiting-restart operationId=op-1\b/.test(text)), true, '等待重启须留审计行')
  assert.equal(plainWarns.some((text) => /audit endpoint=upgrade outcome=ok\b/.test(text)), false, '健康确认前不得留下成功审计行')
})

// ---- release notes 路由 ----

const RELEASE_PATH = '/api/maintain/release-notes'
// 发布页 fixture:与真实页面同构(relative-time + markdown-body 正文容器),正文映射由 core 提取器完成
const RELEASE_HTML = '<!doctype html><html><body>'
  + '<relative-time datetime="2026-09-10T03:09:00Z"></relative-time>'
  + '<div data-test-selector="body-content" class="markdown-body">'
  + '<h3>更新内容</h3>'
  + '<ul><li>新功能</li><li>问题修复</li></ul>'
  + '<p>详情见发布页。</p>'
  + '</div></body></html>'
const RELEASE_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v9.9.9'
const RELEASE_BODY = ['### 更新内容', '- 新功能', '- 问题修复', '', '详情见发布页。'].join('\n')

function releaseHtmlBody() {
  const chunks = [new TextEncoder().encode(RELEASE_HTML)]
  return {
    getReader: () => ({
      read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
      cancel: async () => {},
    }),
  }
}

// dist-tags 与 GitHub 发布页双上游分流:registry 路径回 tags 形态,GitHub 路径回页面形态
function installDualUpstream({ requestedUrls, releaseThrows }) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const text = String(url)
    if (text.includes('/releases/tag/')) {
      requestedUrls.push(text)
      if (releaseThrows) throw new Error(releaseThrows)
      return { ok: true, status: 200, body: releaseHtmlBody() }
    }
    void options
    return tagsBody(MOCK_TAGS)
  }
  return () => { globalThis.fetch = originalFetch }
}

async function waitSnapshotReady(routes) {
  for (let waited = 0; waited < 5000; waited += 25) {
    const poll = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (poll && poll.checkedAt !== null) return poll
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

test('release-notes:默认取通道最新版,200 返回发布说明', async () => {
  const requestedUrls = []
  const restore = installDualUpstream({ requestedUrls })
  try {
    const { ctx, routes } = makeCtx({ services: { hostVersionProbe: () => Promise.resolve('5.4.3') } })
      assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
    const res = await get(routes, RELEASE_PATH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.payload, {
      version: '9.9.9',
      url: RELEASE_URL,
      publishedAt: '2026-09-10T03:09:00Z',
      body: RELEASE_BODY,
    })
    assert.equal(requestedUrls.length, 1)
    assert.ok(requestedUrls[0].endsWith('/releases/tag/dsh-v9.9.9'), '默认版本必须取通道 latest 的目标')
  } finally {
    restore()
  }
})

test('release-notes:缓存生效,切通道后按新通道版本拉取', async () => {
  const requestedUrls = []
  const restore = installDualUpstream({ requestedUrls })
  try {
    const { ctx, routes } = makeCtx()
      assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
    const first = await get(routes, RELEASE_PATH)
    assert.equal(first.status, 200)
    assert.equal(first.payload.version, '9.9.9')
    assert.ok(requestedUrls[0].endsWith('/releases/tag/dsh-v9.9.9'))
    const again = await get(routes, RELEASE_PATH)
    assert.equal(again.status, 200)
    assert.equal(requestedUrls.length, 1, '同版本两次调用必须命中缓存,上游仅一次')
    const switched = await post(routes, '/api/maintain/channel', { channel: 'next' })
    assert.equal(switched.status, 200)
    assert.equal(switched.payload.channelLatest, '10.0.0')
    const after = await get(routes, RELEASE_PATH)
    assert.equal(after.status, 200)
    assert.equal(after.payload.version, '10.0.0')
    assert.equal(requestedUrls.length, 2, '通道版本变化必须重新拉取')
    assert.ok(requestedUrls[1].endsWith('/releases/tag/dsh-v10.0.0'))
  } finally {
    restore()
  }
})

test('release-notes:tags 未就绪且无 version 400 提示先检查更新', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const { ctx, routes } = makeCtx()
      assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
    const res = await get(routes, RELEASE_PATH)
    assert.equal(res.status, 400)
    assert.match(res.payload.error, /检查更新/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('release-notes:通道标签非 semver,构建上游标签前归一 400', async () => {
  const requestedUrls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const text = String(url)
    if (text.includes('/releases/tag/')) {
      requestedUrls.push(text)
      return { ok: true, status: 200, body: releaseHtmlBody() }
    }
    return tagsBody({ latest: 'banana' })
  }
  try {
    const { ctx, routes } = makeCtx()
      assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
    const res = await get(routes, RELEASE_PATH)
    assert.equal(res.status, 400)
    assert.match(res.payload.error, /semver/, '病理标签必须在触达上游前被 semver 白名单拦截')
    assert.equal(requestedUrls.length, 0, '拒绝路径不得触达上游')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('release-notes:重启调度窗口内 409,不发起上游请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requestedUrls = []
  const restore = installDualUpstream({ requestedUrls })
  try {
    const { ctx, routes } = makeCtx()
    const restart = await post(routes, '/api/maintain/restart')
    assert.equal(restart.status, 200)
    const res = await get(routes, RELEASE_PATH)
    assert.equal(res.status, 409, '关机窗口内查询更新内容必须拒绝')
    assert.match(res.payload.error, /重启已调度/)
    assert.equal(requestedUrls.length, 0, '关机窗口内不得发起上游请求')
    t.mock.timers.tick(RESTART_DELAY_MS + 1)
  } finally {
    restore()
  }
})

test('release-notes:缓存超限 FIFO 淘汰,最早键被逐出', async () => {
  // N+1 个通道各配独立版本:逐个切换并查看,第 N+1 键入缓存时第 1 键必被淘汰;
  // 回访第 1 通道触发重新拉取,回访末位通道命中缓存不再拉取
  const channels = {}
  for (let i = 1; i <= RELEASE_NOTES_CACHE_MAX + 1; i += 1) channels['c' + i] = '1.0.' + i
  const requestedUrls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/releases/tag/')) {
      requestedUrls.push(String(url))
      return { ok: true, status: 200, body: releaseHtmlBody() }
    }
    return tagsBody(channels)
  }
  try {
    const { ctx, routes } = makeCtx()
      assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
    for (const [name, version] of Object.entries(channels)) {
      const switched = await post(routes, '/api/maintain/channel', { channel: name })
      assert.equal(switched.status, 200)
      const res = await get(routes, RELEASE_PATH)
      assert.equal(res.status, 200)
      assert.equal(res.payload.version, version)
    }
    assert.equal(requestedUrls.length, RELEASE_NOTES_CACHE_MAX + 1, '每通道版本独立,各拉取一次')
    const first = Object.keys(channels)[0]
    const last = Object.keys(channels)[RELEASE_NOTES_CACHE_MAX]
    const backToFirst = await post(routes, '/api/maintain/channel', { channel: first })
    assert.equal(backToFirst.status, 200)
    await get(routes, RELEASE_PATH)
    assert.equal(requestedUrls.length, RELEASE_NOTES_CACHE_MAX + 2, '最早键已被淘汰,回访必须重新拉取')
    const backToLast = await post(routes, '/api/maintain/channel', { channel: last })
    assert.equal(backToLast.status, 200)
    await get(routes, RELEASE_PATH)
    assert.equal(requestedUrls.length, RELEASE_NOTES_CACHE_MAX + 2, '未淘汰键回访必须命中缓存')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('release-notes:上游失败 400 带错误信息', async () => {
  const requestedUrls = []
  const restore = installDualUpstream({ requestedUrls, releaseThrows: 'ECONNRESET' })
  try {
    const { ctx, routes } = makeCtx()
      assert.ok(await waitSnapshotReady(routes), '启动检查 5 秒内未完成')
    const res = await get(routes, RELEASE_PATH)
    assert.equal(res.status, 400)
    assert.match(res.payload.error, /ECONNRESET/)
  } finally {
    restore()
  }
})

// ── F08: 显式暂停契约 ──────────────────────────────────────────────────────
test('F08: 维护态 pre-step 拒绝携带"已切换暂停重启可用"说明,状态快照 awaitingRestart 置位', async () => {
  const { ctx, routes } = makeCtx()
  const hook = ctx.calls.agentHook
  assert.ok(hook?.listener, 'pre-step 钩子必须已挂')
  const next = async () => ({ kind: 'continue' })
  const newTurn = { step: 1, messages: [{ role: 'user', source: { kind: 'user' } }], signal: { aborted: false } }
  // 非维护态:放行
  const pass = await hook.listener(newTurn, next)
  assert.equal(pass.kind, 'continue')
  // 经 restart 路由进入维护态(scheduleHostExit 置 active,退出延迟未到进程仍在)
  await post(routes, '/api/maintain/restart', { force: true })
  const reject = await hook.listener(newTurn, next)
  assert.equal(reject.kind, 'reject')
  assert.match(String(reject.message ?? ''), /暂停新回合|重启后可用/)
  // status 快照携带结构化 awaitingRestart
  const res = await get(routes, '/api/maintain/status')
  assert.equal(res.payload.awaitingRestart, true)
})

test('F08: 维护态只拦新回合,在跑回合与目标轮次放行', async () => {
  const { ctx, routes } = makeCtx()
  const hook = ctx.calls.agentHook
  assert.ok(hook?.listener, 'pre-step 钩子必须已挂')
  const next = async () => ({ kind: 'continue' })
  await post(routes, '/api/maintain/restart', { force: true })
  // 在跑回合的后续步放行:拒绝会落成 turn/end blocked,恢复方无法与模型声明受阻区分
  const inFlight = await hook.listener({ step: 3, messages: [], signal: { aborted: false } }, next)
  assert.equal(inFlight.kind, 'continue')
  // 目标轮次是 driver 的自动续跑:拒绝会被记成 blocked(prompt-rejected),整条目标停摆
  const goalRound = await hook.listener(
    { step: 1, messages: [{ role: 'user', source: { kind: 'goal', goalId: 'g1', round: 3 } }], signal: { aborted: false } },
    next,
  )
  assert.equal(goalRound.kind, 'continue')
  // 真人新回合仍被暂停契约拦住
  const userTurn = await hook.listener(
    { step: 1, messages: [{ role: 'user', source: { kind: 'user' } }], signal: { aborted: false } },
    next,
  )
  assert.equal(userTurn.kind, 'reject')
  // 缺 step 的载荷按新回合处理,维持暂停契约
  const missingStep = await hook.listener({ messages: [], signal: { aborted: false } }, next)
  assert.equal(missingStep.kind, 'reject')
  // 非正式轮次(round 缺失)不算目标轮次
  const malformedGoal = await hook.listener(
    { step: 1, messages: [{ role: 'user', source: { kind: 'goal' } }], signal: { aborted: false } },
    next,
  )
  assert.equal(malformedGoal.kind, 'reject')
})

// ── 宿主闸门:插件路由必须回问 connection,不能绕开 cookie 认证 ───────────────
test('未通过宿主认证的请求在业务面之前被拒', async () => {
  const { ctx, routes } = makeCtx()
  ctx.connectionAdmission = 401
  const res = await get(routes, '/api/maintain/status')
  assert.equal(res.status, 401)
  assert.equal(res.payload, null, '不得回业务 JSON')
  ctx.connectionAdmission = 403
  const forbidden = await get(routes, '/api/maintain/status')
  assert.equal(forbidden.status, 403)
})

test('宿主闸门放行后业务照常', async () => {
  const { ctx, routes } = makeCtx()
  ctx.connectionAdmission = undefined
  const res = await get(routes, '/api/maintain/status')
  assert.ok(res.status === 200 || res.status === 400 || res.status === 503)
})

test('preflight:按目标版本返回检查报告', async () => {
  const { routes } = makeCtx({ dependencies: DEPS({
    runPreflight: async ({ targetVersion }) => ({ targetVersion, ok: true, checks: [], plugins: [] }),
  }) })
  const res = await post(routes, '/api/maintain/preflight', { targetVersion: '9.9.9' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.targetVersion, '9.9.9')
  assert.equal(res.payload.ok, true)
})

test('preflight:报告缺安全模式字段时也明确返回已关闭', async () => {
  const { routes } = makeCtx({ dependencies: DEPS({ runPreflight: async () => ({ ok: true, checks: [] }) }) })
  const res = await post(routes, '/api/maintain/preflight', { targetVersion: '9.9.9' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.okWithSafeMode, false)
  assert.equal(res.payload.safeMode.available, false)
  assert.match(res.payload.safeMode.reason, /已关闭/)
  assert.deepEqual(res.payload.safeMode.candidates, [])
  assert.deepEqual(res.payload.safeMode.protected, [])
})

test('preflight:目标版本非法 400', async () => {
  const { routes } = makeCtx({ dependencies: DEPS({ runPreflight: async () => ({ ok: true }) }) })
  const res = await post(routes, '/api/maintain/preflight', { targetVersion: 'latest' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /精确 semver/)
})

test('upgrade:服务端预检环境失败 409,runner 不得启动', async () => {
  const runner = makeRunnerStub()
  const { routes } = makeCtx({
    services: IDLE_SERVICES,
    dependencies: DEPS({
      runManagedUpgrade: runner,
      runPreflight: async () => ({ environmentOk: false, checks: [{ id: 'disk', label: '磁盘空间', status: 'block' }] }),
    }),
  })
  const denied = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /环境检查未通过/)
  assert.equal(runner.calls.length, 0)
})

test('upgrade:并发请求在预检窗口内只允许一个进入编排', async () => {
  const runner = makeRunnerStub()
  let releasePreflight
  const preflightGate = new Promise((resolve) => { releasePreflight = resolve })
  const { routes } = makeCtx({
    services: IDLE_SERVICES,
    dependencies: DEPS({
      runManagedUpgrade: runner,
      runPreflight: async () => { await preflightGate; return PREFLIGHT_OK },
    }),
  })
  const first = post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  await realSleep(20)
  const second = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(second.status, 409)
  releasePreflight()
  const accepted = await first
  assert.equal(accepted.status, 200)
  assert.equal(runner.calls.length, 1)
})

test('M0 A1:预检的插件硬不兼容直接拒绝宿主升级且不重复扫描', async () => {
  const runner = makeRunnerStub()
  const calls = []
  const { routes } = makeCtx({
    services: IDLE_SERVICES,
    dependencies: DEPS({
      runManagedUpgrade: runner,
      runPreflight: async () => ({
        ...PREFLIGHT_OK, ok: false,
        pluginSummary: { block: 1, warn: 0, ok: 0, total: 1 },
        plugins: [{ name: '@scope/a', version: '1.0.0', status: 'block', reasons: ['不兼容'] }],
      }),
      ...rejectPluginCalls(calls, 'scanPlugins'),
    }),
  })
  const res = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9' })
  assert.equal(res.status, 409)
  assert.match(res.payload.error, /不兼容/)
  assert.deepEqual(calls, [])
  assert.deepEqual(runner.calls, [])
})

test('safe-mode:按记录恢复插件并清除文件', async (t) => {
  const { mkdtemp, writeFile, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-safe-restore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'safe-mode.json'), JSON.stringify({
    operationId: 'op-1',
    profileId: TEST_PROFILE_ID,
    targetVersion: '9.9.9',
    disabled: [{ name: '@scope/a', version: '1.0.0' }],
  }))
  const calls = []
  const pluginManager = {
    listBundles: async () => [],
    setBundleEnabled: async (name, enabled) => { calls.push([name, enabled]) },
  }
  const { routes } = makeCtx({
    services: { ...IDLE_SERVICES, pluginManager },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  const res = await post(routes, '/api/maintain/safe-mode/restore', {})
  assert.equal(res.status, 200)
  assert.equal(res.payload.restored, true)
  assert.deepEqual(calls, [['@scope/a', true]])
  await assert.rejects(access(join(root, 'safe-mode.json')))
})

test('safe-mode:人工恢复进行中拒绝升级，且不启动预检或 runner', async (t) => {
  const { managedRoot } = await makePackageAssets(t)
  await writeFile(join(managedRoot, 'safe-mode.json'), JSON.stringify({
    operationId: 'op-restore', profileId: TEST_PROFILE_ID, targetVersion: '9.9.9', disabled: [{ name: '@scope/a', version: '1.0.0' }],
  }))
  const restoring = Promise.withResolvers()
  const finishRestore = Promise.withResolvers()
  const runner = makeRunnerStub()
  let preflights = 0
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      pluginManager: { setBundleEnabled: async () => { restoring.resolve(); await finishRestore.promise } },
    },
    dependencies: DEPS({
      createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }),
      runPreflight: async () => { preflights += 1; return PREFLIGHT_OK },
      runManagedUpgrade: runner,
    }),
  })
  const restore = post(routes, '/api/maintain/safe-mode/restore', {})
  try {
    await withDeadline(restoring.promise, 5 * 1000)
    const response = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
    assert.equal(response.status, 409)
    assert.match(response.payload.error, /恢复/)
    assert.equal(preflights, 0)
    assert.deepEqual(runner.calls, [])
  } finally {
    finishRestore.resolve()
    await restore
  }
  assert.equal((await restore).payload.restored, true)
})

test('safe-mode:宿主升级准备中拒绝人工恢复并保留记录', async (t) => {
  const { managedRoot } = await makePackageAssets(t)
  const restoreFile = join(managedRoot, 'safe-mode.json')
  const history = JSON.stringify({ operationId: 'op-restore', targetVersion: '9.9.9', disabled: [{ name: '@scope/a', version: '1.0.0' }] })
  await writeFile(restoreFile, history)
  const preparation = Promise.withResolvers()
  const calls = []
  const runner = makeRunnerStub({ result: async () => {
    await preparation.promise
    return { operationId: 'op-host-only', switched: true, phase: 'awaiting-restart', slot: 'a' }
  } })
  const { routes } = makeCtx({
    services: { ...IDLE_SERVICES, pluginManager: rejectPluginCalls(calls, 'setBundleEnabled') },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root: managedRoot }), runManagedUpgrade: runner }),
  })
  try {
    const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
    assert.equal(accepted.status, 200)
    assert.equal(runner.calls.length, 1)
    const response = await post(routes, '/api/maintain/safe-mode/restore', {})
    assert.equal(response.status, 409)
    assert.match(response.payload.error, /升级/)
    assert.deepEqual(calls, [])
    assert.equal(await readFile(restoreFile, 'utf8'), history)
  } finally {
    preparation.resolve()
    await drainMicrotasks()
  }
})

test('status:state 目标与运行版本一致时 lastUpgrade 标记落地', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-landed-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-1',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    previousVersion: '0.1.0',
    phase: 'awaiting-restart',
    startedAt: 100,
    finishedAt: 300,
    elapsedMs: 200,
  }))
  const { routes } = makeCtx({ services: { hostVersionProbe: () => '0.1.1', appReady: { onReady: () => {} } }, dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }) })
  assert.ok(await waitSnapshotReady(routes))
  const res = await get(routes, '/api/maintain/status')
  assert.equal(res.status, 200)
  assert.equal(res.payload.lastUpgrade.landed, true)
  assert.equal(res.payload.lastUpgrade.ok, null)
  assert.equal(res.payload.lastUpgrade.previousVersion, '0.1.0')
  assert.equal(res.payload.lastUpgrade.elapsedMs, 200)
})

test('健康检查:appReady 后核对插件失败并把 state 标 degraded', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-health-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-1',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'awaiting-restart',
    startedAt: 100,
  }))
  let ready = null
  const appReady = { onReady: (listener) => { ready = listener } }
  const inventoryStarted = Promise.withResolvers()
  const inventoryResult = Promise.withResolvers()
  const pluginInventory = { list: async () => { inventoryStarted.resolve(); return inventoryResult.promise } }
  const pluginManager = { listBundles: async () => [{ name: '@scope/b', error: 'incompatible' }] }
  const { routes } = makeCtx({
    services: { ...IDLE_SERVICES, hostVersionProbe: () => '0.1.1', appReady, pluginInventory, pluginManager },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  assert.equal(typeof ready, 'function')
  const checking = ready()
  try {
    await withDeadline(Promise.race([inventoryStarted.promise, checking.then(() => assert.fail('健康检查未查询库存'))]), 5 * 1000)
    const during = (await get(routes, '/api/maintain/status')).payload
    assert.equal(during.healthChecking, true)
    assert.equal(during.lastUpgrade.ok, null)
  } finally {
    inventoryResult.resolve({ entries: [{ entryId: 'a', moduleName: '@scope/a', fiberPhase: 'failed', diagnostic: 'boom' }] })
    await checking
  }
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'degraded')
  assert.equal(state.health.failed[0].moduleName, '@scope/a')
  const payload = (await get(routes, '/api/maintain/status')).payload
  assert.equal(payload.healthChecking, false)
  assert.equal(payload.lastUpgrade.health.ok, false)
  assert.equal(payload.lastUpgrade.health.failed[0].moduleName, '@scope/a')
})

test('健康检查:新宿主落地不再自动升级插件,state.json 的插件记录原样展示', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-post-plugins-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-post-plugins',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'awaiting-restart',
    startedAt: 100,
    plugins: { requested: true, total: 1, items: [{ name: '@scope/a', state: 'updated', from: '1.0.0', to: '1.1.0' }], error: null },
  }))
  const calls = []
  let ready = null
  const pluginManager = {
    listBundles: async () => [{ name: '@scope/a', installed: true, update: 'registry', version: '1.1.0' }],
    listVersions: async (name) => {
      calls.push(['listVersions', name])
      return { status: 'listed', installed: '1.1.0', registry: null, versions: [] }
    },
    updateBundle: async (name, version) => {
      calls.push(['updateBundle', name, version])
      return { result: { application: 'applied' } }
    },
  }
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      hostVersionProbe: () => '0.1.1',
      appReady: { onReady: (listener) => { ready = listener } },
      pluginInventory: { list: async () => ({ entries: [] }) },
      pluginManager,
    },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  await ready()
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'healthy')
  assert.deepEqual(state.plugins.items.map((row) => row.state), ['updated'])
  assert.deepEqual(calls, [], '新宿主落地不得再触发插件升级')
  const payload = (await get(routes, '/api/maintain/status')).payload
  assert.equal(payload.healthChecking, false)
  assert.equal(payload.lastUpgrade.ok, true)
  assert.equal(payload.lastUpgrade.health.ok, true)
  assert.equal(payload.lastUpgrade.plugins.items[0].name, '@scope/a')
})

test('M0 A1:旧 post-restart 待执行记录只读展示，启动复查不执行插件操作', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-legacy-pending-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const stateFile = join(root, 'state.json')
  const safeModeFile = join(root, 'safe-mode.json')
  const operationId = 'op-legacy-pending'
  const history = JSON.stringify({
    operationId,
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    phase: 'awaiting-restart',
    startedAt: 100,
    receiptSeen: false,
    plugins: { requested: true, pending: true, mode: 'post-restart', updated: [], failed: [], skipped: [] },
  })
  const restoreRecord = JSON.stringify({ operationId, targetVersion: '0.1.1', disabled: [{ name: '@scope/a', version: '1.0.0' }] })
  await writeFile(stateFile, history)
  await writeFile(safeModeFile, restoreRecord)

  const calls = []
  const forbidden = rejectPluginCalls(calls, 'listBundles', 'listVersions', 'updateBundle', 'setBundleEnabled', 'listInventory', 'scanPlugins', 'runManagedUpgrade')
  let ready
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      hostVersionProbe: () => '0.1.1',
      appReady: { onReady: (listener) => { ready = listener } },
      pluginInventory: { list: forbidden.listInventory },
      pluginManager: {
        listBundles: forbidden.listBundles,
        listVersions: forbidden.listVersions,
        updateBundle: forbidden.updateBundle,
        setBundleEnabled: forbidden.setBundleEnabled,
      },
    },
    dependencies: DEPS({
      createLayout: async () => ({ ...LAYOUT_STUB, root }),
      scanPlugins: forbidden.scanPlugins,
      runManagedUpgrade: forbidden.runManagedUpgrade,
    }),
  })
  const before = await get(routes, '/api/maintain/status')
  assert.equal(before.status, 200)
  await ready()
  const after = await get(routes, '/api/maintain/status')
  assert.equal(after.status, 200)
  assert.deepEqual(calls, [])
  assert.equal(await readFile(stateFile, 'utf8'), history)
  assert.equal(await readFile(safeModeFile, 'utf8'), restoreRecord)
  assert.deepEqual(after.payload.upgrade.last, before.payload.upgrade.last)
  assert.equal(after.payload.upgrade.last.historical, true)
  assert.equal(after.payload.upgrade.last.landed, false)
  assert.equal(after.payload.upgrade.last.ok, false)
  assert.equal(after.payload.upgrade.last.receiptSeen, false)
  assert.equal(after.payload.upgrade.last.receiptLocalOnly, true)
  assert.match(after.payload.upgrade.last.plugins.error, /未执行.*另行安排/)
  assert.equal(after.payload.safeMode.active, false)
})

test('M0 A10:已健康的宿主不会改写失败历史，手动确认只更新已读标记', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-healthy-failed-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const operationId = 'op-healthy-failed'
  const stateFile = join(root, 'state.json')
  const history = {
    operationId,
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'healthy',
    startedAt: 100,
    finishedAt: 200,
    receiptSeen: false,
    health: { ok: true, available: true, checkedAt: 200, failed: [], bundleErrors: [] },
    plugins: { requested: true, updated: [], failed: [{ name: '@scope/a', from: '1.0.0', to: '1.1.0', error: '安装失败' }], skipped: [] },
  }
  await writeFile(stateFile, JSON.stringify(history))

  let ready
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      hostVersionProbe: () => '0.1.1',
      appReady: { onReady: (listener) => { ready = listener } },
      pluginInventory: { list: async () => ({ entries: [] }) },
      pluginManager: { listBundles: async () => [] },
    },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  const before = (await get(routes, '/api/maintain/status')).payload.upgrade.last
  await ready()
  const rechecked = (await get(routes, '/api/maintain/status')).payload.upgrade.last
  for (const last of [before, rechecked]) {
    assert.equal(last.health.ok, true)
    assert.equal(last.ok, false)
    assert.equal(last.receiptSeen, false)
    assert.equal(last.plugins.items[0].error, '安装失败')
  }
  const reviewed = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(reviewed.receiptSeen, false)
  assert.deepEqual(reviewed.plugins, history.plugins)

  const stale = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId, result: 'succeeded' })
  assert.equal(stale.status, 409)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), reviewed)

  const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId, result: 'failed' })
  assert.equal(ack.status, 200)
  assert.equal(ack.payload.upgrade.last.ok, false)
  assert.equal(ack.payload.upgrade.last.receiptSeen, true)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { ...reviewed, receiptSeen: true, receiptResult: 'failed' })
})

test('健康检查:缺少 appReady 时，即使插件健康服务齐备也保持未知', async (t) => {
  const timer = t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('不得以定时器替代就绪信号')
  })
  const root = await mkdtemp(join(tmpdir(), 'maintain-health-no-app-ready-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const stateFile = join(root, 'state.json')
  const history = JSON.stringify({
    operationId: 'op-no-app-ready',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'awaiting-restart',
    startedAt: 100,
  })
  await writeFile(stateFile, history)
  const calls = []
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      hostVersionProbe: () => '0.1.1',
      pluginInventory: { list: async () => { calls.push('listInventory'); return { entries: [] } } },
      pluginManager: { listBundles: async () => { calls.push('listBundles'); return [] } },
    },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  const initial = (await get(routes, '/api/maintain/status')).payload
  assert.equal(initial.healthChecking, false)
  const before = initial.upgrade.last
  assert.equal(before.landed, true)
  assert.equal(before.pending, false)
  assert.equal(before.ok, null)
  const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId: 'op-no-app-ready', result: 'succeeded' })
  assert.equal(ack.status, 409)
  const after = (await get(routes, '/api/maintain/status')).payload.upgrade.last
  assert.equal(timer.mock.callCount(), 0)
  assert.deepEqual(calls, [])
  assert.deepEqual(after, before)
  assert.equal(await readFile(stateFile, 'utf8'), history)
})

test('健康检查:服务缺失时不得误写 healthy', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-health-missing-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-missing',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'awaiting-restart',
    startedAt: 100,
  }))
  let ready = null
  const { routes } = makeCtx({
    services: { ...IDLE_SERVICES, hostVersionProbe: () => '0.1.1', appReady: { onReady: (listener) => { ready = listener } } },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  await ready()
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'landed')
  assert.equal(state.health.available, false)
  assert.equal(state.health.ok, null)
  const payload = (await get(routes, '/api/maintain/status')).payload
  assert.equal(payload.lastUpgrade.ok, null)
  assert.equal(payload.lastUpgrade.health.available, false)
})

test('健康检查:插件快照形状不符按不可用处理', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-health-shape-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-shape',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'awaiting-restart',
    startedAt: 100,
  }))
  let ready = null
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      hostVersionProbe: () => '0.1.1',
      appReady: { onReady: (listener) => { ready = listener } },
      pluginInventory: { list: async () => ({ items: [] }) },
      pluginManager: { listBundles: async () => [] },
    },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  await ready()
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'landed')
  assert.equal(state.health.available, false)
  const payload = (await get(routes, '/api/maintain/status')).payload
  assert.equal(payload.lastUpgrade.ok, null)
})

test('健康检查:旧 degraded 状态在重启复核后纠正平台不支持误判', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'maintain-health-recheck-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-recheck',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'degraded',
    startedAt: 100,
    health: { ok: false, available: true, failed: [], bundleErrors: [{ name: '@deepseek-ai/dsh-cua-bundle', error: 'unsupported-platform' }] },
  }))
  let ready = null
  const { routes } = makeCtx({
    services: {
      ...IDLE_SERVICES,
      hostVersionProbe: () => '0.1.1',
      appReady: { onReady: (listener) => { ready = listener } },
      pluginInventory: { list: async () => ({ entries: [] }) },
      pluginManager: { listBundles: async () => [{ name: '@deepseek-ai/dsh-cua-bundle', error: 'unsupported-platform' }] },
    },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  const historical = (await get(routes, '/api/maintain/status')).payload
  assert.equal(historical.upgrade.historical, true)
  assert.equal(historical.lastUpgrade.historical, true)
  await ready()
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'healthy')
  assert.equal(state.health.bundleErrors.length, 0)
  const payload = (await get(routes, '/api/maintain/status')).payload
  assert.equal(payload.lastUpgrade.ok, true)
  assert.equal(payload.upgrade.historical, true)
})

test('M0 A10:升级结果未确定时，即使 operationId 匹配也不确认回执', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-receipt-pending-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const operationId = 'op-receipt-pending'
  const stateFile = join(root, 'state.json')
  const history = JSON.stringify({
    operationId,
    targetVersion: '2.0.0',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'awaiting-restart',
    startedAt: 100,
    receiptSeen: false,
  })
  await writeFile(stateFile, history)
  const { routes } = makeCtx({
    services: { hostVersionProbe: () => '0.1.1', appReady: { onReady: () => {} } },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  const before = (await get(routes, '/api/maintain/status')).payload.upgrade.last
  assert.equal(before.ok, null)
  assert.equal(before.pending, true)
  const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId, result: 'succeeded' })
  assert.equal(ack.status, 409)
  const after = (await get(routes, '/api/maintain/status')).payload.upgrade.last
  assert.deepEqual(after, before)
  assert.equal(await readFile(stateFile, 'utf8'), history)
})

test('receipt-ack:仅本次启动的成功回执可确认', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const stateFile = join(root, 'state.json')
  const { routes } = makeCtx({
    services: { ...IDLE_SERVICES, hostVersionProbe: () => '0.1.1' },
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }) }),
  })
  const { bootId } = (await get(routes, '/api/maintain/status')).payload
  assert.equal(typeof bootId, 'string')
  assert.ok(bootId.length > 0)
  const health = { ok: true, available: true, checkedAt: Date.now(), failed: [], bundleErrors: [] }
  const history = {
    operationId: 'op-receipt',
    targetVersion: '0.1.1',
    targetPackage: RUNNING_INSTALL.originalPackage,
    profileId: TEST_PROFILE_ID,
    phase: 'healthy',
    startedAt: 100,
  }
  for (const oldBootId of [undefined, 'previous-boot']) {
    const stale = JSON.stringify({ ...history, health: { ...health, bootId: oldBootId } })
    await writeFile(stateFile, stale)
    const status = (await get(routes, '/api/maintain/status')).payload.lastUpgrade
    assert.equal(status.landed, true)
    assert.equal(status.ok, null)
    const denied = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId: 'op-receipt', result: 'succeeded' })
    assert.equal(denied.status, 409)
    assert.equal(await readFile(stateFile, 'utf8'), stale)
  }
  await writeFile(stateFile, JSON.stringify({ ...history, health: { ...health, bootId } }))
  const before = (await get(routes, '/api/maintain/status')).payload
  assert.equal(before.lastUpgrade.ok, true)
  assert.equal(before.lastUpgrade.receiptSeen, false)
  const wrong = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId: 'other', result: 'succeeded' })
  assert.equal(wrong.status, 409)
  for (const result of [undefined, 'pending', 1]) {
    const invalid = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId: 'op-receipt', result })
    assert.equal(invalid.status, 400)
  }
  const unacknowledged = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.notEqual(unacknowledged.receiptSeen, true)
  const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId: 'op-receipt', result: 'succeeded' })
  assert.equal(ack.status, 200)
  assert.equal(ack.payload.lastUpgrade.receiptSeen, true)
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(state.receiptSeen, true)
})

test('status:同一 operationId 的失败回执已读标记合并进进程内 last', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-receipt-merge-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const operationId = 'op-1'
  const error = 'npm 安装失败'
  const runner = makeRunnerStub({ result: async (input) => {
    input.onPhase({ operationId, phase: 'installing' })
    await writeFile(join(root, 'state.json'), JSON.stringify({ operationId, profileId: input.profileId, targetVersion: input.targetVersion, phase: 'failed', error }))
    throw new Error(error)
  } })
  const { routes } = makeCtx({
    services: IDLE_SERVICES,
    dependencies: DEPS({ createLayout: async () => ({ ...LAYOUT_STUB, root }), runManagedUpgrade: runner }),
  })
  const accepted = await post(routes, '/api/maintain/upgrade', { targetVersion: '9.9.9', autoRestart: false })
  assert.equal(accepted.status, 200)
  const settled = await waitForUpgradeResult(routes)
  assert.equal(settled.operationId, operationId)
  assert.equal(settled.receiptSeen, false)
  assert.equal(settled.receiptLocalOnly, false)
  const ack = await post(routes, '/api/maintain/upgrade/receipt-ack', { operationId, result: 'failed' })
  assert.equal(ack.status, 200)
  const status = (await get(routes, '/api/maintain/status')).payload
  assert.equal(status.upgrade.historical, false)
  assert.equal(status.lastUpgrade.ok, false)
  assert.equal(status.lastUpgrade.error, error)
  assert.equal(status.lastUpgrade.receiptSeen, true)
})
