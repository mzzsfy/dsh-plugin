// 单版本端到端兼容性验证(docs/兼容性测试/测试与隔离方法.md 逐包标准流程的自动化):
// 宿主安装 → 隔离 profile → 杀旧进程 → boot(等就绪 + 取 token)→ HTTP 冒烟 →
// activation live + diagnostics findings 0 → 浏览器渲染探针 → 进程收尾。
// 判定门槛两档:缺省 = 完全适配(正常访问 + activation live + diagnostics findings 0 +
// 页面渲染工作区文案且无 Failed to load plugins + LLM 链路 + 无行级加载失败);
// --crash-only = 不崩溃(正常访问 + 页面渲染且无 Failed to load plugins +
// 无行级加载失败,跳过模拟器/activation/LLM——窗口基线槽口径)。
// 用法:node scripts/compat/run.mjs --version <v> [--port N] [--host-dir PATH] [--work-root PATH] [--skip-externals] [--crash-only]
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, lstatSync, writeFileSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { COMPAT_ROOT, DSH_PACKAGE, CORDIS_GROUP_PIN, DEFAULT_PORT, REPO_ROOT, workspaceYaml, runCmd, killPortOwner, symlinkDir, log } from './lib.mjs'
import { buildProfile, installPackageExternals, enumeratePackages } from './profile.mjs'
import { isSemver } from './window.mjs'

const BOOT_TIMEOUT_MS = 150 * 1000
const BOOT_SETTLE_MS = 8 * 1000
const READY_POLL_MS = 1.5 * 1000
const ACTIVATION_POLL_MS = 5 * 1000
// 隔离宿主冷启动 web 前端就绪可达 2 分钟级,窗口须覆盖其后的接口就绪
const ACTIVATION_POLL_MAX = 40
const FETCH_TIMEOUT_MS = 10 * 1000
const KILL_GRACE_MS = 2 * 1000
// 根桥内与宿主版本耦合的解析面:运行期重指宿主闭包同版本,对齐生产
// healProfileModuleFallback 形态(插件 import 与宿主同源),结束后还原
const BRIDGE_PACKAGES = [
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  'zod',
]

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, workRoot: COMPAT_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const map = {
      '--version': () => { args.version = argv[++i] },
      '--port': () => { args.port = Number(argv[++i]) },
      '--host-dir': () => { args.hostDir = argv[++i] },
      '--work-root': () => { args.workRoot = argv[++i] },
      '--skip-externals': () => { args.skipExternals = true },
      '--crash-only': () => { args.crashOnly = true },
      '--seed-gateway': () => { args.seedGateway = true },
      '--only': () => {
        const short = argv[++i]
        if (!short) throw new Error('--only 缺包名')
        args.only = [...(args.only ?? []), ...short.split(',').map((s) => s.trim()).filter(Boolean)]
      },
      '--keep': () => { args.keep = true },
    }
    const handler = map[argv[i]]
    if (!handler) throw new Error(`未知参数: ${argv[i]}`)
    handler()
  }
  if (!args.version) throw new Error('缺少 --version')
  if (args.keep === true && args.crashOnly === true) throw new Error('--keep 与 --crash-only 互斥(keep 依赖 LLM 模拟器)')
  if (!isSemver(args.version)) throw new Error(`非法版本号: ${args.version}`)
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error(`--port 非法: ${args.port}`)
  // spawn 会切换 cwd,路径参数必须先定死为绝对
  args.workRoot = resolve(args.workRoot)
  if (args.hostDir) args.hostDir = resolve(args.hostDir)
  return args
}

