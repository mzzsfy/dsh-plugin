import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const TIMEOUT_MS = 3 * 1000
export async function until(predicate, label = '等待状态超时') {
  const deadline = Date.now() + TIMEOUT_MS
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function fixture(t) {
  delete globalThis.__dshCommonTools
  const routes = new Map(), upgrades = new Map(), sockets = new Set(), contexts = []
  let total = 0, peak = 0
  const server = http.createServer((req, res) => {
    const handler = routes.get(req.url)?.handler
    if (handler) handler(req, res)
    else { res.writeHead(req.url === '/snapshot' ? 200 : 404); res.end('snapshot') }
  })
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(req.url)
    if (!route) { socket.destroy(); return }
    total++
    sockets.add(socket)
    peak = Math.max(peak, sockets.size)
    socket.on('close', () => sockets.delete(socket))
    route.handler(req, socket, head)
  })
  const clients = new Set()
  t.after(async () => {
    for (const client of clients) client.close()
    for (const ctx of contexts) ctx.dispose()
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    delete globalThis.__dshCommonTools
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const context = (name = '@mzzsfy/a') => {
    const cleanups = []
    const register = table => route => {
      assert.equal(table.has(route.path), false)
      table.set(route.path, route)
      return () => table.delete(route.path)
    }
    const ctx = {
      fiber: { entry: { options: { name } } },
      webServer: { exact: routes, upgrades, register: register(routes), registerUpgrade: register(upgrades) },
      effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
      dispose() { while (cleanups.length) cleanups.pop()() },
    }
    contexts.push(ctx)
    return ctx
  }
  const window = { location: { href: base }, __ModuleLoader__: { load: mod => { window.mod = mod } } }
  class BrowserSocket extends WebSocket {
    constructor(url) { super(url); clients.add(this) }
  }
  const load = () => {
    new Function('window', 'document', 'WebSocket', source)(window, {}, BrowserSocket)
    return window.mod.factory(() => ({}))
  }
  return { context, load, base, sockets, upgrades, routes, stats: () => ({ total, peak }) }
}
