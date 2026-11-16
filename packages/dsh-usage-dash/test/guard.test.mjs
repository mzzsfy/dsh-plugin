// 成本护栏:假 ctx 捕获 llm/stream waterfall 监听,手工构造 options 与 next,
// 断言三分支、熔断锁、读数缓存与降级落点。不启动宿主、不碰真实存储。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BUDGET_ACTION_NONE, normalizeBudgetConfig } from '../src/budget.js'
import { BUDGET_EXCEEDED_CODE, SPENT_CACHE_TTL_MS, installGuard } from '../src/guard.js'
import { GRANULARITY_MINUTE } from '../src/store.js'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

// 2026-11-15 10:00 UTC 显式固定: 夹具 epoch 与断言墙钟必须同一坐标系,
// 运行环境本地时区(new Date 分量)造 epoch 会在 UTC runner 上整体偏移 8 小时
const NOW = Date.UTC(2026, 10, 15, 10, 0, 0)
const SESSION_ID = 'sess-1'
const NEXT_RESULT = { kind: 'provider-stream' }
const PRICE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const RULES = [{ model: '*/*', unit: 'perMillion', currency: '¥', price: PRICE, conditions: [] }]
// 一分钟桶 100 万输入 token 按 PRICE 计 1 元
const COST_ONE_ROW = { bucket: '2026-11-15T09:50', model: 'p/m', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

// 启用位不再存在预算配置里,由 features.guard 在运行期投影到拦截器
const configOf = (overrides = {}) => ({
  ...normalizeBudgetConfig({
    daily: { limit: 50, action: 'warn' },
    ...overrides,
  }),
  enabled: overrides.enabled !== false,
})

function makeCtx({ llm = {}, agents = undefined, onThrows = false } = {}) {
  const listeners = []
  const warnings = []
  return {
    listeners,
    warnings,
    ctx: {
      logger: { warn: (message) => warnings.push(message) },
      get: (name) => (name === 'llm' ? llm : name === 'agents' ? agents : undefined),
      on(name, listener, options) {
        if (onThrows) throw new Error('INACTIVE_EFFECT')
        const entry = { name, listener, options, active: true }
        listeners.push(entry)
        return () => {
          entry.active = false
        }
      },
    },
  }
}

// 花费读数口径:{daily, monthly};用例里用数字等价写法
const spentOf = (value) => (typeof value === 'number' ? { daily: value, monthly: value } : value)

function makeDeps({ config = configOf(), spent = 0, rows = [], rules = RULES, now } = {}) {
  const calls = { spent: 0, rangeRows: 0, rangeArgs: [] }
  const deps = {
    pricing: { active: true, rules: () => rules },
    now: now ?? (() => NOW),
    timeZone: 'UTC',
    store: {
      async rangeRows(granularity, from, to) {
        calls.rangeRows += 1
        calls.rangeArgs.push({ granularity, from, to })
        return rows
      },
    },
    config: () => (typeof config === 'function' ? config() : config),
    spent: async () => {
      calls.spent += 1
      return spentOf(typeof spent === 'function' ? spent() : spent)
    },
  }
  deps.calls = calls
  return deps
}

const streamListenerOf = (listeners) => {
  const entry = listeners.find((item) => item.name === 'llm/stream' && item.active)
  assert.ok(entry, '应注册 llm/stream 监听')
  return entry
}

// waterfall 语义:监听不调 next 即短路 provider
function callStream(listeners, options = {}) {
  const listener = streamListenerOf(listeners)
  let called = false
  const result = listener.listener(options, () => {
    called = true
    return NEXT_RESULT
  })
  return { result, called }
}

test('Given llm 服务缺席 When 安装 Then 返回空 disposer 且不注册监听', () => {
  const harness = makeCtx({ llm: null })
  const guard = installGuard(harness.ctx, makeDeps())
  assert.equal(typeof guard, 'function')
  assert.equal(harness.listeners.length, 0)
  assert.equal(guard.status().installed, false)
  assert.equal(guard.status().action, BUDGET_ACTION_NONE)
  assert.equal(guard.status().evaluation, null)
  // 空实现的调用面与启用态同形,消费方可统一解构
  const { status, dispose, ack, reset } = guard
  assert.equal(typeof status, 'function')
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => {
    ack()
    reset()
    dispose()
  })
})

