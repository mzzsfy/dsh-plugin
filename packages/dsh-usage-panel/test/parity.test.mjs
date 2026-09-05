// parity 测试:client.js LOGIC 标记段与 src/notify.mjs 同源逻辑对照(turn-notify 模式)。
// 覆盖认领状态机主干,任一侧漂移即失败。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decideClaim as coreDecideClaim, CLAIM_LOCK_TTL_MS,
  imTargetKey as coreImTargetKey,
  toggleImTargetList as coreToggleImTargetList,
  removeImTargetFromList as coreRemoveImTargetFromList,
  unregisterImBotList as coreUnregisterImBotList,
  imBoundBotIds as coreImBoundBotIds } from '../src/notify.mjs'

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
      + '; return { decideClaim, claimEvent, markDone, windowId, localGet, localSet, localDel, CLAIM_LOCK_TTL_MS,'
      + ' imTargetKey, toggleImTargetList, removeImTargetFromList, unregisterImBotList, imBoundBotIds };',
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

// IM 目标列表操作双实现对照:任意操作序列后两侧终态一致即同形。
test('IM 目标列表操作双实现对照', () => {
  const scenarios = [
    { list: [], botId: 'wx_a', targetId: 'owner', checked: true },
    { list: [{ botId: 'wx_a', targetId: 'owner' }], botId: 'wx_a', targetId: 'owner', checked: true },
    { list: [{ botId: 'wx_a', targetId: 'owner' }, { botId: 'wx_b', targetId: 't1' }], botId: 'wx_a', targetId: 'owner', checked: false },
    { list: [{ botId: 'wx_a', targetId: 't1' }, { botId: 'wx_a', targetId: 't2' }], botId: 'wx_a', targetId: 't1', checked: true },
  ]
  for (const s of scenarios) {
    assert.deepEqual(
      client.toggleImTargetList(s.list, s.botId, s.targetId, s.checked),
      coreToggleImTargetList(s.list, s.botId, s.targetId, s.checked),
    )
    assert.deepEqual(
      client.removeImTargetFromList(s.list, s.botId, s.targetId),
      coreRemoveImTargetFromList(s.list, s.botId, s.targetId),
    )
    assert.deepEqual(client.unregisterImBotList(s.list, s.botId), coreUnregisterImBotList(s.list, s.botId))
    assert.deepEqual(client.imBoundBotIds(s.list), coreImBoundBotIds(s.list))
    assert.deepEqual(
      s.list.map(client.imTargetKey),
      s.list.map(coreImTargetKey),
    )
  }
  // 勾选幂等:同一目标重复勾选只保留一份,追加到尾部
  const once = client.toggleImTargetList([], 'wx_a', 't1', true)
  assert.deepEqual(client.toggleImTargetList(once, 'wx_a', 't1', true), [{ botId: 'wx_a', targetId: 't1' }])
  // 已绑 bot 按首次绑定顺序去重
  assert.deepEqual(
    client.imBoundBotIds([{ botId: 'b', targetId: 'x' }, { botId: 'a', targetId: 'y' }, { botId: 'b', targetId: 'z' }]),
    ['b', 'a'],
  )
})

defineClaimScenarios('[client.js decideClaim] ', (args) => client.decideClaim(args.stored, args.done, args.now, args.windowId))
