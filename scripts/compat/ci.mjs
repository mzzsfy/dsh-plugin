// CI 兼容性测试入口:解析版本窗口 → 逐版本端到端验证 → 汇总 → 按阻塞槽位定退出码。
// 前瞻槽(全通道最新)失败只发 warning 不阻塞;基线/主测槽失败置退出码 1。
// 用法:node scripts/compat/ci.mjs [--window-file PATH]
//   --window-file:读取已解析好的窗口 JSON(workflow 单次实算,避免与缓存键窗口漂移);
//   缺省依次回退 DSH_COMPAT_VERSIONS 显式清单 / registry 实算
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { resolveWindow, parseExplicit, fromRegistry, SLOT_LABELS } from './window.mjs'
import { installPackageExternals } from './profile.mjs'
import { COMPAT_ROOT, DEFAULT_PORT, killPortOwner, log } from './lib.mjs'

const PROBE_TIMEOUT_MS = 12 * 60 * 1000
// 注解单条有长度上限,stderr 只留定位 boot 失败所需的尾部
const STDERR_TAIL_BYTES = 700

function runVersion(entry, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./run.mjs', import.meta.url)),
      '--version', entry.version,
      '--port', String(port),
      '--skip-externals',
    ], { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: true })
    // boot 早退(无 result.json)时失败原因只在 stderr:收尾部进结果,失败注解就地可读
    let stderrTail = ''
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    const timer = setTimeout(() => {
      // SIGKILL 使 run.mjs 的 finally 清理失效,孤儿宿主仍握着端口,兜底回收
      child.kill('SIGKILL')
      killPortOwner(port)
    }, PROBE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ...entry, port, ok: code === 0, exitCode: code, stderrTail })
    })
  })
}

function writeSummary(results) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  const lines = [
    '## dsh 兼容性测试(全家桶 boot + 统一底线)',
    '',
    '| 槽位 | 版本 | 判定 | 端口 |',
    '|------|------|------|------|',
    ...results.map((r) => `| ${SLOT_LABELS[r.slot]} | ${r.version} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.port} |`),
    '',
  ]
  const blocked = results.filter((r) => !r.ok && r.blocking)
  const previewFailed = results.filter((r) => !r.ok && !r.blocking)
  if (blocked.length > 0) lines.push(`阻塞槽失败:${blocked.map((r) => r.version).join(', ')}(明细见日志 .compat/<版本>/)`, '')
  if (previewFailed.length > 0) {
    lines.push(`> [!WARNING]`, `> 前瞻槽失败(不阻塞):${previewFailed.map((r) => r.version).join(', ')};新宿主线首发破坏即此信号,按 dsh-api-alignment 条款 3 排查`, '')
  }
  appendFileSync(summaryPath, lines.join('\n'))
}

// FAIL 明细直达日志与注解:result.json 与 run.mjs stderr 在 runner 磁盘/日志里,
// 匿名日志 API 读不到,只有注解在 GitHub 页面就地可读;单条注解截到定长防超限
function printFailureDetail(failed) {
  const channel = failed.blocking ? '::error::' : '::warning::'
  const clip = (text) => text.replace(/\s+/g, ' ').slice(0, STDERR_TAIL_BYTES)
  try {
    const detail = readFileSync(join(COMPAT_ROOT, failed.version, 'result.json'), 'utf8')
    console.log(`${channel}兼容性明细 ${failed.version}: ${clip(detail)}`)
  } catch {
    // boot/判定早期退出未落 result.json:真因只在 run.mjs stderr,尾部直贴注解
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
    : await fromRegistry().then(({ latest, versions }) => resolveWindow(versions, latest))
log(`版本窗口: ${window_.map((w) => `${w.version}(${SLOT_LABELS[w.slot]}${w.blocking ? '' : ',非阻塞'})`).join(' → ')}`)

// 逐包外部依赖与版本槽无关,全窗口只装一次
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
