import { createRequire } from 'node:module'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const hostRequire = createRequire(process.env.DSH_TEST_HOST
  ? resolve(process.env.DSH_TEST_HOST, 'package.json')
  : import.meta.url)
// dsh-tools 与 controller 是两套版本坐标系:tools 只按能力面(defineTool 可导出)检测,
// 版本代际闸属 controller manifest(registerTerminalTool 的 SUPPORTED_VERSIONS),不得跨坐标系枚举
const entry = await realpath(hostRequire.resolve('@deepseek-ai/dsh-tools'))
const api = await import(pathToFileURL(entry).href)
for (const face of ['defineTool', 'validateJsonSchemaValue']) {
  if (typeof api[face] !== 'function') throw new Error('dsh-tools 缺 ' + face + ' 工具面: ' + entry)
}
export const { defineTool, validateJsonSchemaValue } = api
