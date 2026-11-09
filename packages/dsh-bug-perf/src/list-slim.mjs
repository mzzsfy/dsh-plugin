// 会话列表瘦身:session/list 为每个会话下发完整投影快照,列表行只消费其中少数几项。
// 本模块在 remote 方法返回前按白名单裁剪并缓存结果。任何失败路径都降级为原行为:
// 未装载、形状不符、原方法抛错一律透传,不影响本插件的其它补丁。
// sessionController 经 ctx.inject 可选依赖取得,宿主缺该服务时静默等待。
// 缓存只服务 owner/本地调用:非 owner Remote 主体直接透传原方法,避免跨主体命中共享缓存。

// 列表行消费的投影;其余键不下发。被裁掉的投影仍由会话详情接口完整返回。
export const KEEP_PROJECTIONS = ['title', 'sessionListMetadata', 'inbox', 'modelSelection', 'tokenUsage']

// 缓存有效期:会话增删立即失效,TTL 只兜底标题与运行时状态的漂移。
export const TTL_MS = 15 * 1000

// 启动后预热延迟:让宿主先完成装载,再让出一次列表重建。
export const WARMUP_DELAY_MS = 10 * 1000

// 预热等待上限:宿主列表长期不返回时不无限占用共享构建。
export const WARMUP_TIMEOUT_MS = 2 * 60 * 1000

const LOG_PREFIX = '[dsh-bug-perf] 列表瘦身'
const INSTALL_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/list-slim')
const WRAPPED_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/list-slim/wrapped')

/**
 * 当前 receiver 是否来自非 owner Remote 主体。
 * 与宿主 remoteAccess.allows 的判定同源:owner 或非 Remote 调用没有 principal。
 * @param receiver - 列表方法调用时的 this。
 * @returns 非 owner 主体返回 true。
 */
function isNonOwner(receiver) {
  const principal = receiver?.ctx?.invocation?.peer?.principal
  return principal !== undefined && principal.kind !== 'owner'
}

/**
 * 让一个调用者按自己的 signal 等待共享构建,取消只影响本次等待。
 * @param promise - 共享的列表构建。
 * @param signal - 调用者的取消信号。
 * @returns 本调用者的等待结果。
 */