// 根桥重指:dst 原位暂存为 .compat-bak;中途失败自动还原已重指部分。
// 每次形态变迁落审计日志:桥包消失事故定位需要确切的变迁时刻与前后形态
function repointBridgeFromHost(hostDir) {
  const backups = []
  const shape = (p) => {
    if (!existsSync(p)) return 'absent'
    const st = lstatSync(p)
    return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'other'
  }
  const audit = (phase, name, dst, backup) => log(
    `[bridge] ${phase} ${name}: dst=${shape(dst)} bak=${shape(backup)}`,
  )
  const restore = () => {
    for (const { dst, backup } of backups) {
      rmSync(dst, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, dst)
      audit('restore', basename(dst), dst, backup)
    }
  }
  try {
    for (const name of BRIDGE_PACKAGES) {
      const src = join(hostDir, 'node_modules', name)
      const dst = join(REPO_ROOT, 'node_modules', name)
      if (!existsSync(src)) continue
      const backup = `${dst}.compat-bak`
      audit('repoint-before', name, dst, backup)
      // 上次运行异常退出未还原(bak 残留):先恢复原桥,防止本次误删原件
      if (existsSync(backup)) {
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
        renameSync(backup, dst)
      }
      if (existsSync(dst)) renameSync(dst, backup)
      symlinkDir(src, dst)
      backups.push({ dst, backup })
      audit('repoint-after', name, dst, backup)
    }
  } catch (error) {
    restore()
    throw error
  }
  return restore
}

// 端口可绑定探测:可绑定 = 无监听者
function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

// 进程树终止:宿主可能派生子进程,只杀直接子进程会残留(POSIX 需 detached 使子进程为组长)。
// 收尾函数自身不允许抛,失败路径的清理次序依赖它
function killTree(child, { force = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      const signal = force ? 'SIGKILL' : 'SIGTERM'
      try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
    }
  } catch { /* 尽力而为,端口兜底清理在后 */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

async function waitBootReady(base, child, bootLogPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`宿主进程提前退出(码 ${child.exitCode ?? child.signalCode})\n${logTail(bootLogPath)}`)
    }
    try {
      const res = await fetchWithTimeout(base)
      if (res) return res.status
    } catch { /* 未就绪,继续轮询 */ }
    await sleep(READY_POLL_MS)
  }
  throw new Error(`boot 超时(${BOOT_TIMEOUT_MS / 1000}s 未监听)\n${logTail(bootLogPath)}`)
}

// token 行与前端路由就绪都可能晚于端口监听(重闭包如 pi-gateway 冷载可达分钟级):
// 与 waitBootReady 同款轮询,token 就绪以 boot.log 出现为准
async function waitToken(child, bootLogPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`宿主进程提前退出(码 ${child.exitCode ?? child.signalCode})\n${logTail(bootLogPath)}`)
    }
    const token = extractToken(bootLogPath)
    if (token) return token
    await sleep(READY_POLL_MS)
  }
  throw new Error(`token 未在 ${BOOT_TIMEOUT_MS / 1000}s 内出现\n${logTail(bootLogPath)}`)
}

function logTail(path, lines = 40) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch { return '(无日志)' }
}

function extractToken(bootLogPath) {
  const text = readFileSync(bootLogPath, 'utf8')
  const matches = [...text.matchAll(/token=([A-Za-z0-9_-]{8,})/g)]
  return matches.at(-1)?.[1] ?? ''
}

// activation 全 live 且 findings 0 才提前返回;live 后短暂 findings>0 视为热载瞬态,
// 继续轮询让其沉降,耗尽轮次仍不满足即按当前终态返回(快照落盘可查),由判定端处置。
// 未就绪(404/激活中)同样重试至多轮上限
async function checkActivation(base, token, bundleNames, workDir) {
  const url = `${base}/dsh-market/installed?token=${token}`
  const options = { headers: { Origin: base, Referer: `${base}/` } }
  let lastRaw = ''
  let lastSeen = null
  for (let attempt = 1; attempt <= ACTIVATION_POLL_MAX; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options)
      lastRaw = await res.text()
      const data = JSON.parse(lastRaw)
      const activation = data.activation
      if (activation) {
        const findings = data.diagnostics?.findings ?? []
        const notLive = bundleNames.filter((name) => activation[name]?.state !== 'live')
        lastSeen = {
          liveAll: notLive.length === 0,
          notLive,
          findingsCount: findings.length,
          findingsSample: findings.slice(0, 5),
          apiShape: Object.keys(data),
        }
        if (lastSeen.liveAll && lastSeen.findingsCount === 0) {
          writeFileSync(join(workDir, 'installed.json'), lastRaw, 'utf8')
          return lastSeen
        }
      }
    } catch { /* 未就绪(认证页/激活中),继续轮询 */ }
    await sleep(ACTIVATION_POLL_MS)
  }
  writeFileSync(join(workDir, 'installed.json'), lastRaw || '(空响应)', 'utf8')
  return lastSeen ?? { liveAll: false, notLive: bundleNames, findingsCount: -1, findingsSample: [], apiShape: [] }
}

