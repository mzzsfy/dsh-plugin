// /agent-shell 路由:GET 页面、/api/* 代理到 control 通道。写操作同源校验。

export function createRoutes({ sendJson, readBody, rejectCrossOrigin, pageHtml, controlFetch, serverState }) {
  async function proxy(res, pathname, options) {
    try {
      const { status, payload } = await controlFetch(pathname, options)
      sendJson(res, status, payload)
    } catch (error) {
      sendJson(res, 502, { error: `agent-shell server 不可达: ${String(error?.message || error)}` })
    }
  }

  return {
    kind: 'prefix',
    path: '/agent-shell',
    async handler(req, res) {
      const url = new URL(req.url, 'http://local')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && (path === '/agent-shell' || path === '/agent-shell/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(await pageHtml())
        return
      }
      if (path === '/agent-shell/api/state') {
        const ready = serverState.control !== null && serverState.control !== undefined && serverState.client !== null
        sendJson(res, 200, { ready, lastError: serverState.lastError, tools: serverState.registered.length })
        return
      }
      if (method === 'GET' && path === '/agent-shell/api/events') {
        await proxy(res, `/events?since=${encodeURIComponent(url.searchParams.get('since') ?? '0')}`)
        return
      }
      if (method === 'GET' && path === '/agent-shell/api/sessions') {
        await proxy(res, '/sessions')
        return
      }
      if (method === 'GET' && path === '/agent-shell/api/config') {
        await proxy(res, '/config')
        return
      }
      if (method === 'GET' && /^\/agent-shell\/api\/session\/[^/]+\/output$/.test(path)) {
        const id = encodeURIComponent(path.split('/')[4])
        await proxy(res, `/session/${id}/output?since=${encodeURIComponent(url.searchParams.get('since') ?? '0')}`)
        return
      }
      if (method !== 'POST' && method !== 'PUT') {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      if (rejectCrossOrigin(req, res)) return
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        sendJson(res, 400, { error: 'invalid json body' })
        return
      }
      if (method === 'POST' && path === '/agent-shell/api/run') {
        await proxy(res, '/run', { method: 'POST', body, timeoutMs: 35 * 60 * 1000 })
        return
      }
      if (method === 'POST' && path === '/agent-shell/api/kill') {
        await proxy(res, '/kill', { method: 'POST', body })
        return
      }
      if (method === 'POST' && /^\/agent-shell\/api\/approval\/[^/]+$/.test(path)) {
        const id = encodeURIComponent(path.split('/')[4])
        await proxy(res, `/approval/${id}`, { method: 'POST', body })
        return
      }
      if (method === 'POST' && /^\/agent-shell\/api\/session\/[^/]+\/input$/.test(path)) {
        const id = encodeURIComponent(path.split('/')[4])
        await proxy(res, `/session/${id}/input`, { method: 'POST', body })
        return
      }
      if (method === 'PUT' && path === '/agent-shell/api/config') {
        await proxy(res, '/config', { method: 'PUT', body })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    },
  }
}