test('Given 监听注册失败 When 安装 Then 干净禁用而不抛错', () => {
  const harness = makeCtx({ onThrows: true })
  const guard = installGuard(harness.ctx, makeDeps())
  assert.equal(guard.status().installed, false)
  assert.ok(harness.warnings.some((message) => message.includes('成本护栏未启用')))
})

test('Given 预算未启用 When 请求 Then 直接放行且不查库', () => {
  const deps = makeDeps({ config: configOf({ enabled: false, daily: { limit: 50, action: 'block' } }), spent: 999 })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  const { result, called } = callStream(harness.listeners)
  assert.equal(called, true)
  assert.equal(result, NEXT_RESULT)
  assert.equal(deps.calls.spent, 0)
  assert.equal(guard.status().action, BUDGET_ACTION_NONE)
  assert.equal(streamListenerOf(harness.listeners).options.global, true)
})

test('Given 日预算超限且动作为拦截 When 请求 Then 抛 BUDGET_EXCEEDED 且不调 next', async () => {
  const deps = makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: 60 })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  const listener = streamListenerOf(harness.listeners)
  let called = false
  assert.throws(
    () => listener.listener({}, () => {
      called = true
      return NEXT_RESULT
    }),
    (error) => {
      assert.equal(error.code, BUDGET_EXCEEDED_CODE)
      assert.equal(error.scope, 'daily')
      assert.match(error.message, /日预算/)
      assert.match(error.message, /已花 60/)
      return true
    },
  )
  assert.equal(called, false, '拦截分支不得调用 next,provider 不会被触达')
  assert.equal(guard.status().action, 'block')
  assert.equal(guard.status().blockedScope, 'daily')
  assert.equal(guard.status().blockedAt, NOW)
})

test('Given 已熔断 When 花费读数回落 Then 锁按 TTL 复核并自动解除', async () => {
  let spent = 60
  const deps = makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: () => spent })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
  // 换天 / 提额 / 改周期都靠这条路径解除:锁不是终态
  spent = 0
  deps.now = () => NOW + SPENT_CACHE_TTL_MS * 2
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE }, '读数过期时先按旧结论拦一次')
  await tick()
  assert.equal(deps.calls.spent, 2, '过期后要重读')
  assert.equal(callStream(harness.listeners).called, true, '花费回落后自动放行')
  assert.equal(guard.status().blockedAt, null)
})

test('Given 熔断 When ack Then 本次超支不再武装,读数回到限额内后重新可熔断', async () => {
  let spent = 60
  const deps = makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: () => spent })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })

  guard.ack()
  assert.equal(guard.status().blockedAt, null)
  assert.equal(guard.status().action, BUDGET_ACTION_NONE)
  assert.equal(callStream(harness.listeners).called, true, '解除后放行')

  // 仍超限:刷新读数不重新武装
  await guard.refresh()
  assert.equal(guard.status().acked, true)
  assert.equal(guard.status().action, BUDGET_ACTION_NONE)
  assert.equal(callStream(harness.listeners).called, true)

  // 回落到限额内 → 重新武装;再次超限 → 再次熔断
  spent = 10
  await guard.refresh()
  assert.equal(guard.status().acked, false)
  spent = 60
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
})

test('Given 熔断 When reset Then 熔断锁与降级记录一并清空', async () => {
  const deps = makeDeps({
    config: configOf({ daily: { limit: 50, action: 'block' }, degradeModel: 'vendor/cheap' }),
    spent: 60,
  })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
  guard.reset()
  assert.equal(guard.status().blockedAt, null)
  assert.equal(guard.status().degrade, null)
  assert.equal(guard.status().evaluation, null)
  assert.equal(callStream(harness.listeners).called, true)
})

test('Given 动作为提示 When 请求 Then 放行且状态可见', async () => {
  const deps = makeDeps({ config: configOf({ daily: { limit: 50, action: 'warn' } }), spent: 45 })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(callStream(harness.listeners).called, true)
  assert.equal(guard.status().action, 'warn')
  assert.equal(guard.status().evaluation.budgets[0].state, 'warn')
})

