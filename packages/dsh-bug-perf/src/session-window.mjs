// 会话历史窗口收敛:宿主按固定消息配额(500 条 / 至少 2 个 turn)下发首屏与重连窗口,
// 工具密集的会话会放大到数千事件、数 MB,打开与重连时一次性传输并渲染。
// 本模块在宿主半区包装 sessionController 的三个历史入口(follow / page / events),
// 把消息预算与轮边界下限压到配置值,并按宿主校验规则保证 minMessages <= maxMessages。
// 首屏规模实际由 minMessages 决定(turn 边界先停),maxMessages 只兜上限。
// 任何失败路径都透传原参数:开关关闭、形状不符、包装抛错都不改变宿主行为。

const LOG_PREFIX = '[dsh-bug-perf] 历史窗口'
const INSTALL_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/session-window')

// 宿主 history 请求里承载窗口预算的字段;三者同源,包装口径一致
export const HISTORY_METHODS = Object.freeze(['follow', 'page', 'events'])

// 宿主只接受正安全整数;上限本身非法时按不收敛处理,不能把坏值写进请求
const capOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY)

// 收敛后的请求;不改请求身份字段(address / throughSeq / beforeSeq / activate 等)
export function limitHistoryRequest(request, window) {
  if (request === null || typeof request !== 'object') return request
  const cap = capOf(window?.maxMessages)
  const minCap = capOf(window?.minMessages)
  const turnCap = capOf(window?.minTurns)
  const budget = Number.isFinite(request.maxMessages) ? request.maxMessages : undefined
  const cappedBudget = budget === undefined ? undefined : Math.min(budget, cap)
  const turnWindow = request.turnWindow !== null && typeof request.turnWindow === 'object' ? request.turnWindow : undefined
  // 宿主校验要求 minMessages <= maxMessages,预算下调后必须同步收敛
  const minMessages = turnWindow !== undefined && Number.isFinite(turnWindow.minMessages)
    ? Math.min(turnWindow.minMessages, minCap, cappedBudget ?? Number.POSITIVE_INFINITY)
    : undefined
  const minTurns = turnWindow !== undefined && Number.isFinite(turnWindow.minTurns)
    ? Math.min(turnWindow.minTurns, turnCap)
    : undefined
  const budgetChanged = budget !== undefined && cappedBudget !== budget
  const windowChanged = turnWindow !== undefined
    && ((minMessages !== undefined && minMessages !== turnWindow.minMessages) || (minTurns !== undefined && minTurns !== turnWindow.minTurns))
  if (!budgetChanged && !windowChanged) return request
  return {
    ...request,
    ...budgetChanged ? { maxMessages: cappedBudget } : {},
    ...turnWindow === undefined || !windowChanged ? {} : {
      turnWindow: {
        ...turnWindow,
        ...minMessages !== undefined ? { minMessages } : {},
        ...minTurns !== undefined ? { minTurns } : {},
      },
    },
  }
}

/**
 * 沿原型链取实现:宿主的服务方法定义在类原型上,实例上的同名属性可能被
 * Cordis 的依赖追踪器包成绑定代理,直接保存它会在调用时丢返回值。
 * @param controller - 服务实例。
 * @param method - 方法名。
 * @returns 原型链上第一个函数实现,缺失时返回 undefined。
 */
function implementationOf(controller, method) {
  for (let proto = Object.getPrototypeOf(controller); proto !== null; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method)
    if (typeof descriptor?.value === 'function') return descriptor.value
  }
  return undefined
}

/**
 * 给 sessionController 的历史入口装上窗口上限。
 * @param ctx - 宿主上下文。
 * @param options - 开关与窗口上限读取器;两者都在每次调用时求值,支持热改配置。
 * @returns 是否提交了装载回调;sessionController 缺席时回调不执行,宿主行为不变。
 */
