// 四模块开关契约:默认全关、只认显式 true、端点全量替换与非法输入拒收。
// 开关与各模块自身的额度 / 阈值分开,这里只锁开关语义。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FEATURE_KEYS, DEFAULT_FEATURES, normalizeFeatures, featureOn } from '../src/features.js'
import { registerUsageRoutes } from '../src/routes.js'
import { CLIENT_SOURCE } from './client-eval.mjs'

const ROUTE_PREFIX = '/api/usage-dash'

function makeCtx() {
  const routes = new Map()
  return {
    routes,
    logger: { warn() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    effect(setup) {
      setup()
    },
  }
}

const makeRes = () => {
  const res = {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status
      Object.assign(res.headers, headers ?? {})
    },
    setHeader(name, value) { res.headers[name] = value },
    end(chunk) { res.body = chunk ?? '' },
    write(chunk) { res.body += chunk ?? '' },
  }
  return res
}

// 宿主闸门在此桩中恒放行;同源校验由 registerUsageRoutes 共用的 gate 负责
// 读体走 for await,故 req 按异步可迭代提供
const makeReq = (method, body, path = `${ROUTE_PREFIX}/features`) => ({
  method,
  url: path,
  headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' },
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  },
})

const setup = (features) => {
  const ctx = makeCtx()
  const writes = []
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    features: {
      active: true,
      current: () => normalizeFeatures(features),
      replace: async (next) => {
        writes.push(next)
        features = next
        return normalizeFeatures(next)
      },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/features`)
  return { route, writes }
}

test('开关默认全关,且只有显式 true 才算打开', () => {
  assert.deepEqual(FEATURE_KEYS, ['whatif', 'guard', 'sentinel', 'dock'])
  assert.deepEqual(DEFAULT_FEATURES, { whatif: false, guard: false, sentinel: false, dock: false })
  assert.deepEqual(normalizeFeatures(undefined), DEFAULT_FEATURES)
  // 真值字符串、1、"on" 都不该被当成开启
  assert.deepEqual(normalizeFeatures({ whatif: 'true', guard: 1, sentinel: 'yes', dock: {} }), DEFAULT_FEATURES)
  assert.deepEqual(normalizeFeatures({ dock: true }), { ...DEFAULT_FEATURES, dock: true })
})

test('featureOn 只认布尔真值', () => {
  assert.equal(featureOn({ dock: true }, 'dock'), true)
  assert.equal(featureOn({ dock: 'true' }, 'dock'), false)
  assert.equal(featureOn(null, 'dock'), false)
})

test('Given 只开了护栏 When GET Then 回当前开关', async () => {
  const { route } = setup({ guard: true })
  const res = makeRes()
  await route.handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    value: { active: true, features: { ...DEFAULT_FEATURES, guard: true } },
  })
})

test('Given 提交全量四键 When POST Then 整体替换', async () => {
  const { route, writes } = setup({})
  const res = makeRes()
  const body = { features: { whatif: true, guard: true, sentinel: false, dock: true } }
  await route.handler(makeReq('POST', body), res)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], body.features)
  assert.deepEqual(JSON.parse(res.body).value.features, body.features)
})

test('Given 缺键 When POST Then 拒收且不落盘', async () => {
  const { route, writes } = setup({})
  const res = makeRes()
  await route.handler(makeReq('POST', { features: { guard: true } }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(writes.length, 0)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('Given 开关服务未激活 When POST Then 503 且不落盘', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/features`)
  const res = makeRes()
  await route.handler(makeReq('POST', { features: DEFAULT_FEATURES }), res)
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('Given 多提交一个拼错的键 When POST Then 400,不静默吞掉', async () => {
  const { route, writes } = setup({})
  const res = makeRes()
  await route.handler(makeReq('POST', { features: { ...DEFAULT_FEATURES, doock: true } }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(writes.length, 0)
})

test('Given 开关变化 When POST Then 立刻重算哨兵状态', async () => {
  const ctx = makeCtx()
  let refreshed = 0
  // 桩要维护「哨兵结论」与开关是否一致:路由按两者差异决定是否重算
  let sentinelEnabled = false
  let current = { ...DEFAULT_FEATURES }
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    sentinel: {
      status: () => ({ events: [], config: { enabled: sentinelEnabled } }),
      refresh: async () => { refreshed += 1; sentinelEnabled = current.sentinel === true },
    },
    features: {
      active: true,
      current: () => current,
      replace: async (next) => { current = normalizeFeatures(next); return current },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/features`)
  const res = makeRes()
  await route.handler(makeReq('POST', { features: { ...DEFAULT_FEATURES, sentinel: true } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(refreshed, 1)
  // 关掉同样要重算,否则状态停在上一轮的结论上
  await route.handler(makeReq('POST', { features: DEFAULT_FEATURES }), makeRes())
  assert.equal(refreshed, 2)
  assert.equal(sentinelEnabled, false)
})

// —— 客户端开关写入:全量四键、连续切换不丢改动、失败不改本地态 ——
// 求值整源后取 __test 暴露的写入函数,fetch 用全局桩接住
const INJECT_HOOK = "      inject: ['slots', 'locale', 'configForms'],"

function loadClientWriter() {
  const React = {
    createElement: () => null,
    memo: (fn) => fn,
    useState: () => [null, () => {}],
    useRef: () => ({ current: null }),
    useEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  let factory
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(
    INJECT_HOOK,
    `      __test: { toggleFeature, featuresOf, applyFeatures },\n${INJECT_HOOK}`,
  )
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  return factory((name) => (name === 'react' ? React : {})).__test
}

test('toggleFeature 每次都提交全量四键,连续切换基于最新值', async () => {
  const calls = []
  const origin = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.features)
    // 第一个请求故意慢,验证第二次不会拿着旧值覆盖它
    await new Promise((resolve) => setTimeout(resolve, calls.length === 1 ? 30 : 0))
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { active: true, features: body.features } }) }
  }
  try {
    const { toggleFeature, featuresOf } = loadClientWriter()
    await Promise.all([toggleFeature('guard', true), toggleFeature('dock', true)])
    assert.equal(calls.length, 2)
    for (const sent of calls) assert.deepEqual(Object.keys(sent).sort(), [...FEATURE_KEYS].sort())
    // 第二次提交必须带上前一次的结果,否则先写的开关被覆盖
    assert.equal(calls[1].guard, true)
    assert.equal(calls[1].dock, true)
    assert.deepEqual(featuresOf(), { ...DEFAULT_FEATURES, guard: true, dock: true })
  } finally {
    globalThis.fetch = origin
  }
})

test('toggleFeature 失败时不动本地开关', async () => {
  const origin = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: { code: 'unavailable', message: 'x' } }) })
  try {
    const { toggleFeature, featuresOf, applyFeatures } = loadClientWriter()
    applyFeatures(DEFAULT_FEATURES)
    const saved = await toggleFeature('guard', true)
    assert.equal(saved, false)
    assert.deepEqual(featuresOf(), DEFAULT_FEATURES)
  } finally {
    globalThis.fetch = origin
  }
})

// —— 开关卡渲染前提:用 toggle 的组件必须先取 hooks,否则渲染期就是 ReferenceError ——
function bracesFrom(source, open) {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return null
}

function functionBodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到 ${name}`)
  // 参数解构里也有花括号,函数体要从右括号之后开始找
  const body = bracesFrom(source, source.indexOf('{', source.indexOf(')', start)))
  assert.ok(body !== null, `${name} 花括号不闭合`)
  return body
}

// 箭头式组件声明(含 React.memo 包裹)也要纳入:换成箭头写法就绕开了 function 扫描
function componentBodies(source) {
  const bodies = new Map()
  for (const match of source.matchAll(/function ([A-Z][A-Za-z0-9]*)\(/g)) bodies.set(match[1], () => functionBodyOf(source, match[1]))
  for (const match of source.matchAll(/const ([A-Z][A-Za-z0-9]*) = (?:React\.memo\()?\(/g)) {
    if (bodies.has(match[1])) continue
    const arrow = source.indexOf('=>', match.index)
    const open = arrow >= 0 ? source.indexOf('{', arrow) : -1
    if (open < 0) continue
    const body = bracesFrom(source, open)
    if (body !== null) bodies.set(match[1], () => body)
  }
  return bodies
}

test('用 toggle 的开关卡必须在函数体顶层取 useFeatureToggle', () => {
  for (const name of ['WhatIfSection', 'GuardSection', 'SentinelSection', 'HudSummaryBody']) {
    const body = functionBodyOf(CLIENT_SOURCE, name)
    const match = /const \[[^\]]+\] = useFeatureToggle\(t\)/.exec(body)
    assert.ok(match, '缺少 useFeatureToggle 声明')
    // 声明前不能有新的块、return 或三元:包在 if 里同样是条件调用
    const head = body.slice(1, match.index)
    // 声明前只能是顶层 const:if、循环、箭头函数、三元把它包住都算条件调用
    assert.ok(!/\b(if|for|while|switch|return|function)\b/.test(head), '声明必须在函数体顶层且无条件')
    assert.ok(!/=>/.test(head), '声明不能在回调或箭头函数内')
    assert.ok(!/\?/.test(head), '声明不能挂在条件上')
  }
})

test('组件扫描认得出箭头与 React.memo 包裹的声明', () => {
  const sample = [
    'function Alpha() { const features = useFeatures(); return features.dock }',
    'const Beta = (props) => { const features = useFeatures(); return features.dock }',
    'const Gamma = React.memo((props) => { const features = useFeatures(); return features.dock })',
    'const Delta = React.memo(function Delta(props) { const features = useFeatures(); return features.dock })',
  ].join('\n')
  const bodies = componentBodies(sample)
  assert.deepEqual([...bodies.keys()].sort(), ['Alpha', 'Beta', 'Delta', 'Gamma'])
  for (const bodyOf of bodies.values()) assert.match(bodyOf(), /const features = useFeatures\(\)/)
})

test('用到 features 的组件必须自己取 useFeatures', () => {
  // 不列白名单:新增组件漏取 hook 正是设置页白屏的成因,名单永远追不上新组件
  const bodies = componentBodies(CLIENT_SOURCE)
  assert.ok(bodies.size > 20, `应扫到足够多的组件,实际 ${bodies.size}`)
  let checked = 0
  for (const [name, bodyOf] of bodies) {
    const body = bodyOf()
    // 花括号计数不认识字符串,截断的体仍能通过 features 检查,用编译兜住
    assert.doesNotThrow(() => new Function(body), `${name} 的函数体取错了`)
    if (!/\bfeatures\s*(?:\.|\?\.|\[)/.test(body)) continue
    checked += 1
    const at = body.indexOf('const features = useFeatures()')
    assert.ok(at > 0, `${name} 用了 features 却没声明`)
    const head = body.slice(1, at)
    assert.ok(!/\b(if|for|while|switch|return|function)\b/.test(head), `${name} 的 features 声明必须无条件且在早退之前`)
    assert.ok(!/=>/.test(head), `${name} 的 features 声明不能在回调或箭头函数里`)
  }
  assert.ok(checked >= 5, `应至少检查 5 个组件,实际 ${checked}`)
})

test('Given 只改非哨兵开关 When POST Then 不重算哨兵', async () => {
  const ctx = makeCtx()
  let refreshed = 0
  let sentinelEnabled = false
  let current = { ...DEFAULT_FEATURES }
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    sentinel: {
      status: () => ({ events: [], config: { enabled: sentinelEnabled } }),
      refresh: async () => { refreshed += 1; sentinelEnabled = current.sentinel === true },
    },
    features: {
      active: true,
      current: () => current,
      replace: async (next) => { current = normalizeFeatures(next); return current },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/features`)
  // 改 whatif 与 dock:没有查桶的理由
  await route.handler(makeReq('POST', { features: { whatif: true, guard: false, sentinel: false, dock: true } }), makeRes())
  assert.equal(refreshed, 0)
  // 哨兵已开且结论一致时只改护栏,同样不该重算
  current = { ...DEFAULT_FEATURES, sentinel: true }
  sentinelEnabled = true
  await route.handler(makeReq('POST', { features: { whatif: true, guard: true, sentinel: true, dock: true } }), makeRes())
  assert.equal(refreshed, 0)
  // 结论落后于开关时必须补算(交错写入后就是这种形态)
  sentinelEnabled = false
  await route.handler(makeReq('POST', { features: { whatif: true, guard: true, sentinel: true, dock: true } }), makeRes())
  assert.equal(refreshed, 1)
})

test('门面缺失时各端点用各自的错误文案,不互相借词', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    budget: { active: false, config: () => null, replace: async () => ({}) },
  })
  const featuresRes = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/features`).handler(makeReq('POST', { features: DEFAULT_FEATURES }), featuresRes)
  assert.equal(featuresRes.statusCode, 503)
  assert.match(JSON.parse(featuresRes.body).error.message, /feature switches unavailable/)
  const budgetRes = makeRes()
  // 路由按 url 分派,这里必须给真实路径,否则会落到 features 的处理器上
  await ctx.routes.get(`${ROUTE_PREFIX}/budget`).handler(makeReq('POST', { budget: {} }, `${ROUTE_PREFIX}/budget`), budgetRes)
  assert.equal(budgetRes.statusCode, 503)
  assert.match(JSON.parse(budgetRes.body).error.message, /budget settings unavailable/)
  assert.doesNotMatch(JSON.parse(budgetRes.body).error.message, /pricing/)
})

test('Given 落盘后回读滞后一拍 When 并发关哨兵 Then 结论仍追上落盘值', async () => {
  const ctx = makeCtx()
  let refreshed = 0
  let sentinelEnabled = true
  let current = { ...DEFAULT_FEATURES, sentinel: true }
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    sentinel: {
      status: () => ({ events: [], config: { enabled: sentinelEnabled } }),
      refresh: async () => {
        refreshed += 1
        await new Promise((resolve) => setTimeout(resolve, 3))
        sentinelEnabled = current.sentinel === true
      },
    },
    features: {
      active: true,
      current: () => current,
      // 宿主的 volatile ref 回灌慢一拍:落盘已成功,current() 仍读到旧值。
      // 只靠「结论与实际开关不一致」判定的实现在这里会漏刷,靠「意图变了」才补得上
      replace: async (next) => {
        await new Promise((resolve) => setTimeout(resolve, 2))
        const saved = normalizeFeatures(next)
        setTimeout(() => { current = saved }, 0)
        return saved
      },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/features`)
  await Promise.all([
    route.handler(makeReq('POST', { features: DEFAULT_FEATURES }), makeRes()),
    route.handler(makeReq('POST', { features: DEFAULT_FEATURES }), makeRes()),
  ])
  await new Promise((resolve) => setTimeout(resolve, 50))
  // 终态必须与落盘值一致,而不是停在并发前的结论上
  assert.equal(current.sentinel, false)
  assert.equal(sentinelEnabled, false, '结论要追上落盘值')
  assert.ok(refreshed > 0)
})

test('Given 两个 POST 并发 When 一关一开 Then 终态与结论一致', async () => {
  const ctx = makeCtx()
  let refreshed = 0
  let sentinelEnabled = true
  let current = { ...DEFAULT_FEATURES, sentinel: true }
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    sentinel: {
      status: () => ({ events: [], config: { enabled: sentinelEnabled } }),
      refresh: async () => {
        refreshed += 1
        await new Promise((resolve) => setTimeout(resolve, 3))
        sentinelEnabled = current.sentinel === true
      },
    },
    features: {
      active: true,
      current: () => current,
      replace: async (next) => {
        await new Promise((resolve) => setTimeout(resolve, 2))
        current = normalizeFeatures(next)
        return current
      },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/features`)
  await Promise.all([
    route.handler(makeReq('POST', { features: DEFAULT_FEATURES }), makeRes()),
    route.handler(makeReq('POST', { features: { ...DEFAULT_FEATURES, sentinel: true } }), makeRes()),
  ])
  await new Promise((resolve) => setTimeout(resolve, 50))
  // 初态与终态相同,只比等式会恒真:必须证明真的重算过
  assert.ok(refreshed > 0, '冲突写入要触发重算')
  assert.equal(sentinelEnabled, current.sentinel === true, '冲突写入后结论必须追上最终落盘值')
})

test('Given 缺 budget 根键 When POST Then 400 且不落盘', async () => {
  const ctx = makeCtx()
  let replaced = 0
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    budget: {
      active: true,
      config: () => null,
      replace: async (next) => { replaced += 1; return next },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/budget`)
  // 扁平体(漏了 budget 键)不能当成「清空预算」
  const res = makeRes()
  await route.handler(makeReq('POST', { daily: { limit: 50, action: 'warn' } }, `${ROUTE_PREFIX}/budget`), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error.message, /invalid budget settings/)
  assert.equal(replaced, 0)
})

test('Given budget 键为标量 When POST Then 400', async () => {
  const ctx = makeCtx()
  let replaced = 0
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    budget: {
      active: true,
      config: () => null,
      replace: async (next) => { replaced += 1; return next },
    },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/budget`)
  const res = makeRes()
  await route.handler(makeReq('POST', { budget: 5 }, `${ROUTE_PREFIX}/budget`), res)
  assert.equal(res.statusCode, 400)
  assert.equal(replaced, 0)
  // null 是合法的清空
  const cleared = makeRes()
  await route.handler(makeReq('POST', { budget: null }, `${ROUTE_PREFIX}/budget`), cleared)
  assert.equal(cleared.statusCode, 200)
  assert.equal(replaced, 1)
})

test('Given budget 为数组 When POST Then 400', async () => {
  const ctx = makeCtx()
  let replaced = 0
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: true, rules: () => [], revision: () => 0 },
    budget: { active: true, config: () => null, replace: async (next) => { replaced += 1; return next } },
  })
  const route = ctx.routes.get(`${ROUTE_PREFIX}/budget`)
  const res = makeRes()
  // 数组也是 typeof 'object',不加 Array.isArray 会静默清空预算
  await route.handler(makeReq('POST', { budget: [] }, `${ROUTE_PREFIX}/budget`), res)
  assert.equal(res.statusCode, 400)
  assert.equal(replaced, 0)
})

test('工作区用量块挂在用量摘要正文内', () => {
  const body = functionBodyOf(CLIENT_SOURCE, 'HudSummaryBody')
  assert.match(body, /WorkspaceUsagePanel/, '用量摘要缺少工作区用量块')
  assert.match(body, /embedded:\s*true/, '工作区用量块必须按嵌入式样式渲染')
})

test('哨兵关态折叠头也给「已关闭」', () => {
  const body = functionBodyOf(CLIENT_SOURCE, 'SentinelSection')
  // 三张成本卡的折叠头要一致:关着就说关着,不能留空白
  assert.match(body, /features\.sentinel !== true\s*\n\s*\? t\('featureOff'\)/, '关态摘要缺失')
  assert.match(body, /summary,/, '摘要要传给 SectionFold')
})
