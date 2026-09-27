// 服务装配:createServer + 请求处理管线(读体 → 解析 → 留档 → 场景派发 → 响应)。
// start({port, log, ...options}) 导出给 CLI 与测试共用;port 0 = 随机端口。
// 场景派发经 options.delegate 可覆写(流式/错误注入由后者接管),缺省走 protocol.respondFor。
import { createServer } from 'node:http'
import { respondFor } from './protocol.mjs'
import { createRecorder, record } from './recorder.mjs'

export function start({ port, log, ...options }) {
  const recorder = createRecorder(log)
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsedBody = null
      try { parsedBody = JSON.parse(raw) } catch { /* 测试工具不拒绝任何输入 */ }
      const ctx = { request, response, parsedBody, options }
      ctx.scenario = options.resolveScenario?.(ctx) ?? 'default'
      record(recorder, request, parsedBody, ctx.scenario)
      options.delegate?.(ctx) ?? respondJson(response, respondFor(
        request.method, request.url, request.headers, parsedBody, { ...options, scenario: ctx.scenario },
      ))
    })
  })
  return new Promise((ready) => {
    server.listen(port, '127.0.0.1', () => ready(server))
  })
}

function respondJson(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}
