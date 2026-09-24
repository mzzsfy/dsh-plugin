// 请求留档:逐行 JSON(at/method/path/headers 小写键/body 解析后形态,解析失败为 null),
// 追加 scenario 字段供场景断言(只增不改,既有断言读 at/method/path/headers/body)。
import { appendFileSync } from 'node:fs'

export function createRecorder(logPath) {
  return (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
}

export function record(recorder, request, parsedBody, scenario) {
  recorder({
    at: new Date().toISOString(),
    method: request.method,
    path: request.url,
    headers: request.headers,
    body: parsedBody,
    scenario,
  })
}
