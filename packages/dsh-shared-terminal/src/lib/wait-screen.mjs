// 轮询等待屏幕文本出现;exited(终端终态)优先于 needle,超时兜底,signal 协作中止。
// 对齐 dsh-better-sidebar waitFor 的判定次序,匹配面为本插件可读的 active viewport 快照。

import { MAX_SCREEN_LINES } from './private-screen.mjs'

export const WAIT_POLL_INTERVAL_MS = 100
export const WAIT_MIN_TIMEOUT_MS = 100
export const WAIT_DEFAULT_TIMEOUT_MS = 10_000

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
})

const isTerminalState = (state) => state === 'exited' || state === 'failed'

export async function waitForScreenText({ readScreen, controller, agent, id, needle, timeoutMs, signal, intervalMs = WAIT_POLL_INTERVAL_MS }) {
  if (typeof needle !== 'string' || needle === '') throw new RangeError('needle must be a non-empty string')
  const start = Date.now()
  const deadline = start + timeoutMs
  while (true) {
    signal?.throwIfAborted()
    const screen = await readScreen(controller, agent, id, MAX_SCREEN_LINES)
    if (isTerminalState(screen.state)) return { kind: 'exited', screen }
    if (screen.text.includes(needle)) return { kind: 'found', screen, elapsedMs: Date.now() - start }
    if (Date.now() >= deadline) return { kind: 'timeout', screen, timeoutMs }
    await sleep(intervalMs)
  }
}