test('Given 动作为降级且无宿主 agent 面 When 请求 Then 放行并只记录降级', async () => {
  const deps = makeDeps({
    config: configOf({ daily: { limit: 50, action: 'degrade' }, degradeModel: 'vendor/cheap' }),
    spent: 60,
  })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(callStream(harness.listeners, { sessionId: SESSION_ID }).called, true)
  assert.equal(guard.status().degrade.model, 'vendor/cheap')
  await tick()
  assert.equal(guard.status().degrade.applied, false)
  assert.equal(guard.status().degrade.reason, 'unresolved', '未经 llm 解析的目标模型不切换')
})

test('Given 动作为降级且宿主 agent 面可用 When 请求 Then 切换下一次模型步的模型选择', async () => {
  const selections = []
  let current = { provider: 'vendor', model: 'pro', reasoningEffort: 'high' }
  const agents = {
    get: (id) => (id === SESSION_ID
      ? {
          model: {
            current: () => current,
            select: (selection) => {
              selections.push(selection)
              current = selection
            },
          },
        }
      : undefined),
  }
  const llm = { resolveCallConfig: async () => ({}) }
  const deps = makeDeps({
    config: configOf({ daily: { limit: 50, action: 'degrade' }, degradeModel: 'vendor/cheap' }),
    spent: 60,
  })
  const harness = makeCtx({ llm, agents })
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(callStream(harness.listeners, { sessionId: SESSION_ID }).called, true)
  await tick()
  assert.deepEqual(selections, [{ provider: 'vendor', model: 'cheap', reasoningEffort: 'high' }])
  assert.equal(guard.status().degrade.applied, true)
  assert.equal(guard.status().degrade.reason, 'switched')
})

test('Given 降级目标模型不可解析 When 请求 Then 不写入模型选择', async () => {
  const selections = []
  const agents = {
    get: () => ({ model: { current: () => ({ provider: 'vendor', model: 'pro' }), select: (selection) => selections.push(selection) } }),
  }
  const llm = { resolveCallConfig: async () => { throw new Error('NO_ADAPTER') } }
  const deps = makeDeps({
    config: configOf({ daily: { limit: 50, action: 'degrade' }, degradeModel: 'vendor/missing' }),
    spent: 60,
  })
  const harness = makeCtx({ llm, agents })
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(callStream(harness.listeners, { sessionId: SESSION_ID }).called, true)
  await tick()
  assert.deepEqual(selections, [])
  assert.equal(guard.status().degrade.applied, false)
  assert.equal(guard.status().degrade.reason, 'unresolved')
})

test('Given 降级目标已是当前模型 When 请求 Then 不重复写入选择', async () => {
  const selections = []
  const agents = { get: () => ({ model: { current: () => ({ provider: 'vendor', model: 'cheap' }), select: (selection) => selections.push(selection) } }) }
  const deps = makeDeps({
    config: configOf({ daily: { limit: 50, action: 'degrade' }, degradeModel: 'vendor/cheap' }),
    spent: 60,
  })
  const harness = makeCtx({ llm: { resolveCallConfig: async () => ({}) }, agents })
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  callStream(harness.listeners, { sessionId: SESSION_ID })
  await tick()
  assert.deepEqual(selections, [])
  assert.equal(guard.status().degrade.reason, 'already')
})

test('Given 花费读数缓存 When 窗口内多次请求 Then 只查一次库,过期后重新读数', async () => {
  let clockNow = NOW
  const deps = makeDeps({ config: configOf(), spent: 10, now: () => clockNow })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(deps.calls.spent, 1)
  callStream(harness.listeners)
  callStream(harness.listeners)
  callStream(harness.listeners)
  assert.equal(deps.calls.spent, 1, '缓存窗口内不重复查库')
  clockNow = NOW + SPENT_CACHE_TTL_MS
  callStream(harness.listeners)
  await tick()
  assert.equal(deps.calls.spent, 2, '过期后刷新读数')
  assert.equal(guard.status().cachedAt, clockNow)
})

