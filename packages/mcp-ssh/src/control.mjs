// Control HTTP:DSH 面板的观察与协同通道。仅当 AGENT_SHELL_CONTROL=1 时监听,
// 绑定 127.0.0.1,随机端口,Bearer token 鉴权,{port,token} 写入 HOME/server.json。
// 端点:GET /health /events /session/:id/output、POST /run /kill /approval/:id /session/:id/input /config

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const RING_LIMIT = 500
const TAIL_CHARS = 32 * 1024

export function createControl({ core, homeDir, log }) {
  let server = null
  let port = 0
  const token = randomBytes(24).toString('hex')
  let seq = 0
  const ring = []

  const statePath = join(homeDir, 'server.json')

  async function announce() {
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }))
    log(`control listening on 127.0.0.1:${port}`)
  }

  function emit(event) {
    seq += 1
    // exec 事件裁剪输出尾部,防环内存膨胀(模型仍拿到完整输出,这里只服务面板)
    if (event.kind === 'exec') {
      if (typeof event.stdout === 'string' && event.stdout.length > TAIL_CHARS) {
        event = { ...event, stdout: event.stdout.slice(-TAIL_CHARS), outputTruncated: true }
      }
      if (typeof event.stderr === 'string' && event.stderr.length > TAIL_CHARS) {
        event = { ...event, stderr: event.stderr.slice(-TAIL_CHARS), outputTruncated: true }
      }
    }
    const record = { seq, ts: Date.now(), ...event }
    ring.push(record)
    if (ring.length > RING_LIMIT) ring.shift()
    return record
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    // token 校验:除 health 外全部要求
    if (path !== '/health') {
      const auth = req.headers.authorization || ''
      if (auth !== `Bearer ${token}`) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
    }

    if (req.method === 'GET' && path === '/health') {
      json(res, 200, { ok: true, pid: process.pid, events: seq, sessions: core.tools.sessions.list().length })
      return
    }
    if (req.method === 'GET' && path === '/events') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      json(res, 200, { head: seq, events: ring.filter((event) => event.seq > since) })
      return
    }
    if (req.method === 'POST' && path === '/run') {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (typeof body.command !== 'string' || body.command.length === 0) {
        json(res, 400, { error: 'command required' })
        return
      }
      core.sourceOverride = 'ui'
      try {
        const outcome = await core.tools.call('run', { command: body.command, host: body.host, cwd: body.cwd, timeoutMs: body.timeoutMs })
        json(res, 200, JSON.parse(outcome.content[0].text))
      } finally {
        core.sourceOverride = null
      }
      return
    }
    if (req.method === 'POST' && path === '/kill') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const child = core.registry.get(String(body.id ?? ''))
      if (child === undefined) {
        json(res, 404, { error: 'no such running exec' })
        return
      }
      const { killTree } = await import('./exec.mjs')
      killTree(child)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && /^\/approval\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2])
      const body = JSON.parse((await readBody(req)) || '{}')
      const resolved = core.guard.resolveApproval(id, body.approve === true)
      json(res, resolved ? 200 : 404, { ok: resolved })
      return
    }
    const sessionInput = /^\/session\/([^/]+)\/input$/.exec(path)
    if (req.method === 'POST' && sessionInput) {
      const id = decodeURIComponent(sessionInput[1])
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const describe = core.tools.sessions.send(id, String(body.text ?? ''), { newline: body.newline !== false })
        core.emit({ kind: 'exec', id, command: describe.command, host: describe.host, cwd: null, source: 'user', state: 'input', text: String(body.text ?? '') })
        json(res, 200, describe)
      } catch (error) {
        json(res, 400, { error: String(error.message || error) })
      }
      return
    }
    const sessionOutput = /^\/session\/([^/]+)\/output$/.exec(path)
    if (req.method === 'GET' && sessionOutput) {
      try {
        const since = Number(url.searchParams.get('since') ?? 0) || 0
        json(res, 200, core.tools.sessions.read(decodeURIComponent(sessionOutput[1]), since))
      } catch (error) {
        json(res, 404, { error: String(error.message || error) })
      }
      return
    }
    if (req.method === 'GET' && path === '/sessions') {
      json(res, 200, { sessions: core.tools.sessions.list() })
      return
    }
    if (req.method === 'GET' && path === '/config') {
      const config = core.guard.config()
      json(res, 200, {
        mode: config.mode,
        blacklist: config.blacklist,
        whitelist: config.whitelist,
        approvalMode: config.approvalMode,
        approvalTimeoutMs: config.approvalTimeoutMs,
        broken: [...core.guard.brokenRules().entries()].map(([source, reason]) => ({ source, reason })),
      })
      return
    }
    if (req.method === 'PUT' && path === '/config') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const { writeConfigFile, configPathOf } = await import('./config.mjs')
        const next = await writeConfigFile(configPathOf(process.env), body)
        await core.guard.refresh()
        json(res, 200, next)
      } catch (error) {
        json(res, 400, { error: String(error.message || error) })
      }
      return
    }
    json(res, 404, { error: 'not found' })
  }

  function start() {
    return new Promise((resolvePromise, rejectPromise) => {
      server = createServer((req, res) => {
        handle(req, res).catch((error) => {
          try {
            json(res, 500, { error: String(error.message || error) })
          } catch {}
        })
      })
      server.on('error', rejectPromise)
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        announce().then(resolvePromise, rejectPromise)
      })
    })
  }

  function stop() {
    return new Promise((resolvePromise) => {
      if (server === null) return resolvePromise()
      server.close(() => resolvePromise())
      server.closeAllConnections?.()
      server = null
    })
  }

  return { start, stop, emit, statePath }
}
