// echo 上游测试工具:接收网关/官方节真实请求,按协议返回最小合法固定响应。
// 兼容性测试的 echo 接收器正式化,替代每次手写临时脚本。用法:
//   node scripts/echo-upstream.mjs                       # 默认端口 18123,留档到系统临时目录
//   node scripts/echo-upstream.mjs --port 0              # 随机端口(stdout 打印实际端口)
//   node scripts/echo-upstream.mjs --log <文件>          # 指定留档 jsonl 路径
// 留档逐行 JSON:at/method/path/headers(小写键)/body(解析后的请求体,解析失败为 null),
// 供 header 注入与请求体标记断言;响应文本固定为 FIXED_CONTENT,不随请求变化。
// 模型发现(GET /models)按客户端协议形状返回固定一个模型(anthropic-version 头在场即 anthropic 形状)。
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PORT = 18123
const HOST = '127.0.0.1'
const MODEL_ID = 'echo-model'
export const FIXED_CONTENT = 'echo-upstream-fixed'

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, log: join(tmpdir(), 'echo-upstream-requests.jsonl') }
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]
    if (argv[i] === '--port' && value !== undefined) args.port = Number(value)
    if (argv[i] === '--log' && value !== undefined) args.log = value
  }
  return args
}

function anthropicResponse(model) {
  return {
    id: 'msg_echo-upstream', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: FIXED_CONTENT }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function openaiResponse(model) {
  return {
    id: 'chatcmpl-echo-upstream', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message: { role: 'assistant', content: FIXED_CONTENT }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function modelListResponse(headers) {
  // anthropic-messages 发现带 anthropic-version 头,按其列表形状返回;其余按 openai 形状
  if (headers['anthropic-version'] !== undefined) {
    return {
      data: [{ id: MODEL_ID, type: 'model', display_name: MODEL_ID }],
      has_more: false,
    }
  }
  return {
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'echo-upstream' }],
  }
}

// 协议判定:路径含 /models 的 GET 是模型发现;含 /messages 是 anthropic-messages;其余按 openai 形状
function respondFor(method, path, headers, parsedBody) {
  const model = parsedBody?.model ?? null
  if (method === 'GET' && path.includes('/models')) return modelListResponse(headers)
  if (path.includes('/messages')) return anthropicResponse(model)
  return openaiResponse(model)
}

const { port, log } = parseArgs(process.argv.slice(2))
const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsedBody = null
    try { parsedBody = JSON.parse(raw) } catch { /* 测试工具不拒绝任何输入 */ }
    appendFileSync(log, `${JSON.stringify({
      at: new Date().toISOString(),
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: parsedBody,
    })}\n`)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(respondFor(request.method, request.url, request.headers, parsedBody)))
  })
})
server.listen(port, HOST, () => {
  console.log(`[echo-upstream] listening ${HOST}:${server.address().port} log=${log}`)
})