function runBrowserProbe(probeScript, url, pngPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probeScript, JSON.stringify({ url, pngPath })], {
      cwd: process.cwd(),
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => killTree(child), 90 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').at(-1) ?? ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, rendered: false, error: `探针无输出: ${stderr.slice(-500) || line}` })
      }
    })
  })
}

// 本地 LLM 模拟器(scripts/echo-upstream.mjs):兼容性测试的 LLM 夹具。
// 全功能兼容性测试的 LLM 链路断言(provider 注册 → 宿主经 gateway 打到模拟器)必须走它,不依赖真实 API。
const SIM_BOOT_TIMEOUT_MS = 15 * 1000

function startSimulator(workDir) {
  const logPath = join(workDir, 'llm-echo.jsonl')
  // 留档按轮截断:recorder 是 append 语义,复用 workDir 复跑时旧轮请求行会污染
  // 本轮判定(upstreamSeen/亲和头读全文件),必须先清零再起模拟器
  writeFileSync(logPath, '')
  const child = spawn(process.execPath, [
    join(REPO_ROOT, 'scripts', 'echo-upstream.mjs'), '--port', '0', '--log', logPath,
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: true })
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`模拟器启动超时: ${out}`)), SIM_BOOT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = out.match(/listening 127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve({ child, port: Number(match[1]), logPath })
      }
    })
    child.on('exit', (code) => reject(new Error(`模拟器提前退出 code=${code}: ${out}`)))
  })
}

// LLM 链路验证:经页面 RPC 注册 echo provider(baseURL 指模拟器)→ 新建会话选
// echo 模型发真实消息 → 读留档。上游请求唯一触发面是会话补全(模型目录只走
// 宿主本地快照),留档出现 /chat/completions 或 /messages = 宿主 → gateway →
// 模拟器全链真实打通。
const LLM_PROBE_TIMEOUT_MS = 120 * 1000

