// 内置流程模板纯加载器:唯一真相源为目录内 *.json5(契约源 docs/rsww-v4/feat/settings.md templates 默认值节)
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSON5 from 'json5'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FLOWS_DIR_NAME = 'flows'
const TEMPLATE_SUFFIX = '.json5'

export function defaultTemplatesDir() {
  return join(PKG_ROOT, FLOWS_DIR_NAME)
}

// 纯加载器:目录缺失返回空数组,残缺文件跳过,不缓存不抛错
export function builtinTemplates(dir) {
  let names
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.flatMap((name) => {
    if (!name.endsWith(TEMPLATE_SUFFIX)) return []
    try {
      const json5 = readFileSync(join(dir, name), 'utf8')
      const parsed = JSON5.parse(json5)
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return []
      return [{
        id: parsed.id,
        label: typeof parsed.label === 'string' ? parsed.label : parsed.id,
        description: typeof parsed.description === 'string' ? parsed.description : '',
        enabled: true,
        json5,
      }]
    } catch {
      return []
    }
  })
}
