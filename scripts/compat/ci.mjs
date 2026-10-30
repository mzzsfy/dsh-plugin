// CI 兼容性测试入口:解析版本窗口 → 逐版本端到端验证 → 汇总 → 按阻塞槽位定退出码。
// 主测槽完整判定,基线槽只判不崩溃(run.mjs --crash-only);两槽失败均置退出码 1,
// 显式覆盖(~ 后缀)标记的非阻塞槽失败只发 warning。
// 用法:node scripts/compat/ci.mjs [--window-file PATH]
//   --window-file:读取已解析好的窗口 JSON(workflow 单次实算,避免与缓存键窗口漂移);
//   缺省依次回退 DSH_COMPAT_VERSIONS 显式清单 / registry 实算
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolveWindow, parseExplicit, fromRegistry, SLOT_LABELS, SLOT_MODES, EXEC_SLOTS } from './window.mjs'
import { installPackageExternals } from './profile.mjs'
import { judgeLlm } from './compat-judges.mjs'
import { COMPAT_ROOT, DEFAULT_PORT, log } from './lib.mjs'

const PROBE_TIMEOUT_MS = 12 * 60 * 1000
const STDERR_TAIL_BYTES = 700

function runVersion(entry, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./run.mjs', import.meta.url)),
      '--version', entry.version,
      '--port', String(port),
      '--skip-externals',
      ...(entry.mode === SLOT_MODES.baseline ? ['--crash-only'] : ['--seed-gateway']),
    ], { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: true })
    let stderrTail = ''
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    const timer = setTimeout(() => {
      // 超时只清本槽 spawn 的 run.mjs 子进程;其内部 finally 自会收尾宿主与模拟器,
      // 不按端口猜所有者(端口可能是其他会话或用户进程)
      child.kill('SIGKILL')
    }, PROBE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      let integrity = ''
      if (code === 0) {
        try {
          const persisted = JSON.parse(readFileSync(join(COMPAT_ROOT, entry.version, 'result.json'), 'utf8'))
          if (persisted.ok !== true) integrity = `result.json ok=${persisted.ok} 与退出码 0 不一致`
          else if (persisted.version !== entry.version) integrity = `result.json version=${persisted.version} 与槽位 ${entry.version} 不一致`
        } catch (error) {
          integrity = `result.json 复读失败: ${error.message.slice(0, 120)}`
        }
      }
      resolve({ ...entry, port, ok: code === 0 && integrity === '', exitCode: code, integrity, stderrTail })
    })
  })
}

function llmComplete(llm) {
  return judgeLlm(llm)
}

function llmCell(result) {
  try {
    const llm = JSON.parse(readFileSync(join(COMPAT_ROOT, result.version, 'result.json'), 'utf8')).checks.llm
    if (!llm) return 'N/A'
    const flags = [
      llm.providerRegistered ? '注册✓' : '注册✗',
      llm.chatDriven ? 'OpenAI操作✓' : 'OpenAI操作✗',
      llm.anthropicDriven ? 'Anthropic操作✓' : 'Anthropic操作✗',
      llm.chatRoundtrip ? 'OpenAI回复✓' : 'OpenAI回复✗',
      llm.anthropicRoundtrip ? 'Anthropic回复✓' : 'Anthropic回复✗',
      llm.upstreamKinds?.some((path) => typeof path === 'string' && path.includes('/chat/completions')) ? 'chat-upstream✓' : 'chat-upstream✗',
      llm.upstreamKinds?.some((path) => typeof path === 'string' && path.includes('/messages')) ? 'messages-upstream✓' : 'messages-upstream✗',
      llm.anthropicUpstream?.seen ? 'Anthropic上游✓' : 'Anthropic上游✗',
      /^dsh:[0-9a-f]{40}$/.test(llm.anthropicUpstream?.userId ?? '') ? 'marker✓' : 'marker✗',
    ]
    return llmComplete(llm) ? 'PASS' : `FAIL(${flags.join('/')})`
  } catch {
    return 'N/A'
  }
}

function writeSummary(results) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  const lines = [
    '## dsh 兼容性测试(全家桶 boot + 统一底线)',
    '',
    '| 槽位 | 版本 | 判定 | 端口 | LLM 链路 |',
    '|------|------|------|------|----------|',
    ...results.map((r) => `| ${SLOT_LABELS[r.slot]} | ${r.version} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.port} | ${llmCell(r)} |`),
    '',
  ]
  const blocked = results.filter((r) => !r.ok && r.blocking)
  const nonBlockingFailed = results.filter((r) => !r.ok && !r.blocking)
  if (blocked.length > 0) lines.push(`阻塞槽失败:${blocked.map((r) => r.version).join(', ')}(明细见日志 .compat/<版本>/)`, '')
  if (nonBlockingFailed.length > 0) {
    lines.push('> [!WARNING]', `> 非阻塞槽失败(不阻塞,仅显式覆盖 ~ 可产生):${nonBlockingFailed.map((r) => r.version).join(', ')};按 dsh-api-alignment 条款 3 排查`, '')
  }
  appendFileSync(summaryPath, lines.join('\n'))
}

