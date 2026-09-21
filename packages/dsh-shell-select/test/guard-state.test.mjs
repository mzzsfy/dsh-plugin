// guard 哨兵(桩 loader):BDD 场景见 docs/progress/shell-select-plan.md「guard」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectDeadState, rowState, effectiveDisabled, MAIN_ROW_ID, OFFICIAL_ROW_IDS } from '../src/guard-state.mjs'
import { officialRowConfig } from '../src/guard-config.mjs'

// --- 桩 loader / 行 ---

function row({ id, disabled = false, running = false }) {
  return {
    options: { id },
    get disabled() {
      if (disabled === 'throw') throw new Error('expr eval failed')
      return disabled
    },
    fiber: running ? { uid: 'f1' } : undefined,
  }
}

function loader(rows) {
  const map = new Map(rows.map((entry) => [entry.options.id, entry]))
  return {
    resolve(id) {
      if (map.has(id)) return map.get(id)
      throw new Error('not found')
    },
  }
}

const MAIN = MAIN_ROW_ID
const [OFF_TOOL, OFF_EXEC] = OFFICIAL_ROW_IDS

test('rowState:缺席/在场禁用/在场启用/运行中 四态', () => {
  assert.deepEqual(rowState(loader([]), MAIN), { present: false, disabled: false, running: false })
  assert.deepEqual(rowState(loader([row({ id: MAIN, disabled: true })]), MAIN), { present: true, disabled: true, running: false })
  assert.deepEqual(rowState(loader([row({ id: MAIN })]), MAIN), { present: true, disabled: false, running: false })
  assert.deepEqual(rowState(loader([row({ id: MAIN, running: true })]), MAIN), { present: true, disabled: false, running: true })
})

test('effectiveDisabled:disabled getter 抛错按未禁处理(让位安全向)', () => {
  assert.equal(effectiveDisabled(row({ id: 'x', disabled: 'throw' })), false)
})

test('死态:主行禁用停稳(或旗标 inactive)且官方两行禁用停稳', () => {
  const dead = loader([
    row({ id: MAIN, disabled: true }),
    row({ id: OFF_TOOL, disabled: true }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(dead, { applyState: () => 'active' }), true)
})

test('非死态:主行活着 / 主行禁但官方任一未禁 / 行运行中', () => {
  const alive = loader([
    row({ id: MAIN }),
    row({ id: OFF_TOOL, disabled: true }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(alive, { applyState: () => 'active' }), false)

  const officialAlive = loader([
    row({ id: MAIN, disabled: true }),
    row({ id: OFF_TOOL, disabled: false }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(officialAlive, { applyState: () => 'active' }), false)

  const running = loader([
    row({ id: MAIN, disabled: true, running: true }),
    row({ id: OFF_TOOL, disabled: true }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(running, { applyState: () => 'active' }), false)
})

test('apply 旗标 inactive 等价主行功能性停摆(行未禁也判死)', () => {
  const zombie = loader([
    row({ id: MAIN }),
    row({ id: OFF_TOOL, disabled: true }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(zombie, { applyState: () => 'inactive' }), true)
})

test('apply 旗标 pending(崩溃中)且行运行中:保守不判死', () => {
  const rows = loader([
    row({ id: MAIN, running: true }),
    row({ id: OFF_TOOL, disabled: true }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(rows, { applyState: () => 'pending' }), false)
})

test('主行禁用停稳时旗标不阻断判定(行确已停,残留旗标无意义)', () => {
  const rows = loader([
    row({ id: MAIN, disabled: true }),
    row({ id: OFF_TOOL, disabled: true }),
    row({ id: OFF_EXEC, disabled: true }),
  ])
  assert.equal(detectDeadState(rows, { applyState: () => 'pending' }), true)
})

test('officialRowConfig:读 settings.yaml shell 节,缺失返回空对象', async () => {
  const section = await officialRowConfig(async () => ({ shell: { pwshPath: 'C:\\x\\pwsh.exe' } }))
  assert.deepEqual(section, { pwshPath: 'C:\\x\\pwsh.exe' })
  assert.deepEqual(await officialRowConfig(async () => ({})), {})
  assert.deepEqual(await officialRowConfig(async () => {
    throw new Error('no file')
  }), {})
})