test('Given 分钟桶费用 When 评估 Then 速率折算每小时且按分钟粒度取数', async () => {
  const deps = makeDeps({ config: configOf(), spent: 10, rows: [COST_ONE_ROW, COST_ONE_ROW] })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  // 30 分钟窗口内 2 元 → 每小时 4 元;日限额剩 40 → ETA 10 小时
  assert.equal(guard.status().evaluation.ratePerHour, 4)
  assert.equal(guard.status().evaluation.eta.hoursLeft, 10)
  assert.equal(deps.calls.rangeArgs[0].granularity, GRANULARITY_MINUTE)
  assert.match(deps.calls.rangeArgs[0].from, /^2026-11-15T09:30$/)
  assert.match(deps.calls.rangeArgs[0].to, /^2026-11-15T09:50$/)
})

test('Given 无定价规则 When 评估 Then 速率为零且无 ETA', async () => {
  const deps = makeDeps({ config: configOf(), spent: 10, rules: [], rows: [COST_ONE_ROW] })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(guard.status().evaluation.ratePerHour, 0)
  assert.equal(guard.status().evaluation.eta, null)
  assert.equal(deps.calls.rangeRows, 0, '无规则不查分钟桶')
})

test('Given 花费读数失败 When 请求 Then 放行并沿用上次读数', async () => {
  let fail = true
  const deps = makeDeps({ config: configOf(), spent: () => { if (fail) throw new Error('store closed'); return 10 } })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(guard.status().evaluation, null)
  assert.equal(callStream(harness.listeners).called, true)
  assert.ok(harness.warnings.some((message) => message.includes('花费读数不可用')))
  fail = false
  await tick()
  await guard.refresh()
  assert.equal(guard.status().evaluation.budgets[0].spent, 10)
})

test('Given 配置不可读 When 请求 Then 放行', () => {
  const deps = makeDeps({ config: () => { throw new Error('settings inactive') } })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  assert.equal(callStream(harness.listeners).called, true)
  assert.equal(guard.status().config, null)
  assert.equal(guard.status().action, BUDGET_ACTION_NONE)
})

test('Given 卸载 When 请求 Then 监听已移除,provider 直通', async () => {
  const deps = makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: 60 })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
  guard.dispose()
  assert.equal(harness.listeners.filter((item) => item.active).length, 0)
  assert.equal(guard.status().installed, false)
  const result = harness.listeners[0].listener({}, () => NEXT_RESULT)
  assert.equal(result, NEXT_RESULT)
})

test('Given 配置变更 When 请求 Then 读数缓存作废并重新判定', async () => {
  let config = configOf({ daily: { limit: 50, action: 'block' } })
  const deps = makeDeps({ config: () => config, spent: 60 })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
  guard.ack()
  // 提额到 100:配置签名变化即作废旧读数
  config = configOf({ daily: { limit: 100, action: 'block' } })
  callStream(harness.listeners)
  await tick()
  assert.equal(deps.calls.spent, 2)
  assert.equal(guard.status().action, 'none')
})

// —— 客户端护栏卡:整源求值后单独挂载 GuardSection,断言读写契约与就地校验 ——
const clientCore = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const GUARD_SOURCE = (() => {
  const match = CLIENT_BODY.match(/    function GuardSection\(\{ t = defaultT \}\) \{[\s\S]*?\n    \}\n/)
  assert.ok(match, 'client.js 缺少 GuardSection 实现')
  return match[0]
})()

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  node.children.forEach((child) => walk(child, visit))
}
const findAll = (tree, predicate) => {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}
const textOf = (node) => (typeof node === 'string'
  ? node
  : Array.isArray(node) ? node.map(textOf).join('') : node?.children ? textOf(node.children) : '')

