// 手动链路验证:官方 PiAiAdapter → gateway → 宿主 pi-ai → 独立 echo-upstream。
// node scripts/compat/affinity-probe-3proto.mjs --host-dir <隔离 dsh-host>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMarkerInject, sweepRegisteredAdapters } from '../../packages/dsh-llm-pi-gateway/src/decorator.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TIMEOUT_MS = 30 * 1000
const SESSION_A = 'session-affinity-probe-a'
const SESSION_B = 'session-affinity-probe-b'
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const args = process.argv.slice(2)
assert.equal(args.length, 2, '参数: --host-dir <隔离 dsh-host>')
assert.equal(args[0], '--host-dir')
const hostDir = realpathSync(resolve(args[1]))
const hostManifestPath = realpathSync(join(hostDir, 'node_modules/@deepseek-ai/dsh/package.json'))
const hostManifest = JSON.parse(readFileSync(hostManifestPath, 'utf8'))
assert.equal(hostManifest.name, '@deepseek-ai/dsh', '--host-dir 必须安装 DSH 宿主')
const hostVersion = hostManifest.version
const within = (root, target) => {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}
const hostRequire = createRequire(hostManifestPath)
const adapterPath = hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')
const closureRoots = [hostDir, dirname(hostManifestPath)]
assert.ok(closureRoots.some((root) => within(root, adapterPath)), 'adapter 解析越出指定宿主闭包')
const piRequire = createRequire(adapterPath)
const piRoot = piRequire.resolve.paths('@earendil-works/pi-ai')
  .map((base) => join(base, '@earendil-works/pi-ai'))
  .find((base) => existsSync(join(base, 'package.json')))
