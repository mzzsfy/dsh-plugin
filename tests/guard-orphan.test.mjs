import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectOrphanTakeover, reviveGateway } from '../packages/dsh-llm-pi-gateway/src/orphan.mjs'
import { beginGatewayApply, endGatewayApplyActive, resetGatewayApplyStateForTest } from '../packages/dsh-llm-pi-gateway/src/apply-state.mjs'
import { EXIT_POLL_INTERVAL_MS } from '../packages/dsh-llm-pi-gateway/src/takeover.mjs'

// BDD:运行时接管下宿主 inject-epoch 级联会卸载 gateway 行 fiber(注册全
// 灭)且宿主把异常死亡行宽化为 disabled 并重建官方行——行「假活」。guard
// 幸存,按声明态(options.disabled)与行树形态判定孤儿接管并自愈:
// 形态1 经典 = 官方禁用停稳 + gateway fiber 缺席
// 形态2 宿主重建 = 官方在跑(声明启用被宿主以声明态重建)+ gateway fiber 缺席
// 自愈 = 先禁官方(形态2)再往返重启 gateway;takeover 决策不触发运行时
// 禁用动作,级联源头消失,一轮收敛

// 行桩:options.disabled = 声明态;disabled = 有效态(宿主宽化,可偏离);
// fiber null = 停稳缺席;updates 记录 entry.update 调用序列
function entry({ id, declared = undefined, effective, fiber = null } = {}) {
  const row = {
    options: { id, disabled: declared },
    disabled: effective ?? declared,
    fiber,
    updates: [],
    async update(patch, quiet, force) {
      row.updates.push({ patch, quiet, force })
      if (patch.disabled === true) {
        row.disabled = true
        try { row.fiber = null } catch { /* fiber 被 getter 门控接管,停稳态由门控决定 */ }
      }
    },
  }
  return row
}

function makeLoader({ gateway, official }) {
  return { resolve: (id) => (id.endsWith('llm-pi-gateway') ? gateway : id.endsWith('llm-pi-ai') ? official : undefined) }
}

const T = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function orphanSetup({ gateway, official } = {}) {
  beginGatewayApply()
  endGatewayApplyActive()
  return makeLoader({
    gateway: gateway ?? entry({ id: 'llm-pi-gateway', declared: undefined, fiber: null }),
    official: official ?? entry({ id: 'llm-pi-ai', declared: true, effective: true, fiber: null }),
  })
}

describe('guard.detectOrphanTakeover 孤儿接管判定', () => {
  it('形态1:官方禁停稳 + gateway fiber 缺席(有效态被宽化为禁)→ 成立', () => {
    const loader = orphanSetup({
      gateway: entry({ id: 'llm-pi-gateway', declared: undefined, effective: true, fiber: null }),
      official: entry({ id: 'llm-pi-ai', declared: true, effective: true, fiber: null }),
    })
    assert.equal(detectOrphanTakeover(loader), true)
  })

  it('形态2:官方在跑(声明启用被重建)+ gateway fiber 缺席 → 成立', () => {
    const loader = orphanSetup({
      official: entry({ id: 'llm-pi-ai', declared: undefined, effective: false, fiber: { uid: 21 } }),
    })
    assert.equal(detectOrphanTakeover(loader), true)
  })

  it('gateway 声明禁用(用户显式意图)→ 不适用(死态代挂域)', () => {
    const loader = orphanSetup({
      gateway: entry({ id: 'llm-pi-gateway', declared: true, effective: true, fiber: null }),
    })
    assert.equal(detectOrphanTakeover(loader), false)
  })

  it('形态3:官方声明禁用但 fiber 在场(宿主重建无视内存禁用)→ 成立(2轮确认滤接管在途瞬态)', () => {
    const loader = orphanSetup({
      official: entry({ id: 'llm-pi-ai', declared: true, effective: false, fiber: { uid: 7 } }),
    })
    assert.equal(detectOrphanTakeover(loader), true)
  })

  it('官方声明启用且停稳(启动失败/未到)→ 不适用(死态代挂域)', () => {
    const loader = orphanSetup({
      official: entry({ id: 'llm-pi-ai', declared: undefined, effective: false, fiber: null }),
    })
    assert.equal(detectOrphanTakeover(loader), false)
  })

  it('gateway fiber 在场 → 不适用', () => {
    const loader = orphanSetup({
      gateway: entry({ id: 'llm-pi-gateway', declared: undefined, fiber: { uid: 9 } }),
    })
    assert.equal(detectOrphanTakeover(loader), false)
  })

  it('applyState 非 active(状态机已离场)→ 不适用', () => {
    resetGatewayApplyStateForTest()
    const loader = makeLoader({
      gateway: entry({ id: 'llm-pi-gateway', fiber: null }),
      official: entry({ id: 'llm-pi-ai', declared: true, fiber: null }),
    })
    assert.equal(detectOrphanTakeover(loader), false)
  })

  it('行解析失败返回 PENDING(null)', () => {
    // 直接 makeLoader:orphanSetup 的默认参数会吞 undefined
    const loader = makeLoader({ gateway: undefined, official: entry({ id: 'llm-pi-ai', declared: true, fiber: null }) })
    assert.equal(detectOrphanTakeover(loader), null)
  })
})

