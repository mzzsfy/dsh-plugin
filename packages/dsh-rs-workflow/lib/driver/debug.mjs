// 临时段链诊断(RSWW_DEBUG=1 时写 %TEMP%/rsww-debug.log;定位段链问题用,稳定后移除)
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export function dbg(line) {
  if (process.env.RSWW_DEBUG !== '1') return
  try { appendFileSync(join(tmpdir(), 'rsww-debug.log'), `${new Date().toISOString()} ${line}\n`) } catch {}
}
