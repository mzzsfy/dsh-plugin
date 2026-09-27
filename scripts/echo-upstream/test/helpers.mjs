// SSE 文本解析 helper:data: 行载荷序列;event: 行单独收集(anthropic 需要)。
// 独立非测试文件(--test 不收集),供多个测试文件复用且不触发用例重复注册。
export function parseSse(text) {
  const events = []
  for (const block of text.split('\n\n').filter((b) => b.trim())) {
    const lines = block.split('\n')
    const event = lines.find((l) => l.startsWith('event:'))?.slice(7).trim() ?? null
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
    events.push({ event, data })
  }
  return events
}