export function installSessionWindow(ctx, options = {}) {
  const { isEnabled, readWindow } = options
  const warn = (message) => ctx.logger?.warn?.(LOG_PREFIX + ' ' + message)
  try {
    ctx.inject(['sessionController'], (scope) => {
      try {
        const controller = scope.sessionController
        if (controller === undefined || controller === null) {
          warn('sessionController 不可用,跳过')
          return
        }
        let active = true
        let disposed = false
        // 每代独立 marker: 旧代未卸载时新代登记等待, 旧代 dispose 后同步接管,
        // 避免新代直接放弃、旧代卸载后窗口限制静默消失。
        const marker = { wrapped: new Map(), waiters: new Set() }

        // 读取当前窗口上限;开关与配置读取抛错都按关闭处理,保证包装自身永不成为失败源
        const currentWindow = () => {
          if (!active) return undefined
          try {
            return isEnabled !== undefined && !isEnabled() ? undefined : readWindow?.()
          } catch {
            return undefined
          }
        }

        for (const method of HISTORY_METHODS) {
          const implementation = implementationOf(controller, method)
          if (implementation === undefined) continue
          // 只替换首个参数(请求),其余参数(cancellation signal 等)原样转发;
          // receiver 用调用方的 this: 宿主按 invocation 逐项过滤时按实例身份判定
          const patched = function (...args) {
            const window = currentWindow()
            if (window === undefined) return implementation.apply(this, args)
            let next = args[0]
            try {
              next = limitHistoryRequest(args[0], window)
            } catch {
              next = args[0]
            }
            args[0] = next
            return implementation.apply(this, args)
          }
          marker.wrapped.set(method, patched)
        }
        if (marker.wrapped.size === 0) {
          warn('sessionController 缺少历史入口,跳过')
          return
        }

        const install = () => {
          if (controller[INSTALL_MARKER] === marker) return true
          if (controller[INSTALL_MARKER] !== undefined) return false
          // 实例上定义同名属性覆盖原型方法;卸载时删除属性即回到原型实现
          Object.defineProperty(controller, INSTALL_MARKER, { value: marker, configurable: true })
          const applied = []
          try {
            for (const [method, patched] of marker.wrapped) {
              Object.defineProperty(controller, method, { value: patched, writable: true, configurable: true })
              applied.push(method)
            }
          } catch (error) {
            for (const method of applied) delete controller[method]
            delete controller[INSTALL_MARKER]
            throw error
          }
          return true
        }

        const tryInstall = () => {
          if (!active) return
          const owner = controller[INSTALL_MARKER]
          if (owner === marker) return
          if (owner !== undefined) {
            owner?.waiters?.add(tryInstall)
            return
          }
          try {
            install()
          } catch (error) {
            warn('等待后装载失败: ' + String(error?.message ?? error))
          }
        }

        const dispose = () => {
          if (disposed) return
          disposed = true
          active = false
          const ownsMarker = controller[INSTALL_MARKER] === marker
          // 服务属性读取可能被依赖追踪代理包成新引用,比较要取实例上的属性描述符
          for (const [method, patched] of marker.wrapped) {
            if (Object.getOwnPropertyDescriptor(controller, method)?.value === patched) delete controller[method]
          }
          if (!ownsMarker) return
          delete controller[INSTALL_MARKER]
          // 先恢复自己的包装,再唤醒等待代;等待代看到 marker 已空后接管
          const waiters = [...marker.waiters]
          marker.waiters.clear()
          for (const waiter of waiters) waiter()
        }

        const owner = controller[INSTALL_MARKER]
        if (owner === undefined) install()
        else if (typeof owner?.waiters?.add === 'function') owner.waiters.add(tryInstall)
        else {
          warn('检测到不可接管的窗口包装,跳过')
          return
        }
        const cleanup = () => {
          active = false
          owner?.waiters?.delete(tryInstall)
          dispose()
        }
        try {
          scope.effect(() => cleanup)
        } catch (error) {
          cleanup()
          throw error
        }
        if (controller[INSTALL_MARKER] === marker) {
          ctx.logger?.info?.(`${LOG_PREFIX} 已装载 (${[...marker.wrapped.keys()].join(',')})`)
        } else {
          ctx.logger?.info?.(`${LOG_PREFIX} 等待旧代卸载 (${[...marker.wrapped.keys()].join(',')})`)
        }
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