async function runLlmVerification(base, token, simulatorPort, workDir) {
  // #3/#5 第二段:默认模型切 echo-anthropic/echo-a-model 后新会话发话,上游即
  // anthropic /messages 通道;留档 headers/body 断言亲和头与派生标记
  const anthropicDefaultPatch = {
    type: 'client-request',
    rpcId: `compat-llm-anthropic-${Date.now()}`,
    method: 'settings/update',
    path: '/api/settings/update',
    payload: {
      args: {
        ns: 'agent-default-model',
        patch: { provider: 'echo-anthropic', model: 'echo-a-model' },
      },
    },
  }
  // 宿主 0.2.0 起无可用 provider 时 DeepSeekOnboardingDialog 自动弹出,输入框
  // autoFocus 抢占焦点且 appRoot 置 inert:探针的 type 会整段落进 API Key 输入框,
  // 中文消息触发「密钥格式错误」字段校验,发话被吞(FIND-020-1 伪影根因)。
  // 每轮 type 前先关弹窗,type 后校验 composer 实际持有文本
  const dismissOnboardingEval = `(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.getAttribute('aria-label') ?? '').includes('API Key'));
    if (!dialog) return 'no-dialog';
    const later = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后配置');
    if (!later) return 'later-not-found';
    later.click();
    return 'dismissed';
  })()`
  const verifyTypedEval = `(() => {
    const ce = document.querySelector('[contenteditable="true"]');
    return JSON.stringify({ composerText: ce?.textContent ?? 'missing' });
  })()`
  // 发话到位判定:type.ok/send.ok 只证明探针调用不抛错,onboarding 弹窗在场时
  // 键盘事件会整段落入其输入框且不抛错(FIND-020-1),必须以 dismiss 结果与
  // composer 实际文本为准
  const chatMessage = '回复:ok'
  const anthropicMessage = '回复:anth'
  const composerTextOf = (name) => {
    try {
      return JSON.parse(stepByName[name]?.value ?? '{}').composerText
    } catch {
      return ''
    }
  }
  const onboardingCleared = (name) => ['no-dialog', 'dismissed'].includes(stepByName[name]?.value)
  const steps = [
    // 注册面 = --seed-gateway 装载期 patch(唯一路径):宿主对插件 ns 的运行期
    // settings/update 写入门控已收紧(0.2.0 起 "no longer configurable"),写尝试
    // 只产生条目 dispose 噪音,污染后续冷启动断言;注册语义由 L1 config 测试锁定
    // 重载页面:UI 在挂载时拉一次模型目录,seed 的 live 生效不触发前端刷新,
    // 不重载则目录里没有 echo,默认模型被判"不可用",composer 消失
    { name: 'reload-page', goto: `${base}/?token=${token}` },
    { name: 'wait-ui-settle', wait: 2500 },
    // 真实对话驱动:默认模型已由 composition patch 指向 echo(provider 声明显式
    // models 时模型目录只走宿主本地快照),上游请求唯一触发面是会话补全——
    // 新建会话直接发消息
    {
      // 内测声明模态每轮新 browser context 都会弹出,遮挡 composer 命中检测,
      // 必须先点"继续"关掉
      name: 'dismiss-intro',
      eval: `(() => {
        const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '继续')
        if (!hit) return 'no-modal'
        hit.click()
        return 'dismissed'
      })()`,
    },
    { name: 'wait-intro-gone', wait: 800 },
    {
      name: 'new-session',
      eval: `(() => {
        const hit = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('aria-label') ?? '') + ' ' + b.textContent).includes('新建会话'))
        if (!hit) return 'new-session-not-found'
        hit.click()
        return 'clicked'
      })()`,
    },
    { name: 'wait-composer', wait: 2500 },
    { name: 'dismiss-onboarding', eval: dismissOnboardingEval },
    { name: 'wait-after-dismiss', wait: 800 },
    {
      name: 'diag-catalog',
      eval: `(async () => {
        const call = async (endpoint) => {
          const resp = await fetch('/api/' + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: 'diag-' + endpoint.replace('/', '-'), method: endpoint, path: '/api/' + endpoint, payload: { args: {} } }),
          })
          const text = await resp.text()
          let body
          try { body = JSON.parse(text) } catch { body = text.slice(0, 80) }
          return { status: resp.status, body }
        }
        const catalog = await call('session/modelCatalog')
        const providers = await call('llm/listProviders')
        const catalogValue = catalog.body?.result?.value
        return JSON.stringify({
          catalogStatus: catalog.status,
          routableProviders: catalogValue?.routableProviders,
          groups: catalogValue?.groups?.map((g) => ({ id: g?.id, models: g?.models?.map((m) => m?.id) })),
          failures: catalogValue?.failures ?? catalogValue?.modelErrors,
          llmProviders: providers.body?.result?.value?.map((p) => p?.id),
        })
      })()`,
    },
    { name: 'type-message', type: { selector: '[contenteditable="true"]', text: chatMessage } },
    { name: 'verify-typed', eval: verifyTypedEval },
    { name: 'send', press: 'Enter' },
    { name: 'wait-roundtrip', wait: 10 * 1000 },
    {
      name: 'post-send-state',
      eval: `(() => {
        const ce = document.querySelector('[contenteditable="true"]')
        const errors = [...document.querySelectorAll('[class*="error" i], [role="alert"]')]
          .map((el) => el.textContent.trim().slice(0, 160))
          .filter((t) => t.length > 0)
          .slice(0, 5)
        return JSON.stringify({ composerText: ce?.textContent ?? 'missing', errors })
      })()`,
    },
    // ---- #3/#5 anthropic 段:默认模型切 echo-anthropic 后再发一轮,上游走
    // /v1/messages;亲和头与 metadata.user_id 从该轮留档断言
    { name: 'switch-default-anthropic', http: { path: '/api/settings/update', method: 'POST', body: anthropicDefaultPatch } },
    { name: 'wait-anthropic-switch', wait: 3 * 1000 },
    {
      name: 'new-session-anthropic',
      eval: `(() => {
        const hit = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('aria-label') ?? '') + ' ' + b.textContent).includes('新建会话'))
        if (!hit) return 'new-session-not-found'
        hit.click()
        return 'clicked'
      })()`,
    },
    { name: 'wait-composer-anthropic', wait: 2500 },
    { name: 'dismiss-onboarding-anthropic', eval: dismissOnboardingEval },
    { name: 'wait-after-dismiss-anthropic', wait: 800 },
    { name: 'type-message-anthropic', type: { selector: '[contenteditable="true"]', text: anthropicMessage } },
    { name: 'verify-typed-anthropic', eval: verifyTypedEval },
    { name: 'send-anthropic', press: 'Enter' },
    { name: 'wait-roundtrip-anthropic', wait: 10 * 1000 },
    {
      name: 'post-send-state-anthropic',
      eval: `(() => {
        const ce = document.querySelector('[contenteditable="true"]')
        const errors = [...document.querySelectorAll('[class*="error" i], [role="alert"]')]
          .map((el) => el.textContent.trim().slice(0, 160))
          .filter((t) => t.length > 0)
          .slice(0, 5)
        return JSON.stringify({ composerText: ce?.textContent ?? 'missing', errors })
      })()`,
    },
  ]
  const payload = JSON.stringify({
    url: `${base}/?token=${token}`,
    out: join(workDir, 'l3-llm.json'),
    steps,
  })
  const probeResult = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./l3-probe.mjs', import.meta.url)),
      '-',
    ], { cwd: process.cwd(), windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.write(payload)
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => killTree(child), LLM_PROBE_TIMEOUT_MS)
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').at(-1) ?? ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ results: [], consoleErrors: [], error: `l3-probe 无输出: ${stderr.slice(-500) || line}` })
      }
    })
  })
  const stepByName = Object.fromEntries((probeResult.results ?? []).map((r) => [r.name, r]))
  // 注册判定以模型目录为准(routableProviders 含 echo-openai):settings/update 运行期
  // 热更与 --seed-gateway 装载期注册两种形态都在目录收敛;宿主对插件 ns 的写入门控
  // 随世代收紧(0.2.0 起 "no longer configurable"),目录形态不受其影响
  let catalogEcho = false
  try {
    const catalog = JSON.parse(stepByName['diag-catalog']?.value ?? '{}')
    catalogEcho = (catalog.routableProviders ?? []).includes('echo-openai')
  } catch { /* 目录步失败按未注册处理 */ }
  const providerRegistered = catalogEcho
  const chatDriven = stepByName['new-session']?.value === 'clicked'
    && stepByName['type-message']?.ok === true
    && stepByName['send']?.ok === true
    && onboardingCleared('dismiss-onboarding')
    && composerTextOf('verify-typed') === chatMessage
  // #3/#5 anthropic 段:切默认模型后新会话发话到位即 anthropicDriven
  const anthropicDriven = stepByName['switch-default-anthropic']?.ok === true
    && stepByName['new-session-anthropic']?.value === 'clicked'
    && stepByName['type-message-anthropic']?.ok === true
    && stepByName['send-anthropic']?.ok === true
    && onboardingCleared('dismiss-onboarding-anthropic')
    && composerTextOf('verify-typed-anthropic') === anthropicMessage
  // 留档证据:任一对话请求打到模拟器即链路通(openai /chat/completions 或
  // anthropic /messages;发现探测 GET /models 仅 ambient discovery 命中,不判)。
  // anthropic 轮单独取证:#3 metadata.user_id 派生标记 + #5 亲和头发射
  let upstreamSeen = false
  let upstreamKinds = []
  let anthropicUpstream = { seen: false, userId: null, affinityHeaders: [], headers: null }
  try {
    const lines = readFileSync(join(workDir, 'llm-echo.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    upstreamKinds = [...new Set(lines.map((l) => l.path))]
    upstreamSeen = lines.some((l) => l.path.includes('/chat/completions') || l.path.includes('/messages'))
    const anthropicTurns = lines.filter((l) => l.path.includes('/messages'))
    const last = anthropicTurns.at(-1)
    if (last !== undefined) {
      const headerNames = Object.keys(last.headers ?? {}).map((k) => k.toLowerCase())
      anthropicUpstream = {
        seen: true,
        userId: last.body?.metadata?.user_id ?? null,
        affinityHeaders: headerNames.filter((k) => k.includes('affinity') || k.includes('request-id')),
        headers: last.headers ?? {},
      }
    }
  } catch { /* 无留档 = 零请求 */ }
  return {
    providerRegistered,
    chatDriven,
    anthropicDriven,
    anthropicUpstream,
    upstreamSeen,
    upstreamKinds,
    stepValues: Object.fromEntries(Object.entries(stepByName).map(([name, step]) => [name, step.value ?? (step.ok ? 'ok' : step.error)])),
    stepErrors: (probeResult.results ?? []).filter((r) => !r.ok).map((r) => `${r.name}: ${r.error ?? ''}`),
    consoleErrors: (probeResult.consoleErrors ?? []).slice(0, 5),
    probeError: probeResult.error,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const workDir = join(args.workRoot, args.version)
  mkdirSync(workDir, { recursive: true })
  // 早退时 ci 会贴 result.json 当明细,陈旧文件必须先清
  rmSync(join(workDir, 'result.json'), { force: true })
  const bootLogPath = join(workDir, 'boot.log')
  const hostDir = args.hostDir ?? join(workDir, 'dsh-host')
  const base = `http://127.0.0.1:${args.port}`
  const checks = { page: false, activation: null, browser: null, llm: null }

  // 宿主安装(幂等):已装则复用,支持 --host-dir 指向既有 .dsh-versions 目录
  const binGuess = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const groupPath = join(hostDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
  if (!existsSync(binGuess)) {
    mkdirSync(hostDir, { recursive: true })
    // 幽灵依赖补装(CORDIS_GROUP_PIN):与 dsh 同闭包声明,一条 pnpm add 装齐
    writeFileSync(join(hostDir, 'package.json'), JSON.stringify({
      name: 'dsh-compat-host',
      private: true,
      dependencies: { '@deepseek-ai/cordis-plugin-group': CORDIS_GROUP_PIN },
    }), 'utf8')
    writeFileSync(join(hostDir, 'pnpm-workspace.yaml'), workspaceYaml(true), 'utf8')
    log(`[${args.version}] pnpm add ${DSH_PACKAGE}@${args.version}`)
    await runCmd('pnpm', ['add', `${DSH_PACKAGE}@${args.version}`], { cwd: hostDir })
  } else if (!existsSync(groupPath)) {
    // 复用旧闭包路径:补齐缺失的幽灵依赖,防解析向上逃逸到仓库根产生跨机器不确定性
    log(`[${args.version}] 复用宿主闭包,补装 @deepseek-ai/cordis-plugin-group@${CORDIS_GROUP_PIN}`)
    await runCmd('pnpm', ['add', `@deepseek-ai/cordis-plugin-group@${CORDIS_GROUP_PIN}`], { cwd: hostDir })
  }

  // LLM 模拟器先于 profile 构建启动:--seed-gateway 的 patch 行 config 需要模拟器
  // 实际端口(baseURL 注入),模拟器 --port 0 动态分配,无法预写
  let simulator = null
  if (!args.crashOnly) {
    // apiKeyEnv 引用名 ECHO_KEY 的凭据来源:进程 env(gateway 凭据链的 env 通道)
    simulator = await startSimulator(workDir)
    log(`[${args.version}] LLM 模拟器就绪(:${simulator.port},留档 ${simulator.logPath})`)
  }
  const profile = await buildProfile({
    version: args.version,
    workRoot: args.workRoot,
    hostDir,
    seedGateway: args.seedGateway === true,
    gatewayBaseURL: simulator ? `http://127.0.0.1:${simulator.port}` : undefined,
    only: args.only ?? [],
  })
  log(`[${args.version}] bundles: ${profile.bundleNames.length} 包`)

  // 逐包外部依赖必须晚于隔离 profile 的 pnpm install:pnpm 解析 file:/registry
  // 依赖时会同步依赖源目录的 node_modules,把 npm 装好的包清空(实测);补装
  // 在 pnpm 之后,宿主经 symlink 桥 import 的包内依赖才是齐的
  log(`[${args.version}] 逐包外部依赖安装${args.skipExternals ? '(跳过)' : `: ${(await installPackageExternals()).length} 包`}`)

  if (!(await canBind(args.port))) {
    log(`端口 ${args.port} 被占,清理旧实例`)
    killPortOwner(args.port)
    await sleep(3 * 1000)
    if (!(await canBind(args.port))) throw new Error(`端口 ${args.port} 清理后仍被占,请手动处理`)
  }

  const bootLog = createWriteStream(bootLogPath, { flags: 'w' })
  let child = null
  let restoreBridge = null
  try {
    // detached 使 POSIX 子进程为进程组长,killTree 组杀才生效;win32 由 taskkill /T 承担
    child = spawn(process.execPath, [profile.binPath, 'web', '--no-open', '--port', String(args.port)], {
      cwd: profile.homeDir,
      env: {
        ...process.env,
        DSH_HOME: profile.homeDir,
        DSH_CRON_BOARD_DATA_DIR: join(workDir, 'data'),
        ECHO_KEY: 'echo-compat',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    })
    child.stdout.pipe(bootLog)
    child.stderr.pipe(bootLog)

    restoreBridge = repointBridgeFromHost(hostDir)

    const status = await waitBootReady(base, child, bootLogPath)
    const token = await waitToken(child, bootLogPath)
    await sleep(BOOT_SETTLE_MS)
    log(`[${args.version}] boot 就绪(status ${status},token 已取)`)

    // token 换 cookie 是 302 重定向语义(fetch 不持 cookie,跟随重定向会落回 404),只验可达性;
    // 前端路由就绪可能晚于 token 打印,404/超时按轮询重试
    let pageRes = null
    const pageDeadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < pageDeadline) {
      try {
        pageRes = await fetchWithTimeout(`${base}/?token=${token}`, { redirect: 'manual' })
        if (pageRes.status === 200 || (pageRes.status >= 300 && pageRes.status < 400)) break
      } catch { /* 前端未就绪,继续 */ }
      await sleep(READY_POLL_MS)
    }
    checks.page = pageRes !== null && (pageRes.status === 200 || (pageRes.status >= 300 && pageRes.status < 400))

    if (!args.crashOnly) {
      checks.activation = await checkActivation(base, token, profile.bundleNames, workDir)
      log(`[${args.version}] activation live=${checks.activation.liveAll} findings=${checks.activation.findingsCount}`)
    }
    checks.browser = await runBrowserProbe(
      fileURLToPath(new URL('./browser-probe.mjs', import.meta.url)),
      `${base}/?token=${token}`,
      join(workDir, 'page.png'),
    )
    log(`[${args.version}] browser ok=${checks.browser.ok}`)

    // LLM 链路验证(链路级边界:provider 注册 → 宿主经 gateway 打到模拟器 → 留档证据;
    // 模型行为驱动面如 shell 工具调用不在此列——模拟器不发 tool_use,该面归 L1 stub + 真实模型人工轮)
    if (!args.crashOnly) {
      checks.llm = await runLlmVerification(base, token, simulator.port, workDir)
      log(`[${args.version}] llm provider=${checks.llm.providerRegistered} chat=${checks.llm.chatDriven} anthropic=${checks.llm.anthropicDriven} anthropicUpstream=${checks.llm.anthropicUpstream.seen} affinity=[${checks.llm.anthropicUpstream.affinityHeaders.join(',')}] userId=${checks.llm.anthropicUpstream.userId ?? '(无)'} upstream=${checks.llm.upstreamSeen} paths=${checks.llm.upstreamKinds.join(',') || '(无)'}`)
    }
    // --keep:宿主与模拟器存活导出(后续 l3-probe 接管跑 UI 专项);
    // 桥重指不还原会污染宿主解析,keep 路径必须在还原桥之后退出
    if (args.keep === true) {
      writeFileSync(join(workDir, 'live.json'), JSON.stringify({ port: args.port, token, simulatorPort: simulator.port, pid: child.pid, logPath: simulator.logPath }, null, 2), 'utf8')
      log(`[${args.version}] keep:宿主 :${args.port} token=${token} 模拟器 :${simulator.port}(live.json 已落,自行收尾用 scripts/compat/keep-stop.mjs)`)
    }
    if (args.keep === true) return
  } finally {
    if (args.keep !== true) {
      killTree(child)
      simulator?.child.kill()
      await sleep(KILL_GRACE_MS)
      killTree(child, { force: true })
    }
    await new Promise((done) => bootLog.end(done))
    restoreBridge?.()
    if (args.keep !== true && !(await canBind(args.port))) {
      log(`端口 ${args.port} 残留监听,强制清理`)
      killPortOwner(args.port)
    }
  }

  const llmOk = checks.llm !== null && checks.llm.providerRegistered && checks.llm.chatDriven && checks.llm.upstreamSeen
  // boot.log 入库面断言:行级 "failed to import"/"did not activate" 不阻塞
  // boot(0.1.7-rc.1 实测 false-pass——主行 import 崩溃仅此一行 error,activation
  // 仍 live)。本包任一行出现加载失败字样直接 FAIL,与 activation/llm 判定并联
  let importFailures = []
  try {
    const names = enumeratePackages().all
    const text = readFileSync(bootLogPath, 'utf8')
    importFailures = text.split('\n').filter((line) =>
      names.some((name) => line.includes(name)) && /failed to import|did not activate/.test(line))
  } catch { /* 日志缺失按无失败处理,activation/llm 判定兜底 */ }

  // 基线槽只判不崩溃:页面可达 + 渲染无加载失败 + 无行级加载失败
  const crashOnly = args.crashOnly === true
  const ok = crashOnly
    ? checks.page && checks.browser.ok && importFailures.length === 0
    : checks.page && checks.activation.liveAll && checks.activation.findingsCount === 0 && checks.browser.ok && llmOk && importFailures.length === 0
  writeFileSync(join(workDir, 'result.json'), JSON.stringify({ version: args.version, mode: crashOnly ? 'crash-only' : 'full', checks, importFailures, ok }, null, 2), 'utf8')
  log(`[${args.version}] 判定(${crashOnly ? '不崩溃口径' : '完全适配口径'}) ${ok ? 'PASS' : 'FAIL'}(明细 ${join(workDir, 'result.json')})${importFailures.length > 0 ? ` 行加载失败: ${importFailures.join(' | ')}` : ''}`)
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error(`[compat] run 失败: ${error.message}`)
  process.exitCode = 1
})
