// 行分帧:按 \n 切分流入字节,JSON.parse 每行;非法行静默跳过(协议通道不容错注入)
export function createLineReader(readable, onMessage) {
  let buffer = ''
  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        onMessage(JSON.parse(line))
      } catch {
        // 非法 JSON 行:协议层噪音,丢弃
      }
    }
  }
  readable.on('data', onData)
  return () => {
    readable.off('data', onData)
  }
}
