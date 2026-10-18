// 服务装配:createServer + 请求处理管线(读体 → 解析 → 留档 → 场景派发 → 响应)。
// start({port, log, ...options}) 导出给 CLI 与测试共用;port 0 = 随机端口。
// 场景派发经 options.delegate 可覆写(流式/错误注入由后者接管),缺省走 protocol.respondFor。
import { createServer } from 'node:http'
import { respondFor } from './protocol.mjs'
import { createRecorder, record } from './recorder.mjs'
import { createControl } from './control.mjs'
import { respondControlled } from './controlled-response.mjs'

export function start({ port, log, ...options }) {
  const recorder = createRecorder(log)
  const baseOptions = options
  const control = createControl()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsedBody = null
      let validJson = false
      try { parsedBody = JSON.parse(raw); validJson = true } catch { /* 非控制请求保留原有宽容语义 */ }
      if (control.handle(request, response, parsedBody, validJson)) return
      const controlled = control.capture(request, parsedBody, raw)
      const ctx = { request, response, parsedBody, options: baseOptions }
      ctx.scenario = baseOptions.resolveScenario?.(ctx) ?? 'default'
      record(recorder, request, parsedBody, ctx.scenario)
      if (controlled !== null && controlled.reply !== null) {
        void respondControlled(response, parsedBody, controlled.protocol, controlled.reply).catch(error => {
          if (!response.headersSent) respondJson(response, { error: error.message }, 500)
          else response.destroy(error)
        })
        return
      }
      const requestOptions = { ...baseOptions, scenario: ctx.scenario }
      requestOptions.protocol = request.url.includes('/messages') ? 'anthropic' : request.url.includes('/chat/completions') ? 'openai' : 'other'
      requestOptions.echoUserMessage = requestOptions.echoUserMessage === true || request.headers['x-echo-user-message'] === 'true'
      requestOptions.delegate?.({ ...ctx, options: requestOptions }) ?? respondJson(response, respondFor(request.method, request.url, request.headers, parsedBody, requestOptions))
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
