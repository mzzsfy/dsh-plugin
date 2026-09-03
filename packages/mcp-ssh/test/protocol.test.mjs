// BDD: MCP 协议回环(spawn 真进程)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, textOf } from './helpers.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'agent-shell-test-'))
}

test('握手 + tools/list 返回 9 个工具', async () => {
  const server = startServer({ AGENT_SHELL_HOME: tempHome() })
  try {
    const init = await server.initialize()
    assert.equal(init.result.serverInfo.name, 'agent-shell')
    const list = await server.listTools()
    const names = list.result.tools.map((tool) => tool.name)
    assert.deepEqual(names, ['run', 'start', 'read', 'send', 'kill', 'listHosts', 'checkHost', 'upload', 'download'])
  } finally {
    await server.stop()
  }
})

test('run 执行本机命令并返回退出码与输出', async () => {
  const server = startServer({ AGENT_SHELL_HOME: tempHome() })
  try {
    await server.initialize()
    const response = await server.callTool('run', { command: 'node -e "console.log(123)"' })
    assert.equal(response.result.isError, undefined)
    const payload = textOf(response)
    assert.equal(payload.exitCode, 0)
    assert.match(payload.stdout, /123/)
    assert.equal(payload.host, null)
  } finally {
    await server.stop()
  }
})

test('run 非零退出返回 isError 且带输出', async () => {
  const server = startServer({ AGENT_SHELL_HOME: tempHome() })
  try {
    await server.initialize()
    const response = await server.callTool('run', { command: `node -e "console.error('boom'); process.exit(3)"` })
    assert.equal(response.result.isError, true)
    const payload = textOf(response)
    assert.equal(payload.exitCode, 3)
    assert.match(payload.stderr, /boom/)
  } finally {
    await server.stop()
  }
})

test('run 超时杀进程并标记 timedOut', async () => {
  const server = startServer({ AGENT_SHELL_HOME: tempHome() })
  try {
    await server.initialize()
    const response = await server.callTool('run', { command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 800 })
    const payload = textOf(response)
    assert.equal(response.result.isError, true)
    assert.equal(payload.timedOut, true)
    assert.equal(payload.exitCode, null)
  } finally {
    await server.stop()
  }
})

test('start/read/send 交互会话回路', async () => {
  const server = startServer({ AGENT_SHELL_HOME: tempHome() })
  try {
    await server.initialize()
    const started = textOf(await server.callTool('start', { command: `node -e "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',(l)=>console.log('got:'+l))"` }))
    assert.equal(started.running, true)
    // 等进程就绪
    await new Promise((resolve) => setTimeout(resolve, 600))
    await server.callTool('send', { sessionId: started.sessionId, text: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const read = textOf(await server.callTool('read', { sessionId: started.sessionId }))
    assert.match(read.output, /got:hello/)
    assert.equal(read.cursor > 0, true)
    const killed = textOf(await server.callTool('kill', { sessionId: started.sessionId }))
    assert.notEqual(killed.running, true)
  } finally {
    await server.stop()
  }
})
