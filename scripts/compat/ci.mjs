// CI 兼容性测试入口:解析版本窗口 → 逐版本端到端验证 → 汇总 → 按阻塞槽位定退出码。
// 前瞻槽(最新线预发布)失败只发 warning 不阻塞;基线/主测槽失败置退出码 1。
// 用法:node scripts/compat/ci.mjs;版本窗口解析见 window.mjs(DSH_COMPAT_VERSIONS 可显式覆盖)
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveWindow, parseExplicit, fromRegistry } from './window.mjs'
import { DEFAULT_PORT, log } from './lib.mjs'

const PROBE_TIMEOUT_MS = 12 * 60 * 1000
const SLOT_LABELS = { baseline: '基线', current: '主测', preview: '前瞻' }

function runVersion(entry, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./run.mjs', import.meta.url)),
      '--version', entry.version,
      '--port', String(port),
    ], { stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ...entry, port, ok: code === 0, exitCode: code })
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

const window_ = process.env.DSH_COMPAT_VERSIONS
  ? parseExplicit(process.env.DSH_COMPAT_VERSIONS)
  : resolveWindow(await fromRegistry())
log(`版本窗口: ${window_.map((w) => `${w.version}(${SLOT_LABELS[w.slot]}${w.blocking ? '' : ',非阻塞'})`).join(' → ')}`)

const results = []
for (const [idx, entry] of window_.entries()) {
  results.push(await runVersion(entry, DEFAULT_PORT + idx))
}
writeSummary(results)

for (const failed of results.filter((r) => !r.ok)) {
  const channel = failed.blocking ? '::error::' : '::warning::'
  console.log(`${channel}兼容性失败 ${SLOT_LABELS[failed.slot]}槽 ${failed.version}(端口 ${failed.port},明细 .compat/${failed.version}/)`)
}

process.exitCode = results.some((r) => !r.ok && r.blocking) ? 1 : 0
