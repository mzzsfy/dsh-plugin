// BDD: /agent-shell 路由分发(打桩 webServer 契约 + control 通道)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRoutes } from '../src/routes.mjs'

// 起一个假 control server,验证代理转发与鉴权头
async function startFakeControl() {
  const token = randomBytes(8).toString('hex')
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, url: req.url }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    token, seen, port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

function makeDeps({ control, pageHtml = '<html>page</html>' }) {
  const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
  const state = { control: { port: control.port, token: control.token }, client: {}, registered: [], lastError: '' }
  const route = createRoutes({
    sendJson,
    readBody,
    rejectCrossOrigin: (req, res) => {
      const origin = req.headers.origin
      if (!origin) return false
      sendJson(res, 403, { error: 'cross-origin' })
      return true
    },
    pageHtml: () => pageHtml,
    controlFetch: async (pathname, { method = 'GET', body } = {}) => {
      const response = await fetch(`http://127.0.0.1:${control.port}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${control.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      return { status: response.status, payload: await response.json() }
    },
    serverState: state,
  })
  return { route, state }
}

function dispatch(route, method, path, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url: path, headers: headers || {} }
    req.on = (event, listener) => {
      // 模拟流:body 到达一次后 end;data 事件只在有 body 时触发一次
      if (event === 'data') {
        if (body) listener(Buffer.from(body))
        return req
      }
      if (event === 'end') setImmediate(listener)
      return req
    }
    const res = {
      writeHead(status) { this.status = status },
      end(payload) { resolve({ status: this.status, body: payload }) },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

test('GET /agent-shell 返回页面', async () => {
  const control = await startFakeControl()
  try {
    const { route } = makeDeps({ control })
    const response = await dispatch(route, 'GET', '/agent-shell')
    assert.equal(response.status, 200)
    assert.match(String(response.body), /<html/)
  } finally {
    await control.close()
  }
})

test('GET /api/events 代理到 control 且带 token', async () => {
  const control = await startFakeControl()
  try {
    const { route } = makeDeps({ control })
    const response = await dispatch(route, 'GET', '/agent-shell/api/events?since=7')
    assert.equal(response.status, 200)
    const seen = control.seen[0]
    assert.equal(seen.url, '/events?since=7')
    assert.equal(seen.auth, `Bearer ${control.token}`)
  } finally {
    await control.close()
  }
})

test('写请求带跨域 Origin 被拒', async () => {
  const control = await startFakeControl()
  try {
    const { route } = makeDeps({ control })
    const response = await dispatch(route, 'POST', '/agent-shell/api/run', { headers: { origin: 'http://evil.example' }, body: '{}' })
    assert.equal(response.status, 403)
    assert.equal(control.seen.length, 0)
  } finally {
    await control.close()
  }
})

test('POST /api/approval/:id 正确转写路径', async () => {
  const control = await startFakeControl()
  try {
    const { route } = makeDeps({ control })
    await dispatch(route, 'POST', '/agent-shell/api/approval/ap-1-x', { body: '{"approve":true}' })
    assert.equal(control.seen[0].url, '/approval/ap-1-x')
  } finally {
    await control.close()
  }
})

test('session output 路径转写', async () => {
  const control = await startFakeControl()
  try {
    const { route } = makeDeps({ control })
    await dispatch(route, 'GET', '/agent-shell/api/session/s-1-a/output?since=3')
    assert.equal(control.seen[0].url, '/session/s-1-a/output?since=3')
  } finally {
    await control.close()
  }
})
