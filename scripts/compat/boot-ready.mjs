// 宿主就绪等待:echo 探活与 boot 就绪轮询。抽出来是因为 STOP 标记必须在此层
// 即时中断——keep-stop 只等 KEEPER_STOP_TIMEOUT_MS 就强杀 keeper,迟到退出
// 会跳过 keeper finally 的根桥还原与锁清理,把根 node_modules 留在 compat 重指态。
import { existsSync, readFileSync } from 'node:fs'
import { log } from './lib.mjs'

export const BOOT_TIMEOUT_MS = 150 * 1000
export const READY_POLL_MS = 1500
const ECHO_PROBE_TIMEOUT_MS = 30 * 1000
const ECHO_PROBE_POLL_MS = 1000
const PAGE_PROBE_TIMEOUT_MS = 4000
const TOKEN_PATTERN = /token=([A-Za-z0-9_-]+)/g

// 起停标记由宿主(信号)与 keep-stop(STOP 文件)两侧置位,轮询任一命中即中止
export class KeeperStop extends Error {
  constructor(detail = '收到 STOP 标记或终止信号') {
    super(`${detail},停止启动`)
    this.name = 'KeeperStop'
  }
}

export const stopRequestedBy = ({ stopFlag, signalRequested = () => false } = {}) => {
  if (signalRequested()) return true
  return stopFlag !== undefined && existsSync(stopFlag)
}

export function tokenFromLog(bootLogPath) {
  try {
    const hits = [...readFileSync(bootLogPath, 'utf8').matchAll(TOKEN_PATTERN)]
    return hits.length > 0 ? hits.at(-1)[1] : null
  } catch {
    return null
  }
}

async function probePage(base, token) {
  const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual', signal: AbortSignal.timeout(PAGE_PROBE_TIMEOUT_MS) })
  return res.status === 200 || (res.status >= 300 && res.status < 400)
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms))

// 就绪轮询:token 出现在 boot 日志后以 token 探前端路由,任一成功即就绪。
// child 退出、STOP/信号、超时三种终止态分别抛出,调用方据此收尾(不得静默继续)。
export async function awaitHostReady({
  child,
  base,
  bootLogPath,
  stopFlag,
  timeoutMs = BOOT_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  signalRequested = () => false,
  readToken = tokenFromLog,
  probe = probePage,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (child.exitCode !== null) throw new Error(`宿主早退 code=${child.exitCode},日志 ${bootLogPath}`)
    if (stopRequestedBy({ stopFlag, signalRequested })) throw new KeeperStop()
    const token = readToken(bootLogPath)
    if (token !== null) {
      try {
        if (await probe(base, token)) {
          // 探活往返期间可能刚收到 STOP:交接前复核,避免把已要求停止的宿主写进 live.json
          if (stopRequestedBy({ stopFlag, signalRequested })) throw new KeeperStop()
          return token
        }
      } catch (error) {
        if (error instanceof KeeperStop) throw error
        // 前端未就绪,继续轮询
      }
    }
    await sleep(pollMs)
  }
  throw new Error(`boot 超时未就绪,日志 ${bootLogPath}`)
}

// echo-upstream 探活:gateway seed 场景下宿主先于 echo 就绪会让 provider 首轮
// 注册落空(NO_ADAPTER 空转),每轮宿主 spawn 前必须确认 llmPort 控制面就绪。
// 只探活不代启——echo 生命周期归外部(run.mjs/人工)管,boot-keep 只守住顺序
export async function awaitEchoReady(llmPort, {
  timeoutMs = ECHO_PROBE_TIMEOUT_MS,
  pollMs = ECHO_PROBE_POLL_MS,
  stopFlag,
  signalRequested = () => false,
  probe = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    // 断言控制面响应体形态({requests,lastRequestId}):端口被无关服务占且 200 时防假绿
    const body = await res.json().catch(() => null)
    return res.ok && body !== null && Array.isArray(body.requests)
  },
  sleep = defaultSleep,
  now = Date.now,
  logFn = log,
} = {}) {
  const url = `http://127.0.0.1:${llmPort}/control/requests`
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (stopRequestedBy({ stopFlag, signalRequested })) throw new KeeperStop()
    try {
      if (await probe(url)) { logFn(`[daemon] echo 就绪 ${url}`); return }
    } catch (error) {
      if (error instanceof KeeperStop) throw error
      // 未就绪
    }
    await sleep(pollMs)
  }
  throw new Error(`echo 未就绪(${url},${timeoutMs / 1000}s):宿主先起会 NO_ADAPTER 空转,先起 echo-upstream 再启动 boot-keep`)
}
