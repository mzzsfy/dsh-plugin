// 终端大输出吞吐兜底:宿主对每个 PTY chunk 广播一帧、客户端逐帧 ack 并逐帧提交渲染,
// 吞吐被单帧成本锁死。这里在服务端把有订阅者时连续到达的小块按窗口合并成一次 output,
// 帧数降一个量级;根因仍在宿主,补丁只消除可观察后果。关闭、无订阅者或非字符串直通原方法。
const INSTALL_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/terminal-coalesce')
export const DEFAULT_WINDOW_MS = 8
export const MAX_PENDING_BYTES = 32 * 1024
// 已启用但尚无终端时快速重试;关闭时只保留低频探测,保证重新开启后仍能热安装
export const INSTALL_RETRY_MS = 1000
export const DISABLED_INSTALL_WATCH_MS = 5 * 1000

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
  ref: undefined,
})

/**
 * 建立终端输出合并器。窗口与开关每次取用时读取,配置改动无需重装。
 * @param options - readWindow 返回合并窗口毫秒;isEnabled 每次派发读取开关;
 *   maxPendingBytes 是背压阈值;finalizationRegistry 是 GC 钩子的构造器,测试可注入替身。
 * @returns install/ensure/dispose 与测试用入口。
 */
export function createTerminalCoalescer({
  readWindow = () => DEFAULT_WINDOW_MS,
  isEnabled = () => true,
  maxPendingBytes = MAX_PENDING_BYTES,
  finalizationRegistry = typeof FinalizationRegistry === 'function' ? FinalizationRegistry : undefined,
} = {}) {
  // 每代独立登记: HMR 两代并行时, 他代 marker 不是本代已安装; 已处置代保留登记,
  // 待外层包装卸载后由新代按 underlying original 直接接管, 避免新代→外层→旧代僵尸链。
  const token = Symbol('dsh-bug-perf terminal coalesce generation')
  const marker = { token, original: undefined, patched: undefined, disposed: false }
  let disposed = false
  let prototype
  let original
  let patched
  const entries = new WeakMap()
  // 只弱引用终端: 宿主在终端结束时已从 owner.terminals 摘除实例,
  // 强引用集合会把 xterm screen 与 followers 一起钉住, 内存随终端数线性增长。
  // 只有 exited 才是收尾信号, 届时摘除; GC 兜底由 FinalizationRegistry 清掉死引用本体。
  const terminals = new Set()
  const registry = typeof finalizationRegistry === 'function'
    ? new finalizationRegistry((ref) => terminals.delete(ref))
    : undefined

  const track = (terminal) => {
    const ref = new WeakRef(terminal)
    terminals.add(ref)
    registry?.register(terminal, ref, ref)
    return ref
  }

  const untrack = (entry) => {
    const ref = entry.ref
    if (ref === undefined) return
    entry.ref = undefined
    terminals.delete(ref)
    registry?.unregister(ref)
  }

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
    entry.ref = track(terminal)
    entries.set(terminal, entry)
    return entry
  }

  const dispatch = (terminal, data) => {
    // 已处置但仍被外层包装引用: 只透传, 不再建缓冲/定时器
    if (disposed) return original.call(terminal, data)
    const entry = entryOf(terminal)
    if (typeof data !== 'string') return entry.original.call(terminal, data)
    // 空 chunk 不代表终端结束: 排空待发数据后继续透传并保留跟踪, 只有 exited 才摘除
    if (data.length === 0 && terminal.exited !== true) {
      return entry.bytes === 0
        ? entry.original.call(terminal, data)
        : flush(entry).then(() => entry.original.call(terminal, data))
    }
    if (terminal.exited === true) {
      if (data.length > 0) {
        entry.pending.push(data)
        entry.bytes += data.length
      }
      // 退出后的任何写入(含空 chunk)先排空待发数据,保证退出广播前输出已发出
      const pending = entry.bytes === 0 ? entry.original.call(terminal, data) : flush(entry)
      untrack(entry)
      return pending
    }
    if (!isEnabled()) {
      // 运行中关闭: 已缓冲的输出先排空, 之后逐块直通, 不再等待窗口
      return entry.bytes === 0
        ? entry.original.call(terminal, data)
        : flush(entry).then(() => entry.original.call(terminal, data))
    }
    if (terminal.followers.size === 0) {
      return entry.bytes === 0
        ? entry.original.call(terminal, data)
        : flush(entry).then(() => entry.original.call(terminal, data))
    }
    entry.pending.push(data)
    entry.bytes += data.length
    if (entry.bytes >= maxPendingBytes) return flush(entry)
    schedule(entry)
    return undefined
  }

  const isInstalled = () => !disposed
    && prototype !== undefined
    && prototype[INSTALL_MARKER] === marker
    && prototype.output === patched

  const install = (terminal) => {
    if (isInstalled()) return true
    if (!hasShape(terminal)) return false
    const proto = Object.getPrototypeOf(terminal)
    if (typeof proto?.output !== 'function') return false
    const owner = proto[INSTALL_MARKER]
    let nextOriginal = proto.output
    if (owner !== undefined && owner !== marker) {
      // 他代仍活跃或外层仍在: 不覆盖, 等待探测重试
      const canTakeover = typeof owner === 'object' && owner.disposed === true
        && proto.output === owner.patched
        && typeof owner.original === 'function'
      if (!canTakeover) return false
      // 外层已卸载, 绕过已处置的旧包装, 直接接在其 original 上
      nextOriginal = owner.original
    } else if (owner === marker && disposed && proto.output === patched && typeof marker.original === 'function') {
      nextOriginal = marker.original
    }
    prototype = proto
    original = nextOriginal
    patched = function output(data) { return dispatch(this, data) }
    disposed = false
    marker.disposed = false
    marker.original = original
    marker.patched = patched
    proto[INSTALL_MARKER] = marker
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
      if (isInstalled()) return true
      for (const owner of controller?.owners?.values?.() ?? []) {
        for (const terminal of owner?.terminals?.values?.() ?? []) {
          if (install(terminal)) return true
        }
      }
      return false
    },
    get installed() { return isInstalled() },
    /** 仍被弱引用跟踪的终端数;只用于测试与现场排查内存面。 */
    get tracked() { return terminals.size },
    // 只还原自己安装的包装,避免多实例/HMR 交错卸掉别人的补丁
    dispose() {
      for (const ref of terminals) {
        registry?.unregister(ref)
        const terminal = ref.deref()
        if (terminal === undefined) continue
        const entry = entries.get(terminal)
        if (entry !== undefined) {
          entry.ref = undefined
          flush(entry)
        }
      }
      terminals.clear()
      disposed = true
      marker.disposed = true
      if (prototype === undefined) return
      if (prototype.output === patched) {
        prototype.output = original
        if (prototype[INSTALL_MARKER] === marker) delete prototype[INSTALL_MARKER]
        prototype = undefined
        return
      }
      // 外层包装仍在顶部: 保留 marker/original/patched(pass-through), 等外层卸载后新代接管
    },
  }
}

