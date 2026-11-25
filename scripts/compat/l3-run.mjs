// L3 逐包机检跑批:对已 --keep 驻留的隔离宿主逐包执行 l3-probe。
// 每包落 .compat/<version>/l3-<pkg>.json(原始步骤)+ l3-<pkg>.verdict.json(判定)+ l3-<pkg>.png(截图)。
// 用法:node scripts/compat/l3-run.mjs <version> <port> <token> [pkg ...]
// 约束:只读步骤(页面求值 / 导航点击 / 只读 GET 或读查询 POST / 截图),不发起升级、安装、外部写操作。
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { L3_BASE, buildSteps, judgeChecks } from './l3-checks.mjs'

const PROBE_MAX_BUFFER = 20 * 1024 * 1024

// console 归因:宿主未登录页 /login 404、负例探针 URL 的 4xx、已登记的跨包噪声文本均剔除
export function countNonHostConsole(details, fallbackCount, allowUrls = [], allowText = []) {
  if (!Array.isArray(details)) return fallbackCount
  return details.filter((detail) => {
    const url = String(detail.url ?? '')
    const text = String(detail.text ?? '')
    if (url.includes('/login')) return false
    if (allowText.some((needle) => text.includes(needle))) return false
    return !allowUrls.some((allow) => url.includes(allow))
  }).length
}

export function judgePackage(pkg, parsed, { consoleDetails } = {}) {
  const stepValue = (name) => parsed.results.find((result) => result.name === name)?.value ?? null
  const stepResult = (name) => parsed.results.find((result) => result.name === name)
  const scan = stepValue('panel-scan')
  const act = stepValue('activation')
  const cfg = L3_BASE[pkg] ?? {}
  const apiResults = [...(cfg.apis ?? []), ...(cfg.customApis ?? [])].map((api) => {
    const step = stepResult(`api-${api.name}`)
    const status = step?.value?.status ?? null
    return {
      name: api.name,
      path: api.path ?? api.customPath ?? null,
      method: api.method ?? 'GET',
      status,
      ok: step?.ok ?? false,
      ...(step?.error === undefined ? {} : { error: step.error }),
    }
  })
  const bannerOk = scan ? scan.failBanner === false : false
  const consoleTotal = parsed.consoleErrors.length
  const consoleNonLogin = countNonHostConsole(
    consoleDetails ?? parsed.consoleDetails,
    consoleTotal,
    cfg.negativeProbeUrls ?? [],
    cfg.consoleNoiseText ?? [],
  )
  const consoleOk = consoleNonLogin === 0
  const liveOk = act ? act.mine.length > 0 && act.mine.every(([, state]) => state === 'live') : false
  const findingsOk = act ? act.findingsCount === 0 : false
  const panelOk = scan?.panel ?? null
  const countsOk = scan
    ? Object.values(scan.counts).every((count) => (count.expect === null ? count.value > 0 : count.value === count.expect))
    : false
  const textOk = scan ? Object.values(scan.textHits).filter(Boolean).length : 0
  const core = bannerOk && consoleOk && liveOk && findingsOk
  const checks = judgeChecks(pkg, parsed.results)
  return {
    pkg,
    core,
    consoleTotal,
    consoleNonLogin,
    bannerOk,
    consoleOk,
    liveOk,
    findingsOk,
    panelOk,
    countsOk,
    textHits: scan?.textHits ?? {},
    counts: scan?.counts ?? {},
    activation: act,
    api: apiResults,
    checks,
    verified: checks.filter((check) => check.ok).length,
    open: stepValue('open-entry'),
  }
}

function main() {
  const [version, port, token, ...only] = process.argv.slice(2)
  if (!version || !port || !token) throw new Error('用法: l3-run.mjs <version> <port> <token> [pkg ...]')
  const packages = only.length > 0 ? only : Object.keys(L3_BASE)
  const workDir = join('.compat', version)
  const summary = []
  for (const pkg of packages) {
    if (!L3_BASE[pkg]) {
      console.log(`${pkg} SKIP 无步骤配置`)
      continue
    }
    const outPath = join(workDir, `l3-${pkg}.json`)
    const payload = JSON.stringify({
      url: `http://127.0.0.1:${port}/?token=${token}`,
      out: outPath,
      steps: buildSteps(pkg, { workDir: workDir.split('\\').join('/') }),
    })
    const res = spawnSync(process.execPath, ['scripts/compat/l3-probe.mjs', '-'], {
      input: payload,
      encoding: 'utf8',
      maxBuffer: PROBE_MAX_BUFFER,
    })
    let parsed = null
    try { parsed = JSON.parse(res.stdout.trim().split('\n').at(-1)) } catch { parsed = null }
    if (!parsed) {
      const tail = (res.stderr || '').trim().split('\n').slice(-1)[0] ?? ''
      console.log(`${pkg} PROBE_FAIL exit=${res.status} ${tail.slice(0, 160)}`)
      summary.push({ pkg, core: false, reason: 'l3-probe 无输出' })
      continue
    }
    const verdict = judgePackage(pkg, parsed)
    writeFileSync(join(workDir, `l3-${pkg}.verdict.json`), JSON.stringify(verdict, null, 2), 'utf8')
    const pass = verdict.checks.filter((check) => check.ok).map((check) => `#${check.id}`).join(',') || '-'
    const fail = verdict.checks.filter((check) => !check.ok).map((check) => `#${check.id}`).join(',') || '-'
    const line = `${pkg} core=${verdict.core ? 'ok' : 'FAIL'} console=${verdict.consoleNonLogin}/${verdict.consoleTotal} banner=${verdict.bannerOk ? 'clean' : 'FAILED'} live=${verdict.liveOk ? 'live' : 'not-live'} findings=${verdict.activation?.findingsCount ?? 'n/a'} panel=${verdict.panelOk === null ? '-' : (verdict.panelOk ? 'visible' : 'MISS')} counts=${verdict.countsOk ? 'ok' : 'MISS'} text=${Object.values(verdict.textHits).filter(Boolean).length}/${Object.keys(verdict.textHits).length} api=${verdict.api.map((api) => `${api.name}:${api.status ?? 'n/a'}`).join(',') || '-'} checks+${pass} checks-${fail}`
    console.log(line)
    summary.push(verdict)
  }
  writeFileSync(join(workDir, 'l3-summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  const coreOk = summary.filter((entry) => entry.core).length
  const verified = summary.reduce((total, entry) => total + (entry.verified ?? 0), 0)
  console.log(`完成 ${summary.length} 包,机检核心格 ok=${coreOk},新增已验编号格=${verified}`)
}

// 仅在直接执行时跑批;被单测 import 时不触发
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
