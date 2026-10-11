// 定位 board 复位:逐请求探测
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const work = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.compat', '0.2.0-rc.2')
const live = JSON.parse(readFileSync(join(work, 'live.json'), 'utf8'))
const base = `http://127.0.0.1:${live.port}`
const mint = await fetch(`${base}/?token=${live.token}`, { redirect: 'manual' })
const cookie = (mint.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
for (const path of ['/api/activation', '/api/ai-team/nope', '/api/ai-team/board', '/api/ai-team/interrupt']) {
  try {
    const res = await fetch(base + path, { headers: { cookie, origin: base, referer: `${base}/` } })
    const text = await res.text()
    console.log(path, res.status, text.slice(0, 120))
  } catch (e) {
    console.log(path, 'FETCH-FAIL', e.cause?.code ?? e.message)
  }
}
