// BDD: 端到端集成 —— host 半区 startServer 等价链路(spawn bin → 桥接 → 代理)
// 用与 index.js 相同的 serverEntryPath 逻辑拉起,验证 control 状态文件与事件流可读。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function serverBinPath() {
  const pkgUrl = fileURLToPath(import.meta.resolve('@mzzsfy/mcp-ssh/package.json'))
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'))
  return join(dirname(pkgUrl), pkg.bin['mcp-ssh'])
}

test('control 通道开启:状态文件生成,事件流可拉取', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-shell-e2e-'))
  const child = spawn(process.execPath, [serverBinPath()], {
    env: { ...process.env, AGENT_SHELL_CONTROL: '1', AGENT_SHELL_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.on('error', (error) => console.error('spawn error:', error))
  try {
    // 等 server.json(与 index.js waitStateFile 同策略)
    const statePath = join(home, 'server.json')
    const deadline = Date.now() + 15000
    while (!existsSync(statePath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(existsSync(statePath), true)
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(typeof state.port, 'number')
    assert.match(state.token, /^[0-9a-f]+$/)

    const health = await fetch(`http://127.0.0.1:${state.port}/health`).then((r) => r.json())
    assert.equal(health.ok, true)

    const events = await fetch(`http://127.0.0.1:${state.port}/events?since=0`, {
      headers: { authorization: `Bearer ${state.token}` },
    }).then((r) => r.json())
    assert.equal(Array.isArray(events.events), true)
    // 无鉴权访问受保护端点被拒
    const guarded = await fetch(`http://127.0.0.1:${state.port}/config`)
    assert.equal(guarded.status, 401)
  } finally {
    child.kill()
  }
})