// 迷你渲染器:状态槽 + 单次 effect + 手动重挂载,够验证券商卡片的读写与校验
function mountGuard({ value, postResult = { ok: true, value: {} }, features = { whatif: false, guard: true, sentinel: false, dock: false } }) {
  const calls = { got: 0, posted: [] }
  const states = []
  const effects = new Map()
  let index = 0
  let tree = null
  let scheduled = false

  const h = (type, props, ...children) => {
    const flat = children.flat(Infinity).filter((child) => child != null && child !== false)
    if (typeof type === 'function') return type({ ...(props ?? {}), children: flat })
    return { type, props: props ?? {}, children: flat }
  }
  const useState = (init) => {
    const slot = index++
    if (!(slot in states)) states[slot] = typeof init === 'function' ? init() : init
    return [states[slot], (next) => {
      const resolved = typeof next === 'function' ? next(states[slot]) : next
      if (Object.is(resolved, states[slot])) return
      states[slot] = resolved
      scheduled = true
    }]
  }
  const useRef = (init) => {
    const slot = index++
    if (!(slot in states)) states[slot] = { current: init }
    return states[slot]
  }
  const useEffect = (fn) => {
    const slot = index++
    if (effects.has(slot)) return
    effects.set(slot, fn)
    queueMicrotask(() => {
      if (effects.get(slot) === fn) fn()
    })
  }
  const Switch = (props) => h('switch', { checked: props.checked, onChange: props.onChange })
  const SectionFold = ({ title, description, summary, open, onToggle, children }) =>
    h('fold', { title, description, summary, open, onToggle }, children)
  const StatsLineOptionRow = ({ labelKey, checked, onToggle }) => h('row', { labelKey, checked, onToggle })

  const component = new Function(
    ...DECLARATION_NAMES,
    'React', 'h', 'cx', 'useState', 'useEffect', 'useRef',
    'requestGet', 'requestPost', 'usePricing', 'Switch', 'SectionFold', 'StatsLineOptionRow', 'defaultT', 'hudRefresh',
    'useFeatures', 'toggleFeature', 'useFeatureToggle', 'useHudSnapshot',
    `return (${GUARD_SOURCE.trim()})`,
  )(
    ...Object.values(clientCore),
    { Fragment: 'fragment' },
    h,
    (...values) => values.filter(Boolean).join(' '),
    useState,
    useEffect,
    useRef,
    async () => {
      calls.got += 1
      return value
    },
    async (endpoint, body) => {
      calls.posted.push({ endpoint, body })
      return postResult
    },
    () => ({ rules: [] }),
    Switch,
    SectionFold,
    StatsLineOptionRow,
    clientCore.createTranslator(clientCore.MESSAGES_ZH),
    async () => {},
    () => features,
    async () => true,
    // 与 client 内的 useFeatureToggle 同构:一次 useState + 包一层写失败提示
    () => {
      const [failure, setFailure] = useState('')
      return [failure, (key, enabled) => toggleFeature(key, enabled).then((ok) => {
        setFailure(ok ? '' : '开关保存失败')
        return ok
      })]
    },
    () => null,
  )

  const translate = clientCore.createTranslator(clientCore.MESSAGES_ZH)
  const render = () => {
    index = 0
    tree = component({ t: translate })
    scheduled = false
    return tree
  }
  render()
  return {
    calls,
    tree: () => tree,
    // 状态更新与 effect 落在微任务/定时器后,逐轮渲染直到没有新排期
    async settle() {
      for (let round = 0; round < 8; round += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        if (scheduled) render()
      }
      return tree
    },
  }
}

const saveButton = (tree) => {
  const button = findAll(tree, (node) => node.type === 'button' && textOf(node) === '保存')[0]
  assert.ok(button, '缺少保存按钮')
  return button
}

