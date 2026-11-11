// 插件路由闸门探针:无 cookie 直接打每个包的 /api/<pkg> 代表路由,期望 401/403。
// 宿主只给自己的 /api prefix 加认证,插件 exact/更长 prefix 会先命中,漏接 connection
// 闸门的路由在这里会暴露成 200;带 cookie 的同一批路由必须 200(否则闸门把业务打死)。
import { log } from './lib.mjs'

// 每个有 HTTP 路由的包一条代表路由:GET 优先,写路由用 GET 也应先被闸门拦下
export const GATE_TARGETS = [
  ['dsh-bug-perf', '/api/dsh-bug-perf/config'],
  ['dsh-cron-board', '/api/cron-board/jobs'],
  ['dsh-maintain', '/api/maintain/status'],
  ['dsh-session-manager', '/api/session-manager/status'],
  ['dsh-context-manager', '/api/context/inputs'],
  ['dsh-usage-dash', '/api/usage-dash/status'],
  ['dsh-usage-panel', '/api/usage-panel/settings'],
  ['dsh-keep-working', '/api/keep-working/config'],
  ['dsh-tool-gate', '/api/tool-gate/state'],
  ['dsh-shared-terminal', '/api/shared-terminal/pump'],
  ['dsh-turn-notify', '/api/turn-notify/sounds'],
  ['dsh-shell-select', '/api/shell-select/guard-status'],
  ['dsh-stock-assistant', '/api/stock-assistant/snapshot'],
  ['dsh-tunnel', '/api/tunnel/status'],
  ['dsh-boss-simulator', '/api/boss-simulator/board'],
  ['dsh-rs-workflow', '/api/rsww/config'],
]

async function probe(url, headers, timeoutMs) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return res.status
  } catch {
    return 0
  }
}

/**
 * 探针只覆盖"该包已装载"的路由,未装载的包直接跳过。
 * @returns {{ok:boolean, rows:Array<{name:string,path:string,anon:number,auth:number,ok:boolean}>}}
 */
export async function probeHostGate({ base, cookie, packages, timeoutMs = 10_000 }) {
  const filtered = Array.isArray(packages) && packages.length > 0
  const rows = []
  for (const [name, path] of GATE_TARGETS) {
    if (filtered && !packages.includes(name)) continue
    const anon = await probe(base + path, {}, timeoutMs)
    // 路径不存在:全量模式下说明目标表写错,判失败;--only 子集模式允许该包未装载
    if (anon === 404) {
      rows.push({ name, path, anon, auth: null, ok: filtered })
      if (!filtered) log(`[gate-probe] 失败 ${name} ${path} 路由不存在(目标表需更新)`)
      continue
    }
    const auth = await probe(base + path, { cookie }, timeoutMs)
    const ok = (anon === 401 || anon === 403) && auth !== 401 && auth !== 403
    rows.push({ name, path, anon, auth, ok })
    if (!ok) log(`[gate-probe] 失败 ${name} ${path} 无cookie=${anon} 带cookie=${auth}`)
  }
  return { ok: rows.every((row) => row.ok), rows }
}
