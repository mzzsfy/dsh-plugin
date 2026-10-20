import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForScreenText, WAIT_POLL_INTERVAL_MS } from '../src/lib/wait-screen.mjs'

const running = (text) => ({ text, lines: text.split('\n').length, truncated: false, state: 'running', sequence: 1 })

test('Given needle already on screen, When waiting, Then found immediately without polling', async () => {
  const screens = [running('ready\nBuild successful\n$')]
  const outcome = await waitForScreenText({ readScreen: () => screens.shift(), controller: {}, agent: {}, id: 't', needle: 'Build successful', timeoutMs: 1000, intervalMs: 1 })
  assert.equal(outcome.kind, 'found')
  assert.equal(screens.length, 0, '应只读一次屏幕')
  assert.ok(outcome.elapsedMs >= 0)
  assert.equal(outcome.screen.text.includes('Build successful'), true)
})

test('Given needle appears on a later poll, When waiting, Then found carries the match-time screen', async () => {
  const screens = [running('starting'), running('compiling'), running('Build successful\n$')]
  const outcome = await waitForScreenText({ readScreen: () => screens.shift(), controller: {}, agent: {}, id: 't', needle: 'Build successful', timeoutMs: 1000, intervalMs: 1 })
  assert.equal(outcome.kind, 'found')
  assert.equal(screens.length, 0, '命中后不得再轮询')
  assert.equal(outcome.screen.text, 'Build successful\n$')
})

test('Given needle never appears, When timeout elapses, Then timeout echoes the configured budget', async () => {
  const outcome = await waitForScreenText({ readScreen: () => running('$'), controller: {}, agent: {}, id: 't', needle: 'never', timeoutMs: 40, intervalMs: 5 })
  assert.equal(outcome.kind, 'timeout')
  assert.equal(outcome.timeoutMs, 40)
  assert.equal(outcome.screen.text, '$', '超时结果应携带最后一次屏幕')
})

test('Given terminal exits mid-wait, When its state is terminal, Then exited wins over a same-round needle', async () => {
  const screens = [running('$'), { text: 'Build successful\nprocess exited', lines: 2, truncated: false, state: 'exited', sequence: 2 }]
  const outcome = await waitForScreenText({ readScreen: () => screens.shift(), controller: {}, agent: {}, id: 't', needle: 'Build successful', timeoutMs: 1000, intervalMs: 1 })
  assert.equal(outcome.kind, 'exited')
  assert.equal(outcome.screen.state, 'exited')
})

test('Given failed state, When waiting, Then exited short-circuit covers failure too', async () => {
  const screens = [running('$'), { text: 'panic', lines: 1, truncated: false, state: 'failed', sequence: 2 }]
  const outcome = await waitForScreenText({ readScreen: () => screens.shift(), controller: {}, agent: {}, id: 't', needle: 'panic', timeoutMs: 1000, intervalMs: 1 })
  assert.equal(outcome.kind, 'exited')
})

test('Given an aborted turn mid-wait, When the signal fires, Then the wait rethrows instead of spinning', async () => {
  const abort = new AbortController()
  const outcome = waitForScreenText({ readScreen: () => running('$'), controller: {}, agent: {}, id: 't', needle: 'never', timeoutMs: 5000, intervalMs: 1, signal: abort.signal })
  abort.abort()
  await assert.rejects(outcome)
})

test('Given terminal closes mid-wait, When readScreen fails, Then the wait fails fast instead of spinning to timeout', async () => {
  const screens = [running('$')]
  await assert.rejects(
    waitForScreenText({
      readScreen: () => { screens.shift(); throw Object.assign(new Error('Terminal no longer available'), { code: 'terminal/unavailable' }) },
      controller: {}, agent: {}, id: 't', needle: 'done', timeoutMs: 5000, intervalMs: 1,
    }),
    /Terminal no longer available/,
  )
})

test('Given module constants, When inspected, Then the poll interval stays conservative for the private queue', () => {
  assert.equal(WAIT_POLL_INTERVAL_MS, 100)
})

test('Given empty needle, When waiting, Then rejected before any read', async () => {
  await assert.rejects(
    waitForScreenText({ readScreen: () => { throw new Error('should not read') }, controller: {}, agent: {}, id: 't', needle: '', timeoutMs: 1000, intervalMs: 1 }),
  )
})
