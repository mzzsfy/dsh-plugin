import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

// 展开面板的子代理取数在组件区,这里抽出源码挂载,锁住「经服务对象调用」这一真实崩点:
// 解构 refreshProjections 会丢 this.manager,宿主直接抛 TypeError 把整个槽打掉
const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const SOURCE = CLIENT_BODY.match(/function CostBreakdownWithSessions\(\{[\s\S]*?\n    \}\n/)[0]

const byIdFixture = {
  A: { id: 'A', displayTitle: 'Root' },
  B: { id: 'B', origin: 'subagent', parentId: 'A', displayTitle: '调研', projectionValues: { tokenUsage: {} } },
  C: { id: 'C', origin: 'subagent', parentId: 'B' },
}

function mount({ byId = byIdFixture, projections = {}, service = null, clientCtx = null }) {
  const state = { byId, projectionsBySession: projections }
  const useSessions = (selector) => selector(state)
  const effects = []
  const h = (type, props) => ({ type, props })
  const component = new Function(
    'useRef', 'useEffect', 'h', 'sessionsClient', 'clientCtx', 'subagentHoursOf', 'subagentDescendantIds', 'costPanelModelOf', 'CostBreakdownSections',
    `return (${SOURCE})`,
  )(
    (value) => ({ current: value }),
    (fn) => effects.push(fn),
    h,
    service,
    clientCtx,
    core.subagentHoursOf,
    core.subagentDescendantIds,
    core.costPanelModelOf,
    (props) => ({ type: 'sections', props }),
  )
  const render = () => {
    const tree = component({ usage: null, modelUsage: null, rules: [], t: (key) => key, sessionId: 'A', useSessions })
    effects.splice(0).forEach((fn) => fn())
    return tree
  }
  return { render }
}

const recordingService = () => {
  const calls = []
  const service = {
    calls,
    refreshProjections(id) {
      // 方法依赖 this:解构调用时这里会是 undefined
      if (this !== service) throw new TypeError("Cannot read properties of undefined (reading 'manager')")
      calls.push(id)
      return Promise.resolve()
    },
  }
  return service
}

test('Given 展开面板 When 首帧渲染 Then 当前会话与每个后代子代理各刷新一次且经服务对象调用', () => {
  const service = recordingService()
  mount({ service }).render()
  assert.deepEqual(service.calls, ['A', 'B', 'C'])
})

test('Given 无子代理 When 首帧渲染 Then 只刷新当前会话', () => {
  const service = recordingService()
  mount({ service, byId: { A: { id: 'A' } } }).render()
  assert.deepEqual(service.calls, ['A'])
})

test('Given 宿主服务同步抛错 When 首帧渲染 Then 面板照常渲染不去崩槽', () => {
  const service = { refreshProjections() { throw new TypeError('boom') } }
  const tree = mount({ service }).render()
  assert.equal(typeof tree.type, 'function')
  assert.equal(tree.props.subagentsAvailable, true)
})

test('Given 无 sessions 服务 When 渲染 Then 不调用也不抛错', () => {
  const tree = mount({ service: null }).render()
  assert.equal(typeof tree.type, 'function')
})

test('Given apply 时服务尚缺 When 首帧渲染 Then 经容器回填后仍发起刷新', () => {
  const service = recordingService()
  const clientCtx = { get: (name) => (name === 'sessions' ? service : undefined) }
  mount({ service: null, clientCtx }).render()
  assert.deepEqual(service.calls, ['A', 'B', 'C'])
})