test('Given 预算端点返回配置 When 渲染护栏卡 Then 控件、状态行与三态徽标就位', async () => {
  const harness = mountGuard({
    value: {
      ok: true,
      value: {
        active: true,
        config: {
          enabled: true,
          warnRatio: 0.8,
          daily: { limit: 50, action: 'block' },
          monthly: { limit: 200, action: 'warn' },
          degradeModel: 'vendor/cheap',
          notify: true,
        },
        status: {
          enabled: true,
          action: 'block',
          budgets: [{ scope: 'daily', limit: 50, spent: 60, remaining: 0, ratio: 1.2, state: 'exceeded', action: 'block' }],
          eta: null,
          ratePerHour: 0,
        },
      },
    },
  })
  const tree = await harness.settle()
  assert.equal(harness.calls.got, 1)
  // 两个限额 + 一个阈值百分比
  assert.equal(findAll(tree, (node) => node.type === 'input' && node.props.type === 'number').length, 3)
  const selects = findAll(tree, (node) => node.type === 'select')
  assert.deepEqual(selects.map((node) => node.props.value), ['block', 'warn'])
  assert.equal(findAll(selects[0], (node) => node.type === 'option').length, 3)
  const degradeInput = findAll(tree, (node) => node.type === 'input' && node.props.type === 'text')[0]
  assert.equal(degradeInput.props.value, 'vendor/cheap')
  // 货币符号在数字输入右侧
  assert.deepEqual(findAll(tree, (node) => node.props?.className === 'ud-guard-unit').map(textOf), ['¥', '¥', '%'])
  // 两个开关行:总开关与通知
  assert.deepEqual(
    findAll(tree, (node) => node.type === 'row').map((node) => [node.props.labelKey, node.props.checked]),
    [['guardEnable', true], ['guardNotify', true]],
  )
  const badge = findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('ud-guard-badge'))[0]
  assert.match(badge.props.className, /ud-guard-badge--danger/)
  assert.equal(textOf(badge), '已熔断')
  const statusText = textOf(findAll(tree, (node) => node.props?.className === 'ud-guard-status')[0])
  assert.match(statusText, /今日 ≈¥60\.00 \/ ¥50\.00/)
  assert.match(statusText, /剩余 ¥0\.00/)
  assert.match(statusText, /暂无触顶预估/)
})

test('Given 数字输入为空或非法 When 保存 Then 不发请求且就地提示', async () => {
  const harness = mountGuard({
    value: { ok: true, value: { config: { enabled: true, daily: { limit: 50, action: 'warn' } }, status: null } },
  })
  let tree = await harness.settle()
  const limitInput = () => findAll(tree, (node) => node.type === 'input' && node.props.type === 'number')[0]

  limitInput().props.onChange({ target: { value: '' } })
  tree = await harness.settle()
  saveButton(tree).props.onClick()
  tree = await harness.settle()
  assert.equal(harness.calls.posted.length, 0, '空值不得发请求')
  assert.match(textOf(tree), /请输入不小于 0 的数字/)

  limitInput().props.onChange({ target: { value: 'abc' } })
  tree = await harness.settle()
  saveButton(tree).props.onClick()
  tree = await harness.settle()
  assert.equal(harness.calls.posted.length, 0, '非法值不得发请求')
  assert.match(textOf(tree), /请输入不小于 0 的数字/)
})

test('Given 阈值越界 When 保存 Then 不发请求且提示百分比范围', async () => {
  const harness = mountGuard({
    value: { ok: true, value: { config: { enabled: true, warnRatio: 0.8 }, status: null } },
  })
  let tree = await harness.settle()
  const percentInput = findAll(tree, (node) => node.type === 'input' && node.props.type === 'number')[2]
  percentInput.props.onChange({ target: { value: '120' } })
  tree = await harness.settle()
  saveButton(tree).props.onClick()
  tree = await harness.settle()
  assert.equal(harness.calls.posted.length, 0)
  assert.match(textOf(tree), /请输入 0 到 100 之间的数字/)
})

test('Given 合法输入 When 保存 Then 提交预算并重新拉取状态', async () => {
  const harness = mountGuard({
    value: {
      ok: true,
      value: {
        config: {
          enabled: true,
          warnRatio: 0.8,
          daily: { limit: 50, action: 'block' },
          monthly: { limit: 200, action: 'warn' },
          degradeModel: 'vendor/cheap',
          notify: true,
        },
        status: null,
      },
    },
  })
  let tree = await harness.settle()
  const numbers = () => findAll(tree, (node) => node.type === 'input' && node.props.type === 'number')
  numbers()[0].props.onChange({ target: { value: '12.5' } })
  tree = await harness.settle()
  findAll(tree, (node) => node.type === 'select')[0].props.onChange({ target: { value: 'degrade' } })
  tree = await harness.settle()
  numbers()[2].props.onChange({ target: { value: '90' } })
  tree = await harness.settle()
  saveButton(tree).props.onClick()
  tree = await harness.settle()

  assert.equal(harness.calls.posted.length, 1)
  assert.equal(harness.calls.posted[0].endpoint, 'budget')
  assert.deepEqual(harness.calls.posted[0].body, {
    budget: {
      warnRatio: 0.9,
      daily: { limit: 12.5, action: 'degrade' },
      monthly: { limit: 200, action: 'warn' },
      degradeModel: 'vendor/cheap',
      notify: true,
    },
  })
  assert.equal(harness.calls.got, 2, '保存后重取状态')
  assert.match(textOf(tree), /已保存/)
})