/**
 * 在宿主半区安装:依赖 terminalController,首个终端出现后惰性 patch 原型。
 * 关闭时保留低频探测,避免启动时关闭后再开启永远装不上;安装完成后探测停止。
 * @param ctx - 插件上下文。
 * @param options - isEnabled 读取开关;readWindow 读取窗口毫秒;timers 可注入定时器实现。
 * @returns 卸载函数(排空并还原)。
 */
export function installTerminalCoalesce(ctx, { isEnabled = () => true, readWindow, timers } = {}) {
  const clock = timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }
  const coalescer = createTerminalCoalescer({ readWindow, isEnabled })
  let retry
  const stop = () => {
    if (retry !== undefined) {
      clock.clearTimeout(retry)
      retry = undefined
    }
  }
  const dispose = () => {
    stop()
    coalescer.dispose()
  }
  const schedule = (delay) => {
    if (retry !== undefined || coalescer.installed) return
    retry = clock.setTimeout(tick, delay)
    // 宿主长期无终端时不该拖住进程退出
    retry.unref?.()
  }
  // 服务取用放在 tick 内:首个终端尚未创建时稍后重试;关闭时也先装好包装,派发按开关直通
  const tick = () => {
    retry = undefined
    if (coalescer.installed) return
    const controller = ctx.get('terminalController')
    if (controller !== undefined && coalescer.ensure(controller)) return
    schedule(isEnabled() ? INSTALL_RETRY_MS : DISABLED_INSTALL_WATCH_MS)
  }
  ctx.effect(() => {
    tick()
    return dispose
  }, 'bug-perf terminal coalesce')
  return dispose
}
