// 终端大输出吞吐兜底:宿主对每个 PTY chunk 广播一帧、客户端逐帧 ack 并逐帧提交渲染,
// 吞吐被单帧成本锁死。这里在服务端把有订阅者时连续到达的小块按窗口合并成一次 output,
// 帧数降一个量级;根因仍在宿主,补丁只消除可观察后果。无订阅者或非字符串直通原方法。
const INSTALL_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/terminal-coalesce')
export const DEFAULT_WINDOW_MS = 8
export const MAX_PENDING_BYTES = 32 * 1024

const hasShape = (terminal) => typeof terminal?.output === 'function'
  && terminal?.followers instanceof Set

/**
 * 合并器的单终端状态:累积缓冲、定时器与串行写链。
 * @param terminal - 宿主终端实例。
 * @param original - 安装时捕获的原始 output。
 * @returns 新状态。
 */
const createEntry = (terminal, original) => ({
  terminal,
  original,
  pending: [],
  bytes: 0,
  timer: undefined,
  chain: Promise.resolve(),
})

/**
 * 建立终端输出合并器。窗口与开关每次取用时读取,配置改动无需重装。
 * @param options - readWindow 返回合并窗口毫秒;maxPendingBytes 是背压阈值。
 * @returns install/ensure/dispose 与测试用入口。
 */
export function createTerminalCoalescer({ readWindow = () => DEFAULT_WINDOW_MS, maxPendingBytes = MAX_PENDING_BYTES } = {}) {
  let prototype
  let original
  let patched
  const entries = new WeakMap()
  const terminals = new Set()

  const flush = (entry) => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.bytes === 0) return entry.chain
    const data = entry.pending.join('')
    entry.pending = []
    entry.bytes = 0
    // 串行写链保证合并批次顺序;失败只影响本批,链不断以免后续输出丢失
    entry.chain = entry.chain.then(() => entry.original.call(entry.terminal, data)).catch(() => {})
    return entry.chain
  }

  const schedule = (entry) => {
    if (entry.timer !== undefined) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      flush(entry)
    }, readWindow())
  }

  const entryOf = (terminal) => {
    const known = entries.get(terminal)
    if (known !== undefined) return known
    const entry = createEntry(terminal, original)
    entries.set(terminal, entry)
    terminals.add(terminal)
    return entry
  }

  const dispatch = (terminal, data) => {
    const entry = entryOf(terminal)
    if (typeof data !== 'string') return entry.original.call(terminal, data)
    // 收尾调用:先排空再透传,保证退出广播前输出已发出
    if (data.length === 0) return entry.bytes === 0 ? entry.original.call(terminal, data) : flush(entry)
    if (terminal.followers.size === 0) {
      return entry.bytes === 0
        ? entry.original.call(terminal, data)
        : flush(entry).then(() => entry.original.call(terminal, data))
    }
    entry.pending.push(data)
    entry.bytes += data.length
    if (terminal.exited === true || entry.bytes >= maxPendingBytes) return flush(entry)
    schedule(entry)
    return undefined
  }

  const install = (terminal) => {
    if (prototype?.[INSTALL_MARKER] === true) return true
    if (!hasShape(terminal)) return false
    const proto = Object.getPrototypeOf(terminal)
    if (typeof proto?.output !== 'function') return false
    prototype = proto
    if (proto[INSTALL_MARKER] === true) return true
    original = proto.output
    patched = function output(data) { return dispatch(this, data) }
    proto[INSTALL_MARKER] = true
    proto.output = patched
    return true
  }

  return {
    install,
    /**
     * 遍历当前 Session 已创建的终端;宿主启动早期没有实例时返回 false,由调用方稍后重试。
     * @param controller - terminalController 服务。
     * @returns 安装成功返回 true。
     */
    ensure(controller) {
      if (prototype?.[INSTALL_MARKER] === true) return true
      for (const owner of controller?.owners?.values?.() ?? []) {
        for (const terminal of owner?.terminals?.values?.() ?? []) {
          if (install(terminal)) return true
        }
      }
      return false
    },
    get installed() { return prototype?.[INSTALL_MARKER] === true },
    // 只还原自己安装的包装,避免多实例/HMR 交错卸掉别人的补丁
    dispose() {
      for (const terminal of terminals) {
        const entry = entries.get(terminal)
        if (entry !== undefined) flush(entry)
      }
      if (patched !== undefined && prototype?.output === patched) {
        prototype.output = original
        delete prototype[INSTALL_MARKER]
      }
      prototype = undefined
      original = undefined
      patched = undefined
    },
  }
}

/**
 * 在宿主半区安装:依赖 terminalController,首个终端出现后惰性 patch 原型。
 * @param ctx - 插件上下文。
 * @param options - isEnabled 读取开关;readWindow 读取窗口毫秒。
 * @returns 卸载函数(排空并还原)。
 */
export function installTerminalCoalesce(ctx, { isEnabled, readWindow }) {
  const coalescer = createTerminalCoalescer({ readWindow })
  let retry
  const stop = () => {
    if (retry !== undefined) {
      clearInterval(retry)
      retry = undefined
    }
  }
  const dispose = () => {
    stop()
    coalescer.dispose()
  }
  // 服务取用放在 tick 内:配置关闭或首个终端尚未创建时都能自行收敛
  const tick = () => {
    if (!isEnabled()) return
    const controller = ctx.get('terminalController')
    if (controller !== undefined && coalescer.ensure(controller)) stop()
  }
  ctx.effect(() => {
    tick()
    if (isEnabled() && retry === undefined && !coalescer.installed) {
      retry = setInterval(tick, 1000)
      // 宿主长期无终端时不该拖住进程退出
      retry.unref?.()
    }
    return dispose
  }, 'bug-perf terminal coalesce')
  return dispose
}