test('Given 预算端点不可用 When 渲染 Then 只显示错误不渲染表单', async () => {
  const harness = mountGuard({ value: { ok: false, code: 'usage_api_error', message: 'budget unavailable' } })
  const tree = await harness.settle()
  assert.match(textOf(tree), /budget unavailable/)
  assert.equal(findAll(tree, (node) => node.type === 'input').length, 0)
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 0)
})

test('Given 护栏关闭 When 渲染 Then 状态行只说不拦请求,额度数字照给', async () => {
  const harness = mountGuard({
    features: { whatif: false, guard: false, sentinel: false, dock: false },
    value: {
      ok: true,
      value: {
        active: true,
        config: { enabled: false, warnRatio: 0.8, daily: { limit: 50, action: 'block' }, monthly: { limit: 0, action: 'warn' }, degradeModel: '', notify: true },
        status: {
          enabled: false,
          action: 'none',
          budgets: [{ scope: 'daily', limit: 50, spent: 20, remaining: 30, ratio: 0.4, state: 'ok', action: 'none' }],
          eta: null,
          ratePerHour: 0,
        },
      },
    },
  })
  const tree = await harness.settle()
  const statusText = textOf(findAll(tree, (node) => node.props?.className === 'ud-guard-status')[0])
  // 关闭态只说一次未启用,但已用/剩余照常显示:显示与拦截解耦
  assert.match(statusText, /未启用,不拦截请求/)
  assert.match(statusText, /今日 ≈¥20\.00 \/ ¥50\.00/)
  assert.match(statusText, /剩余 ¥30\.00/)
  // 折叠头已经有「已关闭」徽标,状态行不再重复一个徽标
  assert.equal(findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('ud-guard-badge')).length, 0)
  // 总开关读的是 features.guard,不是预算端点
  assert.deepEqual(
    findAll(tree, (node) => node.type === 'row').map((node) => [node.props.labelKey, node.props.checked]),
    [['guardEnable', false], ['guardNotify', true]],
  )
})

test('Given 已熔断 When 计费周期切换 Then 旧窗口的熔断锁作废', async () => {
  let spent = 60
  let cycle = { kind: 'calendar', startDay: 1, days: 30 }
  const deps = { ...makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: () => spent }), cycleConfig: () => cycle }
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
  // 换成滚动周期:「已花」是另一个窗口的数,必须重新读
  cycle = { kind: 'rolling', startDay: 1, days: 30 }
  spent = 0
  await tick()
  assert.equal(callStream(harness.listeners).called, true, '周期切换后不该继续按旧窗口拦')
  assert.equal(guard.status().blockedAt, null)
})

test('Given 周期配置不可读 When 判定 Then 放行而不是抛进监听器', async () => {
  const deps = {
    ...makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: 10 }),
    cycleConfig: () => { throw new Error('settings closed') },
  }
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.equal(callStream(harness.listeners).called, true, '配置读不到不是拦截理由')
})

test('Given 熔断中读数回落 When 后台刷新 Then status 无需新请求即显示解除', async () => {
  let spent = 60
  const deps = makeDeps({ config: configOf({ daily: { limit: 50, action: 'block' } }), spent: () => spent })
  const harness = makeCtx()
  const guard = installGuard(harness.ctx, deps)
  await guard.refresh()
  assert.throws(() => callStream(harness.listeners), { code: BUDGET_EXCEEDED_CODE })
  spent = 0
  deps.now = () => NOW + SPENT_CACHE_TTL_MS * 2
  await guard.refresh()
  assert.equal(guard.status().blockedAt, null, '读数回落即释放,别等下一次模型请求')
  assert.equal(guard.status().action, BUDGET_ACTION_NONE)
})
