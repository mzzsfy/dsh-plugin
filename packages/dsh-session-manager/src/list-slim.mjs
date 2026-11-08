// 会话列表瘦身:session/list 为每个会话下发完整投影快照,列表行只消费其中少数几项。
// 本模块在 remote 方法返回前按白名单裁剪并缓存结果。任何失败路径都降级为原行为:
// 未装载、形状不符、原方法抛错一律透传,不影响本插件的其它功能。
// sessionController 经 ctx.inject 可选依赖取得,宿主缺该服务时本能力静默关闭。

// 列表行消费的投影;其余键不下发。被裁掉的投影仍由会话详情接口完整返回。
export const KEEP_PROJECTIONS = ['title', 'sessionListMetadata', 'inbox', 'modelSelection', 'tokenUsage']

// 缓存有效期:会话增删立即失效,TTL 只兜底标题与运行时状态的漂移。
export const TTL_MS = 15 * 1000

// 启动后预热延迟:让宿主先完成装载,再让出一次列表重建。
export const WARMUP_DELAY_MS = 10 * 1000

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
    enabled = true,
    isEnabled,
    keep = KEEP_PROJECTIONS,
    ttlMs = TTL_MS,
    warmupDelayMs = WARMUP_DELAY_MS,
  } = options
  if (!enabled) return false
  const warn = (message) => ctx.logger?.warn?.('session-manager: 列表瘦身 ' + message)
  try {
    ctx.inject(['sessionController'], (scope) => {
      try {
        const controller = scope.sessionController
        const original = controller?.list
        if (typeof original !== 'function') return
        let cache
        let cachedAt = 0
        let inflight

        const fresh = () => cache !== undefined && Date.now() - cachedAt < ttlMs
        const invalidate = () => {
          cachedAt = 0
        }
        scope.on('api-session/added', invalidate)
        scope.on('api-session/removed', invalidate)

        // 只在调用方这一次请求上构建并缓存:不额外探测一次原方法,形状不符仅本次透传
        controller.list = async (request, signal) => {
          // 开关每次读取:设置页改动即时生效,无需重载插件
          if (isEnabled !== undefined && !isEnabled()) return original.call(controller, request, signal)
          if (fresh()) return cache
          if (inflight !== undefined) return inflight
          inflight = Promise.resolve(original.call(controller, request, signal))
            .then((value) => {
              if (!Array.isArray(value?.items)) return value
              cache = { items: value.items.map((item) => slimItem(item, keep)) }
              cachedAt = Date.now()
              return cache
            })
            .finally(() => {
              inflight = undefined
            })
          return inflight
        }

        let timer
        if (warmupDelayMs >= 0) {
          timer = setTimeout(() => {
            if (isEnabled !== undefined && !isEnabled()) return
            if (fresh() || inflight !== undefined) return
            void controller.list({}, undefined).catch(() => {})
          }, warmupDelayMs)
          timer.unref?.()
        }

        // 卸载恢复原方法:本能力退出不改变宿主的列表语义
        scope.effect(() => () => {
          if (timer !== undefined) clearTimeout(timer)
          controller.list = original
        })
        ctx.logger?.info?.(`session-manager: 列表瘦身已启用 (keep=${keep.join(',')} ttl=${ttlMs}ms)`)
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
