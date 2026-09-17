// board handleControl 语义 BDD:cancel/pause 记账+驱动器联动(blocker 回归钉)/resume 状态不符/裁决校验
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleControl } from '../lib/board.mjs'
import { reportStore } from '../lib/store.mjs'
import { registry, registerDriver, unregisterDriver } from '../lib/driver/control.mjs'

process.env.DSH_RS_WORKFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'rsww-boardctl-'))
const store = reportStore()

function fakeDriver() {
  const calls = []
  return {
    calls,
    cancel() { calls.push('cancel') },
    pause() { calls.push('pause') },
    tabResume() { calls.push('tabResume'); return this.paused },
    paused: false,
    handlePost(e) { calls.push('post:' + e.kind); return true },
  }
}

function withRun(runId, driver) {
  store.start({ runId, sessionId: 's-1', templateId: 'default', request: 'x', controls: [], stepsTrace: {}, queued: [] })
  if (driver) registerDriver(runId, driver)
  return () => { if (driver) unregisterDriver(runId) }
}

test('Given running run When control cancel Then 记账(by:user)+driver.cancel 调用', () => {
  const driver = fakeDriver()
  const cleanup = withRun('r-bc-1', driver)
  const r = handleControl({ runId: 'r-bc-1', kind: 'cancel' })
  cleanup()
  assert.equal(r.ok, true)
  assert.deepEqual(driver.calls, ['cancel'])
  assert.equal(store.get('r-bc-1').controls.some((c) => c.kind === 'cancel' && c.by === 'user'), true)
})

test('Given running run When control pause Then 记账+driver.pause 调用', () => {
  const driver = fakeDriver()
  const cleanup = withRun('r-bc-2', driver)
  const r = handleControl({ runId: 'r-bc-2', kind: 'pause' })
  cleanup()
  assert.equal(r.ok, true)
  assert.deepEqual(driver.calls, ['pause'])
  assert.equal(store.get('r-bc-2').controls.some((c) => c.kind === 'pause' && c.by === 'user'), true)
})

test('Given 非 paused run When control resume Then 状态不符不受理', () => {
  const driver = fakeDriver()
  const cleanup = withRun('r-bc-3', driver)
  const r = handleControl({ runId: 'r-bc-3', kind: 'resume' })
  cleanup()
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('状态不符'))
})

test('Given verdict When 无 by 或 main-agent 无 reason Then 拒', () => {
  assert.throws(() => handleControl({ runId: 'r-bc-4', kind: 'approve' }), /by/)
  assert.throws(() => handleControl({ runId: 'r-bc-4', kind: 'approve', by: 'main-agent' }), /reason/)
  assert.throws(() => handleControl({ runId: 'r-bc-4', kind: 'ghost' }), /kind/)
})

test('Given waiting run When verdict by=user Then post 受理', () => {
  const driver = fakeDriver()
  const cleanup = withRun('r-bc-5', driver)
  const r = handleControl({ runId: 'r-bc-5', kind: 'approve', by: 'user' })
  cleanup()
  assert.equal(r.ok, true)
  assert.deepEqual(driver.calls, ['post:approve'])
})