function raceWithSignal(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * 裁剪一条列表项的投影,只保留白名单里的键。
 * @param item - 宿主返回的列表项。
 * @param keep - 保留的投影键。
 * @returns 投影已裁剪的列表项;形状不符时原样返回。
 */
export function slimItem(item, keep = KEEP_PROJECTIONS) {
  const values = item?.projections?.values
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return item
  const picked = {}
  for (const key of keep) if (key in values) picked[key] = values[key]
  return { ...item, projections: { ...item.projections, values: picked } }
}

/**
 * 给 sessionController.list 装上裁剪与缓存。
 * @param ctx - 宿主上下文。
 * @param options - 开关、白名单、缓存有效期与预热延迟。
 * @returns 是否提交了装载回调;sessionController 缺席时回调不执行,宿主行为不变。
 */
export function installListSlim(ctx, options = {}) {
  const {
    isEnabled,
    keep = KEEP_PROJECTIONS,
    ttlMs = TTL_MS,
    warmupDelayMs = WARMUP_DELAY_MS,
  } = options
  const warn = (message) => ctx.logger?.warn?.(LOG_PREFIX + ' ' + message)
  try {
    ctx.inject(['sessionController'], (scope) => {
      try {
        const controller = scope.sessionController
        const original = controller?.list
        if (typeof original !== 'function') {
          warn('sessionController.list 不可用,跳过')
          return
        }
        if (controller[INSTALL_MARKER] !== undefined && controller.list?.[WRAPPED_MARKER] === true) return
        let cache
        let cachedAt = 0
        let inflight
        let generation = 0
        let active = true

        const fresh = () => cache !== undefined && Date.now() - cachedAt < ttlMs
        const invalidate = () => {
          generation += 1
          cachedAt = 0
        }
        scope.on('api-session/added', invalidate)
        scope.on('api-session/removed', invalidate)

        // 每个调用者独立等待共享构建;所有等待者都取消时中止构建,避免挂起被后续调用复用
        const awaitBuild = (entry, signal) => {
          const waiter = {}
          entry.waiters.add(waiter)
          const result = raceWithSignal(entry.promise, signal)
          const settle = () => {
            entry.waiters.delete(waiter)
            if (entry.waiters.size === 0 && inflight === entry) {
              entry.controller.abort()
              inflight = undefined
            }
          }
          result.then(settle, settle)
          return result
        }

        // 缓存跨调用共享,按 TTL 与会话增删事件失效;非 owner 不读写缓存。
        // 普通函数保留调用方 receiver:宿主在 list 内按 invocation 做逐项鉴权。
        const wrapped = function list(request, signal) {
          const receiver = this
          // 卸载、关闭、已取消或非 owner:不裁剪、不缓存,原样交给宿主
          if (!active || signal?.aborted || (isEnabled !== undefined && !isEnabled()) || isNonOwner(receiver)) {
            return original.call(receiver, request, signal)
          }
          if (fresh()) return cache
          // 共享构建不绑定任何调用者的 signal;调用者取消只结束自己的等待
          if (inflight !== undefined && inflight.generation === generation) return awaitBuild(inflight, signal)
          const current = generation
          const buildController = new AbortController()
          const entry = { promise: undefined, generation: current, controller: buildController, waiters: new Set() }
          const created = Promise.resolve(original.call(receiver, request, buildController.signal))
            .then((value) => {
              if (!Array.isArray(value?.items)) return value
              const slimmed = { items: value.items.map((item) => slimItem(item, keep)) }
              // 在途期间发生增删失效时只返回本次结果,不把旧快照写回缓存
              if (generation === current && inflight === entry) {
                cache = slimmed
                cachedAt = Date.now()
              }
              return slimmed
            })
            .finally(() => {
              if (inflight === entry) inflight = undefined
            })
          entry.promise = created
          inflight = entry
          return awaitBuild(entry, signal)
        }
        Object.defineProperty(controller, INSTALL_MARKER, { value: wrapped, configurable: true })
        Object.defineProperty(wrapped, WRAPPED_MARKER, { value: true })
        try {
          controller.list = wrapped
        } catch (error) {
          if (controller[INSTALL_MARKER] === wrapped) delete controller[INSTALL_MARKER]
          throw error
        }
        let timer
        if (warmupDelayMs >= 0) {
          timer = setTimeout(() => {
            if (isEnabled !== undefined && !isEnabled()) return
            if (fresh() || inflight !== undefined) return
            const timeout = AbortSignal.timeout?.(WARMUP_TIMEOUT_MS)
            void wrapped.call(controller, {}, timeout).catch(() => {})
          }, warmupDelayMs)
          timer.unref?.()
        }

        // 卸载恢复原方法:按包装标记与归属判断,不摘掉后装或其它实例的包装;
        // 已被后装引用时由 active 失活,链上继续透传;在途构建一并中止
        const dispose = () => {
          active = false
          if (timer !== undefined) clearTimeout(timer)
          if (inflight !== undefined) {
            inflight.controller.abort()
            inflight = undefined
          }
          if (controller[INSTALL_MARKER] === wrapped && controller.list?.[WRAPPED_MARKER] === true) controller.list = original
          if (controller[INSTALL_MARKER] === wrapped) delete controller[INSTALL_MARKER]
        }
        try {
          scope.effect(() => dispose)
        } catch (error) {
          // effect 注册失败时回滚包装与标记,避免留下无法卸载的包装
          dispose()
          throw error
        }
        ctx.logger?.info?.(`${LOG_PREFIX} 已装载 (keep=${keep.join(',')} ttl=${ttlMs}ms)`)
      } catch (error) {
        warn('装载失败,保持原行为: ' + String(error?.message ?? error))
      }
    })
    return true
  } catch (error) {
    warn('未启用: ' + String(error?.message ?? error))
    return false
  }
}