assert.ok(piRoot, '隔离宿主缺 pi-ai 依赖')
const piRealRoot = realpathSync(piRoot)
closureRoots.push(resolve(dirname(adapterPath), '..'))
assert.ok(closureRoots.some((root) => within(root, piRealRoot)), 'pi-ai 解析越出指定宿主闭包')
const piVersion = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).version
const { PiAiAdapter } = await import(pathToFileURL(adapterPath).href)
const workDir = mkdtempSync(join(tmpdir(), 'dsh-gateway-affinity-'))
const logPath = join(workDir, 'llm-echo.jsonl')
const simulator = spawn(process.execPath, [join(REPO_ROOT, 'scripts/echo-upstream/cli.mjs'), '--port', '0', '--log', logPath], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const exited = once(simulator, 'close')
let interrupted = false
const interrupt = () => { interrupted = true; simulator.kill() }
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
let simulatorStderr = ''
let report
simulator.stderr.on('data', (chunk) => { simulatorStderr += chunk })
console.log(`EVIDENCE ${workDir} simulatorPid=${simulator.pid} pi-ai=${piVersion}`)

try {
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('echo-upstream 启动超时')), TIMEOUT_MS)
    let stdout = ''
    simulator.stdout.on('data', (chunk) => {
      stdout += chunk
      const match = stdout.match(/listening 127\.0\.0\.1:(\d+)/)
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
    })
    simulator.once('error', (error) => { clearTimeout(timer); reject(error) })
    simulator.once('exit', (code) => { clearTimeout(timer); reject(new Error(`echo-upstream 退出 ${code}: ${simulatorStderr}`)) })
  })
  const profiles = new Map()
  for (const api of APIS) {
    const { stream, streamSimple } = await import(pathToFileURL(join(piRoot, 'dist/api', `${api}.js`)).href)
    const provider = `affinity-${api}`
    const model = {
      id: 'echo-model', name: 'Echo', provider, api,
      baseUrl: `http://127.0.0.1:${port}${api === 'anthropic-messages' ? '' : '/v1'}`,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64 * 1024, maxTokens: 4 * 1024,
    }
    profiles.set(provider, {
      modelErrors: new Map(), configuredMaxTokens: new Map(), cacheRetention: 'short', streamIdleTimeoutMs: TIMEOUT_MS,
      piProvider: {
        id: provider, name: provider, baseUrl: model.baseUrl,
        auth: { apiKey: { name: 'Echo fixture', resolve: async () => ({ auth: { apiKey: 'echo-test-key' } }) } },
        getModels: () => [model], stream, streamSimple,
      },
    })
  }
  let enabled = true
  let active = true
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'echo-test-key' })
  const llm = {
    adapters: new Map([...profiles.keys()].map((provider) => [provider, { provider: { id: provider }, adapter }])),
    directory: new Map([...profiles.keys()].map((provider) => [provider, { provider, settingsNs: 'llm-pi-ai' }])),
  }
  assert.equal(sweepRegisteredAdapters(llm, createMarkerInject(() => ({ enabled, prefix: 'dsh' })), () => active), APIS.length)
  const results = []
  const readEntries = () => readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  async function request(api, sessionId, label) {
    const provider = `affinity-${api}`
    let finish
    let text = ''
    for await (const chunk of adapter.stream({
      provider, model: 'echo-model', sessionId, signal: AbortSignal.timeout(TIMEOUT_MS),
      messages: [{ role: 'user', content: [{ type: 'text', text: label }] }],
    })) {
      if (chunk.type === 'finish') finish = chunk.reason
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text = chunk.block.text
    }
    assert.equal(finish?.kind, 'stop', `${label}: ${JSON.stringify(finish)}`)
    assert.ok(text.includes('echo-upstream-fixed'), `${label}: 回复正文缺失`)
    const entries = readEntries()
    assert.equal(entries.length, results.length + 1, `${label}: 请求数量不一致`)
    const entry = entries.at(-1)
    const expectedPath = api === 'anthropic-messages' ? '/v1/messages?beta=true' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions'
    assert.equal(entry.path, expectedPath, `${label}: 实际请求路径`)
    assert.equal(entry.body.stream, true)
    const keys = {
      session_id: entry.headers.session_id,
      'x-client-request-id': entry.headers['x-client-request-id'],
      prompt_cache_key: entry.body.prompt_cache_key,
      user_id: entry.body.metadata?.user_id,
    }
    results.push({ label, api, sessionId, keys })
    return { entry, keys }
  }
  for (const api of APIS) {
    const rounds = []
    for (const [index, sessionId] of [SESSION_A, SESSION_A, SESSION_B].entries()) {
      rounds.push(await request(api, sessionId, `${api}-round-${index}`))
      const { entry, keys } = rounds.at(-1)
      if (api === 'anthropic-messages') {
        assert.match(keys.user_id, /^dsh:[0-9a-f]{40}$/)
      } else {
        assert.equal(keys.session_id, sessionId)
        assert.equal(keys['x-client-request-id'], sessionId)
        assert.equal(entry.body.metadata, undefined)
        if (api === 'openai-responses') assert.equal(keys.prompt_cache_key, sessionId)
        else {
          assert.equal(keys.prompt_cache_key, undefined)
          assert.equal(entry.body.prompt_cache_retention, undefined)
          assert.equal(entry.headers['x-session-affinity'], undefined)
        }
      }
    }
    assert.deepEqual(rounds[0].keys, rounds[1].keys, `${api}: 同会话多轮稳定`)
    assert.notDeepEqual(rounds[0].keys, rounds[2].keys, `${api}: 新会话隔离`)
  }
  enabled = false
  for (const api of APIS) {
    const { keys } = await request(api, SESSION_A, `${api}-disabled`)
    if (api === 'openai-responses') {
      assert.equal(keys.session_id, SESSION_A)
      assert.equal(keys['x-client-request-id'], SESSION_A)
      assert.equal(keys.prompt_cache_key, SESSION_A)
    } else assert.deepEqual(keys, { session_id: undefined, 'x-client-request-id': undefined, prompt_cache_key: undefined, user_id: undefined })
  }
  enabled = true
  for (const api of ['openai-completions', 'openai-responses']) {
    profiles.get(`affinity-${api}`).cacheRetention = 'none'
    const { keys } = await request(api, SESSION_A, `${api}-retention-none`)
    assert.equal(keys.session_id, undefined)
    assert.equal(keys['x-client-request-id'], undefined)
    assert.equal(keys.prompt_cache_key, undefined)
    profiles.get(`affinity-${api}`).cacheRetention = 'short'
  }
  const chatProfile = profiles.get('affinity-openai-completions')
  chatProfile.headers = { Session_ID: 'explicit-session', 'X-Client-Request-Id': 'explicit-request' }
  const explicit = await request('openai-completions', SESSION_A, 'chat-explicit-headers')
  assert.equal(explicit.keys.session_id, 'explicit-session')
  assert.equal(explicit.keys['x-client-request-id'], 'explicit-request')
  chatProfile.headers = undefined
  active = false
  const disposed = await request('openai-completions', SESSION_A, 'chat-disposed')
  assert.equal(disposed.keys.session_id, undefined)
  assert.equal(disposed.keys['x-client-request-id'], undefined)
  report = { ok: true, hostDir, hostVersion, piVersion, piRoot: piRealRoot, adapterPath, simulatorPid: simulator.pid, port, logPath, results }
} finally {
  let timer
  try {
    simulator.kill()
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          simulator.kill('SIGKILL')
          reject(new Error(`模拟器 ${simulator.pid} 清理超时`))
        }, 5 * 1000)
      }),
    ])
    assert.notEqual(simulator.exitCode ?? simulator.signalCode, null, '模拟器未退出')
    console.log(`CLEANUP simulatorPid=${simulator.pid} exited; evidence=${workDir}`)
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}
assert.equal(interrupted, false, '探针已取消')
writeFileSync(join(workDir, 'result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
