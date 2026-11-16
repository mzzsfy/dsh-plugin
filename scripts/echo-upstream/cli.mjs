// 公共本地 LLM 模拟器唯一启动入口；运行期控制接口见同目录 README。
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { start } from './server.mjs'
import { installDelegate } from './streaming.mjs'
import { parseArgs } from './cli-args.mjs'

const args = parseArgs(process.argv.slice(2), {
  port: 18123,
  // 默认日志按实例唯一:共享固定文件会让并发会话互相污染,也把上一轮请求留在盘上
  log: join(tmpdir(), 'echo-upstream', `${process.pid}-${Date.now()}.jsonl`),
})
mkdirSync(dirname(args.log), { recursive: true })
const server = await start({ ...installDelegate(args), ...args })
console.log(`[echo-upstream] listening 127.0.0.1:${server.address().port} log=${args.log}`)
