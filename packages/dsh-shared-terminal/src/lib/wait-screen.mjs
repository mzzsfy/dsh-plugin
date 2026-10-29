// 轮询等待屏幕文本出现;exited(终端终态)优先于 needle,超时兜底,signal 协作中止。
// 对齐 dsh-better-sidebar waitFor 的判定次序,匹配面为本插件可读的 active viewport 快照。

import { MAX_SCREEN_LINES } from './private-screen.mjs'

export const WAIT_POLL_INTERVAL_MS = 100
export const WAIT_MIN_TIMEOUT_MS = 100
export const WAIT_DEFAULT_TIMEOUT_MS = 10_000

const sleep = (ms, signal, skipSignal) => new Promise((resolve, reject) => {
  const finish = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', finish)
    skipSignal?.removeEventListener('abort', finish)
    signal?.aborted ? reject(signal.reason) : resolve()
  }
  const timer = setTimeout(finish, ms)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  signal?.addEventListener('abort', finish, { once: true })
  skipSignal?.addEventListener('abort', finish, { once: true })
  if (signal?.aborted || skipSignal?.aborted) finish()
})

// 宿主队列本身不可撤销;只结束调用方等待,迟到快照由 Promise 处理后丢弃。
const readUntilCancelled = (read, signal) => new Promise((resolve, reject) => {
  const finish = (settle, value) => { signal?.removeEventListener('abort', cancel); settle(value) }
  const cancel = () => finish(reject, signal.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) { cancel(); return }
  Promise.resolve().then(read).then(value => finish(resolve, value), error => finish(reject, error))
})

const isTerminalState = (state) => state === 'exited' || state === 'failed'

export async function waitForScreenText({ readScreen, controller, agent, id, needle, timeoutMs, signal, skipSignal, intervalMs = WAIT_POLL_INTERVAL_MS }) {
  if (typeof needle !== 'string' || needle === '') throw new RangeError('needle must be a non-empty string')
  const start = Date.now()
  const deadline = start + timeoutMs
  while (true) {
    signal?.throwIfAborted()
    const screen = await readUntilCancelled(() => readScreen(controller, agent, id, MAX_SCREEN_LINES), signal)
    signal?.throwIfAborted()
    if (isTerminalState(screen.state)) return { kind: 'exited', screen }
    if (screen.text.includes(needle)) return { kind: 'found', screen, elapsedMs: Date.now() - start }
    if (skipSignal?.aborted) return { kind: 'skipped', screen }
    if (Date.now() >= deadline) return { kind: 'timeout', screen, timeoutMs }
    await sleep(intervalMs, signal, skipSignal)
  }
}
