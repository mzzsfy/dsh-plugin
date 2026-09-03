// BDD: 最小 MCP stdio 客户端 × 真实 @mzzsfy/mcp-ssh server 进程
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// server 入口 = 包内 bin(server.mjs 只导出不自动执行)
function serverBinPath() {
  const pkgUrl = fileURLToPath(import.meta.resolve('@mzzsfy/mcp-ssh/package.json'))
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'))
  return join(dirname(pkgUrl), pkg.bin['mcp-ssh'])
}

function startServerProcess(env = {}) {
  const child = spawn(process.execPath, [serverBinPath()], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return child
}

test('握手 + tools/list:发现 9 个工具', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-shell-'))
  const child = startServerProcess({ AGENT_SHELL_HOME: home })
  const { createMcpClient } = await import('../src/mcp-client.mjs')
  const client = createMcpClient({ input: child.stdout, output: child.stdin })
  try {
    await client.initialize()
    const list = await client.listTools()
    assert.equal(list.tools.length, 9)
    assert.equal(list.tools[0].name, 'run')
  } finally {
    client.dispose()
    child.kill()
  }
})

test('tools/call run:执行命令并取回结构化结果', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-shell-'))
  const child = startServerProcess({ AGENT_SHELL_HOME: home })
  const { createMcpClient } = await import('../src/mcp-client.mjs')
  const client = createMcpClient({ input: child.stdout, output: child.stdin })
  try {
    await client.initialize()
    const result = await client.callTool('run', { command: 'node -e "console.log(42)"' })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.exitCode, 0)
    assert.match(payload.stdout, /42/)
  } finally {
    client.dispose()
    child.kill()
  }
})

test('server 退出后请求被拒(closed 感知)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-shell-'))
  const child = startServerProcess({ AGENT_SHELL_HOME: home })
  const { createMcpClient } = await import('../src/mcp-client.mjs')
  const client = createMcpClient({ input: child.stdout, output: child.stdin })
  await client.initialize()
  child.kill()
  await client.whenClosed()
  await assert.rejects(() => client.callTool('run', { command: 'echo x' }), /关闭|退出/)
  client.dispose()
})
