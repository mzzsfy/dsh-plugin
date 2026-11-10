export const name = 'dsh-stock-assistant'
export const inject = ['webServer', 'storageDomain', 'credentials']
import { setupCommonTools, createChangeNotifier } from '@mzzsfy/dsh-common-tools/host'
import { createApplication } from './application.mjs'
import { registerRoutes } from './routes.mjs'
import { serveVendor, VENDOR_PREFIX, vendorReadable } from './serve-vendor.mjs'
export async function apply(ctx) {
  if (typeof ctx.webServer?.register !== 'function' || typeof ctx.webServer?.registerUpgrade !== 'function' || typeof ctx.storageDomain?.open !== 'function') {
    ctx.logger?.warn?.('股票工具已禁用：缺少webServer或storageDomain能力')
    return
  }
  let disposed = false, application, stopRoutes, unsubscribe, notifier, bus
  ctx.effect(() => () => {
    disposed = true; stopRoutes?.(); unsubscribe?.(); notifier?.dispose()
    return application?.close()
  }, 'stock-assistant lifecycle')
  try {
    // vendor 可读性预判定先于应用构建: vendorAvailable=false 随快照下发→client 直接降级数字详情
    let vendorAvailable = true
    try { vendorAvailable = vendorReadable() } catch { vendorAvailable = false }
    // 凭据服务由宿主提供; 接口不全时应用层会整体退回进程环境变量, 不因此拒绝启动
    application = await createApplication({ storageDomain: ctx.storageDomain, credentials: ctx.credentials ?? null, publish: () => notifier?.refresh(), vendorAvailable, warn: message => ctx.logger?.warn?.(message) })
    if (disposed) { await application.close(); return }
    bus = setupCommonTools(ctx)
    notifier = createChangeNotifier(() => bus.publish({ type: 'invalidate', serverEpoch: application.snapshot().serverEpoch, snapshotSeq: application.snapshot().snapshotSeq }))
    unsubscribe = bus.subscribe(message => { if (message?.type === 'watch-demand') application.demand(message) })
    stopRoutes = registerRoutes(ctx.webServer, application)
    // 注册异常仅告警: client ensureLwc 失败同样走降级路径
    try { ctx.webServer.register({ kind: 'prefix', path: VENDOR_PREFIX, handler: serveVendor }) } catch (e) { ctx.logger?.warn?.('图表组件路由注册失败,详情将降级为数字详情') }
  } catch (e) {
    // 失败原因先落日志再清理: 清理自身抛错不能盖掉原始原因。
    // 数据域的 invalid-record 只有表/键有用, 记录值不能进日志。
    const location = e?.detail?.table === undefined ? '' : `，记录 ${e.detail.table}/${e.detail.key}`
    const reason = e && typeof e === 'object' ? `${e.code ? `${e.code}: ` : ''}${e.message || String(e)}${location}` : String(e)
    ctx.logger?.warn?.(`股票工具未激活：独立数据域或依赖初始化失败 (${reason})`)
    try { stopRoutes?.(); unsubscribe?.(); notifier?.dispose(); await application?.close() }
    catch (cleanupError) { ctx.logger?.warn?.(`股票工具清理失败: ${cleanupError?.message || cleanupError}`) }
  }
}
