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
 * livePackages 是 activation 里 state=live 的包(短名):live 包的路由 404 说明
 * 装载成功但路由未注册(静默禁用),必须判失败;缺省视为未知并按未装载跳过。
 * @returns {{ok:boolean, rows:Array<{name:string,path:string,anon:number,auth:number,ok:boolean}>}}
 */
export async function probeHostGate({ base, cookie, packages, livePackages, timeoutMs = 10_000 }) {
  const filtered = Array.isArray(packages) && packages.length > 0
  const rows = []
  for (const [name, path] of GATE_TARGETS) {
    if (filtered && !packages.includes(name)) continue
    const anon = await probe(base + path, {}, timeoutMs)
    if (anon === 404) {
      // 全量模式下路由不存在即缺陷;--only 模式只有 live 包才算缺陷
      const live = livePackages?.has(name) === true
      const ok = filtered ? !live : false
      rows.push({ name, path, anon, auth: null, ok })
      if (live) log(`[gate-probe] 失败 ${name} ${path} 包已 live 但路由不存在(静默禁用)`)
      else if (!filtered) log(`[gate-probe] 失败 ${name} ${path} 路由不存在(目标表需更新)`)
      else log(`[gate-probe] 跳过 ${name} ${path} 包未 live`)
      continue
    }
    const auth = await probe(base + path, { cookie }, timeoutMs)
    const ok = (anon === 401 || anon === 403) && auth !== 401 && auth !== 403
    rows.push({ name, path, anon, auth, ok })
    if (!ok) log(`[gate-probe] 失败 ${name} ${path} 无cookie=${anon} 带cookie=${auth}`)
  }
  return { ok: rows.every((row) => row.ok), rows }
}
