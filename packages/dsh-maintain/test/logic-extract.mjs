// 测试内部共享的 LOGIC 段提取器:从 client.js 源码提取
// // LOGIC-BEGIN <name> ... // LOGIC-END <name> 标记段并工厂化,
// deps 为段内自由变量。单份实现防多份提取器漂移(此前 restart-ready 与 parity 各持一份)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SOURCE = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

export function clientSource() {
  return CLIENT_SOURCE
}

export function extractLogic(name, deps = {}) {
  const pattern = new RegExp('// LOGIC-BEGIN ' + name + '\\n([\\s\\S]*?)\\n\\s*// LOGIC-END ' + name)
  const match = CLIENT_SOURCE.match(pattern)
  if (!match) throw new Error('client.js 缺少 LOGIC 段: ' + name)
  const keys = Object.keys(deps)
  return new Function(...keys, 'return (' + match[1].trim() + ')')(...keys.map((key) => deps[key]))
}
