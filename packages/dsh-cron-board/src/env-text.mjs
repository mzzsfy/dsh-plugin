// env-text:会话任务的 prompt 变量折叠与打码(设计 §4.2 定案:变量折叠进 prompt 文本,
// 掩码开关默认关)。变量打码与 API 列表打码同源(maskValue)。

// 值打码:长度 ≤4 全打码,否则保留前 2 后 2 中段固定 ***(不泄漏原长度)
export function maskValue(value) {
  const text = String(value)
  if (text.length <= 4) return '***'
  return text.slice(0, 2) + '***' + text.slice(-2)
}

// 折叠:变量非空时前置变量段(明文或打码),prompt 主体随后
export function buildPromptText({ prompt, env, mask }) {
  const entries = Object.entries(env || {})
  if (entries.length === 0) return prompt
  const lines = entries.map(([name, value]) => name + '=' + (mask ? maskValue(value) : value))
  return '【环境变量】\n' + lines.join('\n') + '\n\n' + prompt
}
