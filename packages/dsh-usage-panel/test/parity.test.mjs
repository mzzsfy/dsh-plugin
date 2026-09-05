// parity 测试:client.js LOGIC 标记段与 src/notify.mjs 同源逻辑对照(turn-notify 模式)。
// 覆盖认领状态机主干,任一侧漂移即失败。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decideClaim as coreDecideClaim, CLAIM_LOCK_TTL_MS } from '../src/notify.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取标记段,构造同接口的纯逻辑实现。
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(
    section
      + '; return { decideClaim, claimEvent, markDone, windowId, localGet, localSet, localDel, CLAIM_LOCK_TTL_MS };',
  )
  return factory()
}

// window 不可用时 localGet 等内部 try/catch 已兜底,decideClaim 本身不触碰 window
const client = clientLogic()

function defineClaimScenarios(prefix, decide) {
  test(prefix + '认领状态机四态对照', () => {
    const t0 = 1000
    assert.equal(decide({ stored: null, done: null, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: JSON.stringify({ wid: 'w2', at: t0 }), done: null, now: t0 + CLAIM_LOCK_TTL_MS - 1, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'skip')
    assert.equal(decide({ stored: JSON.stringify({ wid: 'w1', at: t0 }), done: null, now: t0 + CLAIM_LOCK_TTL_MS - 1, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: JSON.stringify({ wid: 'w2', at: t0 }), done: null, now: t0 + CLAIM_LOCK_TTL_MS + 1, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'takeover')
    assert.equal(decide({ stored: null, done: '1', now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'done')
    assert.equal(decide({ stored: 'not-json', done: null, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'takeover')
    // undefined 域双实现同形:视为无记录而非终态
    assert.equal(decide({ stored: null, done: undefined, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: undefined, done: null, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'claim')
    assert.equal(decide({ stored: 'not-json', done: undefined, now: t0, windowId: 'w1', lockTtlMs: CLAIM_LOCK_TTL_MS }), 'takeover')
  })
}

defineClaimScenarios('[notify.mjs decideClaim] ', coreDecideClaim)

test('[client.js decideClaim] 锁 TTL 与 core 不漂移', () => {
  assert.equal(client.CLAIM_LOCK_TTL_MS, CLAIM_LOCK_TTL_MS)
})

defineClaimScenarios('[client.js decideClaim] ', (args) => client.decideClaim(args.stored, args.done, args.now, args.windowId))
