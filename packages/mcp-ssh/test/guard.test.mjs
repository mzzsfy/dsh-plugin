// BDD: 黑白名单与审批流(control 开启时挂起等批准;关闭时 deny 直拒)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, textOf } from './helpers.mjs'

async function tempHome(config) {
  const dir = await mkdtempSync(join(tmpdir(), 'agent-shell-guard-'))
  if (config !== undefined) await writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  return dir
}

async function controlState(home) {
  return JSON.parse(await readFile(join(home, 'server.json'), 'utf8'))
}

async function fetchEvents(state, since = 0) {
  const response = await fetch(`http://127.0.0.1:${state.port}/events?since=${since}`, {
    headers: { authorization: `Bearer ${state.token}` },
  })
  return (await response.json()).events
}

async function waitEvent(state, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let since = 0
  while (Date.now() < deadline) {
    const events = await fetchEvents(state, since)
    const hit = events.find(predicate)
    if (hit) return hit
    if (events.length > 0) since = events[events.length - 1].seq
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('timeout waiting event')
}

test('黑名单命中 + 无 control:直接拒绝且不执行', async () => {
  const home = await tempHome({ blacklist: ['forbidden-marker'] })
  const server = startServer({ AGENT_SHELL_HOME: home })
  try {
    await server.initialize()
    const response = await server.callTool('run', { command: 'echo forbidden-marker' })
    assert.equal(response.result.isError, true)
    const payload = textOf(response)
    assert.match(payload.error, /护栏拦截/)
  } finally {
    await server.stop()
  }
})

test('白名单模式:未命中白名单拒绝,命中放行', async () => {
  const home = await tempHome({ mode: 'whitelist', whitelist: ['^echo allowed'] })
  const server = startServer({ AGENT_SHELL_HOME: home })
  try {
    await server.initialize()
    const denied = textOf(await server.callTool('run', { command: 'echo nope' }))
    assert.match(denied.error, /护栏拦截/)
    const allowed = textOf(await server.callTool('run', { command: 'echo allowed-now' }))
    assert.equal(allowed.exitCode, 0)
  } finally {
    await server.stop()
  }
})

test('审批批准流:pending → 批准 → 执行成功', async () => {
  const home = await tempHome({ blacklist: ['guarded-cmd'] })
  const server = startServer({ AGENT_SHELL_HOME: home, AGENT_SHELL_CONTROL: '1' })
  try {
    await server.initialize()
    const state = await controlState(home)
    const headers = { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }

    const callPromise = server.callTool('run', { command: 'echo guarded-cmd-ok' })
    const approval = await waitEvent(state, (event) => event.kind === 'approval' && event.state === 'pending')
    assert.match(approval.command, /guarded-cmd-ok/)
    const approve = await fetch(`http://127.0.0.1:${state.port}/approval/${approval.id}`, {
      method: 'POST', headers, body: JSON.stringify({ approve: true }),
    })
    assert.equal(approve.status, 200)
    const payload = textOf(await callPromise)
    assert.equal(payload.exitCode, 0)
    assert.match(payload.stdout, /guarded-cmd-ok/)

    const events = await fetchEvents(state)
    assert.equal(events.some((event) => event.kind === 'approval' && event.state === 'approved'), true)
  } finally {
    await server.stop()
  }
})

test('审批拒绝流:拒绝后 isError 且不执行', async () => {
  const home = await tempHome({ blacklist: ['guarded-cmd'] })
  const server = startServer({ AGENT_SHELL_HOME: home, AGENT_SHELL_CONTROL: '1' })
  try {
    await server.initialize()
    const state = await controlState(home)
    const headers = { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }

    const callPromise = server.callTool('run', { command: 'echo guarded-cmd-no' })
    const approval = await waitEvent(state, (event) => event.kind === 'approval' && event.state === 'pending')
    await fetch(`http://127.0.0.1:${state.port}/approval/${approval.id}`, {
      method: 'POST', headers, body: JSON.stringify({ approve: false }),
    })
    const payload = textOf(await callPromise)
    assert.match(payload.error, /拒绝/)
    const events = await fetchEvents(state)
    assert.equal(events.some((event) => event.kind === 'exec' && event.state === 'running' && /guarded-cmd-no/.test(event.command)), false)
  } finally {
    await server.stop()
  }
})

test('内置默认黑名单:rm -rf / 被拦(无 control 直拒)', async () => {
  const home = await tempHome()
  const server = startServer({ AGENT_SHELL_HOME: home })
  try {
    await server.initialize()
    const payload = textOf(await server.callTool('run', { command: 'rm -rf /' }))
    assert.match(payload.error, /护栏|拦截/)
  } finally {
    await server.stop()
  }
})

test('config 热加载:运行中改黑名单即生效', async () => {
  // deny 模式:命中即直拒,避免 control 开启时挂起等审批拖死测试
  const home = await tempHome({ blacklist: [], approvalMode: 'deny' })
  const server = startServer({ AGENT_SHELL_HOME: home, AGENT_SHELL_CONTROL: '1' })
  try {
    await server.initialize()
    const before = textOf(await server.callTool('run', { command: 'echo hot-reload-probe' }))
    assert.equal(before.exitCode, 0)
    await writeFileSync(join(home, 'config.json'), JSON.stringify({ blacklist: ['hot-reload-probe'], approvalMode: 'deny' }))
    // 等待 mtime 变化窗口
    await new Promise((resolve) => setTimeout(resolve, 2100))
    const after = textOf(await server.callTool('run', { command: 'echo hot-reload-probe' }))
    assert.match(after.error, /护栏拦截/)
  } finally {
    await server.stop()
  }
})
