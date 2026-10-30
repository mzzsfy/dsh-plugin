export const name = 'dsh-stock-sidebar'
export const inject = ['webServer', 'storageDomain']
import { setupCommonTools, createChangeNotifier } from '@mzzsfy/dsh-common-tools/host'
import { createApplication } from './application.mjs'
import { registerRoutes } from './routes.mjs'
export async function apply(ctx) {
  if (typeof ctx.webServer?.register !== 'function' || typeof ctx.webServer?.registerUpgrade !== 'function' || typeof ctx.storageDomain?.open !== 'function') {
    ctx.logger?.warn?.('股票工具已禁用：缺少webServer或storageDomain能力')
    return
  }
  let disposed = false, application, stopRoutes, unsubscribe, notifier, bus
  ctx.effect(() => () => {
    disposed = true; stopRoutes?.(); unsubscribe?.(); notifier?.dispose()
    return application?.close()
  }, 'stock-sidebar lifecycle')
  try {
    application = await createApplication({ storageDomain: ctx.storageDomain, publish: () => notifier?.refresh() })
    if (disposed) { await application.close(); return }
    bus = setupCommonTools(ctx)
    notifier = createChangeNotifier(() => bus.publish({ type: 'invalidate', serverEpoch: application.snapshot().serverEpoch, snapshotSeq: application.snapshot().snapshotSeq }))
    unsubscribe = bus.subscribe(message => { if (message?.type === 'watch-demand') application.demand(message) })
    stopRoutes = registerRoutes(ctx.webServer, application)
  } catch (e) {
    stopRoutes?.(); unsubscribe?.(); notifier?.dispose(); await application?.close()
    ctx.logger?.warn?.('股票工具未激活：独立数据域或依赖初始化失败')
  }
}
