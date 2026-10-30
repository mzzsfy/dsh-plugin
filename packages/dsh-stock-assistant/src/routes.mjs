import { z } from 'zod'
import { StockError, fail } from './market-model.mjs'
const PREFIX = '/api/stock-assistant'
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
export function registerRoutes(webServer, app) {
  const handlers = {
    snapshot: ['GET', () => app.snapshot()],
    search: ['GET', async (input, signal) => await app.search(input.q || '', input.phase === 'remote' ? 'remote' : 'local', signal)],
    browse: ['GET', input => app.browse(input)],
    watchlist: ['POST', input => { operationSchema.parse(input); return app.watchlist(input) }],
    preferences: ['POST', input => { operationSchema.parse(input); return app.preferences({ ...input, payload: input.patch }) }],
    configuration: ['POST', input => { operationSchema.parse(input); return app.configuration({ ...input, payload: { providers: input.providers, routes: input.routes } }) }],
    'provider-check': ['POST', (input, signal) => app.providerCheck(input, signal)],
    'catalog-sync': ['POST', input => app.sync(input)],
    'route-selection': ['POST', (input, signal) => app.routeSelection(input, signal)],
    refresh: ['POST', (input, signal) => app.refresh(input, signal)],
  }
  const controllers = new Set(), disposers = []
  let stopped = false
  try {
    for (const [name, [method, action]] of Object.entries(handlers)) disposers.push(webServer.register({ kind: 'exact', path: `${PREFIX}/${name}`, async handler(req, res) {
      if (stopped) return json(res, 503, { ok: false, error: { code: 'STOPPED', message: '工具已停止' } })
      if (req.method !== method) { res.setHeader('Allow', method); return json(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' } }) }
      const controller = new AbortController(); controllers.add(controller)
      const onClose = () => { if (!res.writableEnded) controller.abort() }
      res.on('close', onClose)
      const timeout = name === 'provider-check' ? 60 * 1000 : name === 'catalog-sync' ? 120 * 1000 : 10 * 1000
      let timer
      try {
        const input = method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://local').searchParams) : await body(req)
        if (method === 'POST' && (input === null || typeof input !== 'object' || Array.isArray(input))) fail('INVALID_REQUEST', '请求内容必须为JSON对象')
        if (method === 'POST' && req.headers.origin) {
          let same = false
          try { same = new URL(req.headers.origin).host === req.headers.host } catch {}
          if (!same) fail('CROSS_ORIGIN', '不接受跨源写请求', 403)
        }
        const data = await Promise.race([
          Promise.resolve(action(input, controller.signal)),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new StockError('TIMEOUT', '操作超时，请稍后重试', 504)) }, timeout) }),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new StockError('CANCELLED', '操作已取消', stopped ? 503 : 504)), { once: true })),
        ])
        json(res, 200, { ok: true, data })
      } catch (e) {
        const error = e instanceof StockError ? e : new StockError('INVALID_REQUEST', e instanceof z.ZodError ? '请求参数格式错误' : '股票工具请求失败', e instanceof z.ZodError ? 400 : 500)
        json(res, error.status, { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, retryAfterMs: error.retryAfterMs }, ...(error.revision === undefined ? {} : { revision: error.revision }), ...(e.snapshot ? { snapshot: e.snapshot } : {}) })
      } finally { clearTimeout(timer); controllers.delete(controller); res.removeListener('close', onClose) }
    } }))
  } catch (e) { for (const dispose of disposers.reverse()) dispose(); throw e }
  return () => { stopped = true; for (const dispose of disposers.reverse()) dispose(); for (const c of controllers) c.abort(); controllers.clear() }
}
