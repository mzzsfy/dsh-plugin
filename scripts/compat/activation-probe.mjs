// activation 探针:读 /dsh-market/installed 的激活态与 diagnostics findings。
// 宿主 0.2.3-alpha.2 起该路由走 web 会话闸门,token 查询只在 `/` 生效;探针先用
// token URL 铸会话 cookie 再携带请求,与 gate 探针同一 cookie 源。cookie 缺失或
// 被拒时回退 token 查询,兼容仍接受查询参数的旧宿主,并记录实际使用的认证方式。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FETCH_TIMEOUT_MS = 10 * 1000
const BODY_SAMPLE_CHARS = 200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithTimeout(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
}

// token URL 是宿主铸 cookie 的入口(302/303 + set-cookie),fetch 不持 cookie:
// 取 set-cookie 首段自行携带。页面路由未就绪或认证语义不同都按未取得处理。
export async function mintSessionCookie(base, token, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchWithTimeout(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' }, timeoutMs)
    const raw = res.headers.get('set-cookie') ?? ''
    const first = raw.split(';')[0].trim()
    return first.includes('=') ? first : ''
  } catch {
    return ''
  }
}

function activationShape(data, bundleNames) {
  const activation = data?.activation
  if (!activation) return null
  const findings = data.diagnostics?.findings ?? []
  const live = bundleNames.filter((name) => activation[name]?.state === 'live')
  const notLive = bundleNames.filter((name) => activation[name]?.state !== 'live')
  return {
    liveAll: notLive.length === 0,
    notLive,
    live,
    findingsCount: findings.length,
    findingsSample: findings.slice(0, 5),
    apiShape: Object.keys(data),
  }
}

/**
 * 读取 activation 终态;全 live 且 findings 0 时提前返回,否则轮询到证据稳定。
 * cookie 401/403 视为该路认证不可用并回退 token,两条都不可用时立即终止轮询
 * (认证结果不会随热载改变)。返回值增加 auth/status/bodySample 供判定端取证。
 * @param {{base:string, token:string, cookie?:string, bundleNames:string[], workDir:string,
 *   pollMs?:number, maxAttempts?:number, timeoutMs?:number}} input
 */
export async function probeActivation({
  base, token, cookie = '', bundleNames, workDir,
  pollMs = 5 * 1000,
  maxAttempts = 40,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  const modes = cookie ? ['cookie', 'token'] : ['token']
  let lastRaw = ''
  let lastStatus = 0
  let lastAuth = modes[0]
  let lastSeen = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retry = true
    for (const mode of modes) {
      const headers = { Origin: base, Referer: `${base}/` }
      const path = mode === 'cookie'
        ? '/dsh-market/installed'
        : `/dsh-market/installed?token=${encodeURIComponent(token)}`
      if (mode === 'cookie') headers.Cookie = cookie
      let res
      try {
        res = await fetchWithTimeout(`${base}${path}`, { headers }, timeoutMs)
      } catch {
        // 未就绪/超时:同一轮不再换路,交给下一轮轮询
        lastStatus = 0
        lastAuth = mode
        break
      }
      lastStatus = res.status
      lastAuth = mode
      lastRaw = await res.text()
      if (res.status !== 200) {
        const authRejected = res.status === 401 || res.status === 403
        // cookie 被闸门拒绝时换 token 再试一次;两条都拒绝即认证失败终态
        if (mode === 'cookie' && authRejected) continue
        if (authRejected) retry = false
        break
      }
      try {
        const seen = activationShape(JSON.parse(lastRaw), bundleNames)
        if (seen === null) break
        lastSeen = seen
        if (seen.liveAll && seen.findingsCount === 0) {
          writeFileSync(join(workDir, 'installed.json'), lastRaw, 'utf8')
          return { ...seen, auth: lastAuth, status: lastStatus, bodySample: '' }
        }
      } catch { /* 非 JSON(认证页/未就绪),继续轮询 */ }
      break
    }
    if (!retry) break
    if (attempt < maxAttempts) await sleep(pollMs)
  }

  writeFileSync(join(workDir, 'installed.json'), lastRaw || '(空响应)', 'utf8')
  const bodySample = lastRaw.slice(0, BODY_SAMPLE_CHARS)
  if (lastSeen !== null) return { ...lastSeen, auth: lastAuth, status: lastStatus, bodySample }
  return {
    liveAll: false,
    notLive: [...bundleNames],
    live: [],
    findingsCount: -1,
    findingsSample: [],
    apiShape: [],
    auth: lastAuth,
    status: lastStatus,
    bodySample,
  }
}
