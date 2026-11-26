import { z } from 'zod'
import { StockError, fail } from './market-model.mjs'
import { withRouteGate } from './route-gate.mjs'
const PREFIX = '/api/stock-assistant'
// catalog-sync 分页抓全量目录: 单独预算; 探针与其余路由都由应用层推导(见 application.providerCheckTimeoutMs / routeTimeoutMs),
// 应用层给不出时退回这里的兜底值
const PROVIDER_CHECK_TIMEOUT_MS = 60 * 1000, CATALOG_SYNC_TIMEOUT_MS = 120 * 1000, DEFAULT_ROUTE_TIMEOUT_MS = 10 * 1000
const operationSchema = z.object({ operationId: z.uuid(), expectedRevision: z.number().int().nonnegative() })
async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) fail('BODY_TOO_LARGE', '请求内容过大', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { fail('INVALID_JSON', '请求必须为JSON') }
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value))
}
export function registerRoutes(webServer, app, ctx) {
  const handlers = {
    snapshot: ['GET', () => app.snapshot()],
    search: ['GET', async (input, signal) => await app.search(input.q || '', input.phase === 'remote' ? 'remote' : 'local', signal)],
    browse: ['GET', input => app.browse(input)],
    watchlist: ['POST', input => { operationSchema.parse(input); return app.watchlist(input) }],
    preferences: ['POST', input => { operationSchema.parse(input); return app.preferences({ ...input, payload: input.patch }) }],
    configuration: ['POST', input => { operationSchema.parse(input); return app.configuration({ ...input, payload: { providers: input.providers, routes: input.routes } }) }],
    'provider-check': ['POST', (input, signal) => app.providerCheck(input, signal)],
    credential: ['POST', input => app.credential(input)],
    'catalog-sync': ['POST', input => app.sync(input)],
    'route-selection': ['POST', (input, signal) => app.routeSelection(input, signal)],
    refresh: ['POST', (input, signal) => app.refresh(input, signal)],
    kline: ['GET', (input, signal) => app.kline(input, signal)],
  }
  const controllers = new Set(), disposers = []
  let stopped = false
  try {
    for (const [name, [method, action]] of Object.entries(handlers)) {
      // 写方法与读方法统一走共享闸门: 宿主闸门恒过; 写方法再叠同源与 JSON content-type。
      // GET 无写副作用, 只回问宿主闸门。
      const handle = async (req, res) => {
        if (stopped) return json(res, 503, { ok: false, error: { code: 'STOPPED', message: '工具已停止' } })
        if (req.method !== method) { res.setHeader('Allow', method); return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' } }) }
        const controller = new AbortController(); controllers.add(controller)
        const onClose = () => { if (!res.writableEnded) controller.abort() }
        res.on('close', onClose)
        let timer
        try {
          const input = method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://local').searchParams) : await body(req)
          if (method === 'POST' && (input === null || typeof input !== 'object' || Array.isArray(input))) fail('INVALID_REQUEST', '请求内容必须为JSON对象')
          // 应用层没给或给了非数值时退回默认预算: 传进 setTimeout 的必须是有限正数。
          // 取值放进 try: 这里抛错也必须有响应写出, 否则请求悬挂到客户端超时。
          // 探针的预算要按待测目标数算, 所以必须等输入解析完再取
          const derived = name === 'provider-check' ? app.providerCheckTimeoutMs?.(input) : app.routeTimeoutMs?.()
          const timeout = name === 'catalog-sync' ? CATALOG_SYNC_TIMEOUT_MS : Number.isFinite(derived) && derived > 0 ? derived : name === 'provider-check' ? PROVIDER_CHECK_TIMEOUT_MS : DEFAULT_ROUTE_TIMEOUT_MS
          const data = await Promise.race([
            Promise.resolve(action(input, controller.signal)),
            // 超时错误随 abort reason 一起下发: 即使 abort 监听先被同步派发, 也拿到 TIMEOUT 而不是 CANCELLED
            new Promise((_, reject) => { timer = setTimeout(() => { const error = new StockError('TIMEOUT', '操作超时，请稍后重试', 504); controller.abort(error); reject(error) }, timeout) }),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof StockError ? controller.signal.reason : new StockError('CANCELLED', '操作已取消', stopped ? 503 : 504)), { once: true })),
          ])
          json(res, 200, { ok: true, data })
        } catch (e) {
          const error = e instanceof StockError ? e : new StockError('INVALID_REQUEST', e instanceof z.ZodError ? '请求参数格式错误' : '股票工具请求失败', e instanceof z.ZodError ? 400 : 500)
          // 服务端失败必须有痕迹: 只记路由与错误码, 不记文案(文案可能带上游地址与凭据形态)。
          // 客户端关页/切详情触发的取消不是故障, 记成 5xx 只会让日志看起来一直在报错
          if (error.status >= 500 && error.code !== 'CANCELLED') ctx?.logger?.warn?.(`股票助手请求失败: ${name} ${error.code} (${error.status})`)
          json(res, error.status, { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, retryAfterMs: error.retryAfterMs }, ...(error.details === undefined ? {} : { details: error.details }), ...(error.revision === undefined ? {} : { revision: error.revision }), ...(e.snapshot ? { snapshot: e.snapshot } : {}) })
        } finally { clearTimeout(timer); controllers.delete(controller); res.removeListener('close', onClose) }
      }
      disposers.push(webServer.register({ kind: 'exact', path: `${PREFIX}/${name}`, handler: withRouteGate(ctx, handle) }))
    }
  } catch (e) { for (const dispose of disposers.reverse()) dispose(); throw e }
  return () => { stopped = true; for (const dispose of disposers.reverse()) dispose(); for (const c of controllers) c.abort(); controllers.clear() }
}