const LLM_DIAGNOSTIC_STEPS = [
  'baseline-render', 'dismiss-intro', 'new-session', 'dismiss-onboarding', 'diag-catalog',
  'verify-typed', 'post-send-state', 'dom-scan',
  'new-session-anthropic', 'dismiss-onboarding-anthropic', 'post-send-state-anthropic', 'dom-scan-anthropic',
]

function emitLlmStepNotes(failed, llm) {
  if (!llm || llmComplete(llm)) return
  const channel = failed.blocking ? '::error::' : '::warning::'
  try {
    const probe = JSON.parse(readFileSync(join(COMPAT_ROOT, failed.version, 'l3-llm.json'), 'utf8'))
    for (const step of probe.results ?? []) {
      if (!LLM_DIAGNOSTIC_STEPS.includes(step.name)) continue
      const shape = step.ok
        ? `值=${JSON.stringify(step.value ?? null).slice(0, STDERR_TAIL_BYTES)}`
        : `error=${step.error}`
      console.log(`${channel}LLM 步骤 ${step.name}: ${shape}`)
    }
  } catch { /* 探针未落盘(boot 早退)无取证面 */ }
}

function printFailureDetail(failed) {
  const channel = failed.blocking ? '::error::' : '::warning::'
  const clip = (text) => text.replace(/\s+/g, ' ').slice(0, STDERR_TAIL_BYTES)
  if (failed.integrity) {
    console.log(`${channel}完整性交叉复读失败 ${failed.version}: ${failed.integrity}`)
    return
  }
  try {
    const detail = JSON.parse(readFileSync(join(COMPAT_ROOT, failed.version, 'result.json'), 'utf8'))
    const llm = detail.checks?.llm
    const llmNote = llm && !llmComplete(llm)
      ? `;LLM链路:注册=${llm.providerRegistered} OpenAI操作=${llm.chatDriven} OpenAI回复=${llm.chatRoundtrip} Anthropic操作=${llm.anthropicDriven} Anthropic回复=${llm.anthropicRoundtrip} Anthropic上游=${llm.anthropicUpstream?.seen} paths=${llm.upstreamKinds?.join(',') ?? 'n/a'} marker=${llm.anthropicUpstream?.userId ?? 'n/a'} 步骤失败=${(llm.stepErrors ?? []).join(' / ') || '无'}`
      : ''
    console.log(`${channel}兼容性明细 ${failed.version}: ${clip(JSON.stringify(detail))}${llmNote}`)
    emitLlmStepNotes(failed, llm)
  } catch {
    console.log(`${channel}兼容性明细 ${failed.version}: 无 result.json;stderr 尾部: ${clip(failed.stderrTail || '(空)')}`)
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--window-file') args.windowFile = argv[++i]
    else throw new Error(`未知参数: ${argv[i]}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const window_ = args.windowFile
  ? JSON.parse(readFileSync(args.windowFile, 'utf8'))
  : process.env.DSH_COMPAT_VERSIONS
    ? parseExplicit(process.env.DSH_COMPAT_VERSIONS)
    : await fromRegistry().then(({ distTags, versions }) => resolveWindow(versions, distTags))
log(`版本窗口: ${window_.map((w) => `${w.version}(${SLOT_LABELS[w.slot]}${w.blocking ? '' : ',非阻塞'})`).join(' → ')}`)
if (args.windowFile) {
  for (const w of window_) {
    if (!EXEC_SLOTS.includes(w.slot) || !Object.values(SLOT_MODES).includes(w.mode)) {
      throw new Error(`window-file 条目形态非法: ${w.version} slot=${w.slot} mode=${w.mode}`)
    }
  }
}

log(`逐包外部依赖安装: ${(await installPackageExternals()).length} 包`)

const results = []
for (const [idx, entry] of window_.entries()) {
  results.push(await runVersion(entry, DEFAULT_PORT + idx))
}
writeSummary(results)

for (const failed of results.filter((r) => !r.ok)) {
  const channel = failed.blocking ? '::error::' : '::warning::'
  console.log(`${channel}兼容性失败 ${SLOT_LABELS[failed.slot]}槽 ${failed.version}(端口 ${failed.port},明细 .compat/${failed.version}/)`)
  printFailureDetail(failed)
}

process.exitCode = results.some((r) => !r.ok && r.blocking) ? 1 : 0
