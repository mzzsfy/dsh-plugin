// echo 上游测试服务 CLI 入口:公共 LLM 模拟器(双协议非流式/SSE 流式/thinking/可配 usage/最小错误注入)。
// 实现见 scripts/echo-upstream/,本文件保持既有命令字面与 CLI 契约:
//   node scripts/echo-upstream.mjs                       # 默认端口 18123,留档到系统临时目录
//   node scripts/echo-upstream.mjs --port 0              # 随机端口(stdout 打印实际端口)
//   node scripts/echo-upstream.mjs --log <文件>          # 指定留档 jsonl 路径
//   node scripts/echo-upstream.mjs --tokens <in>,<out>   # 覆写 usage(默认 1/1)
//   node scripts/echo-upstream.mjs --models a,b,c        # 扩展模型目录(默认单模型)
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from './echo-upstream/server.mjs'
import { installDelegate } from './echo-upstream/streaming.mjs'

const DEFAULT_PORT = 18123

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, log: join(tmpdir(), 'echo-upstream-requests.jsonl') }
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]
    if (value === undefined) continue
    if (argv[i] === '--port') args.port = Number(value)
    if (argv[i] === '--log') args.log = value
    if (argv[i] === '--tokens') args.tokens = value.split(',').map((n) => Number(n))
    if (argv[i] === '--models') args.models = value.split(',').map((m) => m.trim()).filter((m) => m)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const server = await start({ ...installDelegate(args), ...args })
console.log(`[echo-upstream] listening 127.0.0.1:${server.address().port} log=${args.log}`)
