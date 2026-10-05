import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRouteManager } from '../packages/dsh-llm-pi-gateway/src/manager.mjs'

// BDD:宿主侧 fiber 卸载会连坐 adapter 注册(cordis ambient scope 级联),
// ensureRegistration 必须自愈——句柄死亡后 facts 相等不得提前返回

const ROUTES = () => new Map([['echo-openai', {}], ['echo-anthropic', {}]])

function harness(handle) {
  const calls = []
  const manager = createRouteManager({
    routes: ROUTES,
    registerAdapter: (providers) => {
      calls.push(['register', ...providers])
      return handle
    },
    registerDirectory: () => undefined,
    adapter: {},
  })
  return { manager, calls }
}

describe('manager.ensureRegistration 卸载自愈', () => {
  it('首次注册后 facts 不变不重复注册', () => {
    const live = { replace: () => undefined }
    const { manager, calls } = harness(live)
    manager.ensureRegistration()
    manager.ensureRegistration()
    assert.equal(calls.length, 1)
  })

  it('句柄被宿主卸载后下次调用重注册(replace 抛 REGISTRATION_DISPOSED)', () => {
    const dead = { replace: () => { throw new Error('a disposed adapter registration cannot replace its routes') } }
    const { manager, calls } = harness(dead)
    manager.ensureRegistration()
    assert.equal(calls.length, 1)
    manager.ensureRegistration()
    assert.equal(calls.length, 2, 'dead handle must re-register')
  })

  it('句柄存活时 replace 幂等重提交不重注册', () => {
    let replaces = 0
    const live = { replace: () => { replaces += 1 } }
    const { manager, calls } = harness(live)
    manager.ensureRegistration()
    manager.ensureRegistration()
    assert.equal(calls.length, 1)
    assert.equal(replaces, 1, 'second call re-commits via replace')
  })

  it('自愈后恢复常态去重', () => {
    let dead = true
    const handle = { replace: () => { if (dead) throw new Error('disposed') } }
    const { manager, calls } = harness(handle)
    manager.ensureRegistration()
    manager.ensureRegistration()
    dead = false
    manager.ensureRegistration()
    const after = calls.length
    manager.ensureRegistration()
    assert.equal(calls.length, after)
  })
})
