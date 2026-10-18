// 公共本地 LLM 模拟器唯一启动入口；运行期控制接口见同目录 README。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from './server.mjs'
import { installDelegate } from './streaming.mjs'
import { parseArgs } from './cli-args.mjs'

const args = parseArgs(process.argv.slice(2), {
  port: 18123,
  log: join(tmpdir(), 'echo-upstream.jsonl'),
})
const server = await start({ ...installDelegate(args), ...args })
console.log(`[echo-upstream] listening 127.0.0.1:${server.address().port} log=${args.log}`)
