// 验证:仓库包目录内能否解析全部 peer 依赖(Node ESM/require 双语义)
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const repo = 'C:/Users/yuanhao/Desktop/jzjy/dsh-plugin'
const pkgs = {
  'dsh-rs-workflow': ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-settings'],
  'dsh-usage-panel': ['@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery'],
  'dsh-maintain': ['@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery'],
  'dsh-turn-notify': ['@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery'],
  'dsh-session-manager': ['@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery'],
  'dsh-llm-pi-gateway': ['@deepseek-ai/dsh-settings', '@deepseek-ai/schemastery', '@earendil-works/pi-ai'],
}
let bad = 0
for (const [pkg, deps] of Object.entries(pkgs)) {
  const base = `${repo}/packages/${pkg}`
  if (!existsSync(base)) { console.log(`${pkg}: 目录缺失`); bad++; continue }
  const require = createRequire(pathToFileURL(`${base}/`))
  for (const dep of deps) {
    try {
      require.resolve(dep)
      console.log(`${pkg} -> ${dep}: OK`)
    } catch (e) {
      console.log(`${pkg} -> ${dep}: FAIL (${e.code})`)
      bad++
    }
  }
}
process.exitCode = bad ? 1 : 0
