import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSeedBoard } from './fixtures/seed-board.mjs'
import { queryBoard } from '../lib/core/query.mjs'

test('Given reproducible populated board When projected Then seven full counts and multi-run stable IDs are returned', () => {
  const fixture = makeSeedBoard()
  const result = queryBoard(fixture.tasks, { globalStopped: false, globalStopGeneration: 0 }, { limit: 50 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.counts, {
    draft: 2, ready: 2, implementing: 2, awaiting_acceptance: 2, completed: 2, blocked: 2, cancelled: 2,
  })
  assert.equal(result.result.items.length, 14)
  const running = result.result.items.find((item) => item.taskId === 'fixture-running')
  assert.deepEqual(running?.runs.map((run) => run.runId), ['run-implementation', 'run-repair'])
  assert.equal(running?.activeRunCount, 1)
})

test('Given identical seeds When generated repeatedly Then fixture data is deterministic and isolated', () => {
  const first = makeSeedBoard()
  const second = makeSeedBoard()
  assert.notEqual(first.tasks, second.tasks)
  assert.notEqual(first.tasks[0], second.tasks[0])
  assert.deepEqual(first.tasks.map((t) => [t.taskId, t.businessState]), second.tasks.map((t) => [t.taskId, t.businessState]))
  first.tasks[0].title = 'mutation'
  assert.notEqual(second.tasks[0].title, 'mutation')
})
