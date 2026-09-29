// ENV-003 夹具生成器: 在指定宿主 home 下伪造持久化会话(zstd 双帧) + 工作区挂接
// 用法: node scripts/compat/fixture-sessions.mjs <homeDir> <cwd> [count] [version]
// version 缺省从 homeDir 名解析(.compat/<版本>/home),catalog 取自对应 dsh-host 闭包
// 前置: 宿主已用该 home 启动过( storages/workspace.json 存在或由 workspace/create 生成 )
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [homeArg, cwdArg, countArg, versionArg] = process.argv.slice(2)
if (!homeArg || !cwdArg) { console.error('用法: fixture-sessions <home> <cwd> [count] [version]'); process.exit(1) }
const count = Number(countArg || 2)
const version = versionArg || homeArg.split(/[\\/]/).filter(Boolean).at(-2).replace(/^home$/, '0.1.7-rc.2')
const catalogUrl = 'file:///' + join(homeArg, '..', 'dsh-host', 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog', 'lib', 'index.js').replace(/\\/g, '/')
const { sessionFormatCatalog } = await import(catalogUrl)

function projectKey(cwdArg) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwdArg) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else { separatorRun = false; readable += ch }
  }
  return '--' + readable + '--'
}

const root = join(homeArg, 'sessions')
const key = projectKey(cwdArg)
const wsDir = join(root, key)
mkdirSync(wsDir, { recursive: true })

const ids = []
for (let i = 0; i < count; i++) {
  const id = 'session-' + randomUUID()
  const now = Date.now()
  const header = sessionFormatCatalog.encodeCurrentHeader({
    version: sessionFormatCatalog.currentVersion,
    id,
    createdAt: now,
    cwd: cwdArg,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }, 0)
  const lines = [JSON.stringify(header)]
  for (let m = 0; m <= i; m++) {
    lines.push(JSON.stringify(sessionFormatCatalog.encodeCurrentEvent({
      seq: m + 1, time: now + (m + 1) * 10, type: 'user/message', surfaceOp: 'append',
      data: { message: { role: 'user', content: [{ type: 'text', text: `L3 夹具样本: 第 ${i + 1} 会话第 ${m + 1} 问` }], source: { replayState: 'none' } } },
    })))
  }
  // 帧结构: 首=header 一行, 次=事件批; 文件名随 catalog 当前版本
  const frames = [zstdCompressSync(Buffer.from(lines[0] + '\n'))]
  frames.push(zstdCompressSync(Buffer.from(lines.slice(1).join('\n') + '\n')))
  const dir = join(wsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `session.v${sessionFormatCatalog.currentVersion}.jsonl.zstd`), Buffer.concat(frames))
  ids.push(id)
  console.log('生成:', id, `(${lines.length - 1} 事件)`)
}
console.log('工作区键目录:', wsDir)
console.log('后续: workspace/create(路径 ' + cwdArg + ') 后手工把 sessionIds 写入 storages/workspace.json 并重启宿主')