describe('guard.reviveGateway 自愈次序', () => {
  it('形态1:官方已禁停稳,仅往返 gateway,均 force', async () => {
    const gateway = entry({ id: 'llm-pi-gateway', declared: undefined, fiber: null })
    const official = entry({ id: 'llm-pi-ai', declared: true, effective: true, fiber: null })
    await reviveGateway(makeLoader({ gateway, official }), { delay: T })
    assert.equal(official.updates.length, 0, '官方已停稳不再禁')
    assert.deepEqual(gateway.updates.map((u) => [u.patch.disabled, u.force]), [[true, true], [false, true]])
  })

  it('形态2:先禁官方待停稳,再往返 gateway(杜绝级联重演死循环)', async () => {
    const gateway = entry({ id: 'llm-pi-gateway', declared: undefined, fiber: null })
    const official = entry({ id: 'llm-pi-ai', declared: undefined, effective: false, fiber: { uid: 21 } })
    await reviveGateway(makeLoader({ gateway, official }), { delay: T })
    assert.deepEqual(official.updates.map((u) => u.patch.disabled), [true], '先禁官方')
    assert.equal(official.disabled, true)
    assert.deepEqual(gateway.updates.map((u) => [u.patch.disabled, u.force]), [[true, true], [false, true]])
  })

  it('形态2/3 前置:官方未停稳先禁之待停稳(声明禁用残留也幂等再禁)', async () => {
    const gateway = entry({ id: 'llm-pi-gateway', declared: undefined, fiber: null })
    const official = entry({ id: 'llm-pi-ai', declared: true, effective: false, fiber: { uid: 7 } })
    await reviveGateway(makeLoader({ gateway, official }), { delay: T })
    assert.deepEqual(official.updates.map((u) => u.patch.disabled), [true], '官方在场先禁')
    assert.equal(official.disabled, true)
    assert.deepEqual(gateway.updates.map((u) => [u.patch.disabled, u.force]), [[true, true], [false, true]])
  })

  it('disable 后等 fiber 停稳才 enable(门控停稳桩,放行前不 enable)', async () => {
    const gateway = entry({ id: 'llm-pi-gateway', declared: undefined, fiber: null })
    const official = entry({ id: 'llm-pi-ai', declared: true, effective: true, fiber: null })
    let opened = false
    Object.defineProperty(gateway, 'fiber', { get: () => (opened ? null : { uid: 11 }) })
    let release
    const released = new Promise((resolve) => { release = () => { opened = true; resolve() } })
    const waiting = reviveGateway(makeLoader({ gateway, official }), { delay: () => released })
    await T(EXIT_POLL_INTERVAL_MS * 2)
    assert.equal(gateway.updates.length, 1, '停稳前不得 enable')
    release()
    await waiting
    assert.equal(gateway.updates.length, 2)
  })

  it('行不可解析返回 false 不动手', async () => {
    const gateway = entry({ id: 'llm-pi-gateway' })
    assert.equal(await reviveGateway(makeLoader({ gateway: undefined, official: entry({ id: 'llm-pi-ai' }) }), { delay: T }), false)
    assert.equal(gateway.updates.length, 0)
  })
})
