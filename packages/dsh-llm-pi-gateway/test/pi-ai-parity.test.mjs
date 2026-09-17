// pi-ai 类型对表守卫 BDD:三协议 compat 名单/枚举值域与装机 pi-ai 的 types.d.ts
// 双向一致,协议全集覆盖官方 supportedProtocols。官方或 pi-ai 升级后的名单漂移
// 在此当场红——这是「防功能缺失」的机械防线;操作规程见包根《对表指南.md》。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COMPAT_FIELDS_BY_PROTOCOL, COMPAT_VALUE_CHECKS, PROTOCOL_MODULES } from '../src/config.mjs'

// 装机 pi-ai(依赖解析产物)的类型声明;pnpm junction 对 fs 读取透明,
// 依赖未安装时本文件读取即抛(环境坏 = 红,与其他依赖真实官方包的测试一致)
const TYPES = readFileSync(new URL('../node_modules/@earendil-works/pi-ai/dist/types.d.ts', import.meta.url), 'utf8')

const COMPAT_INTERFACES = {
  'anthropic-messages': 'AnthropicMessagesCompat',
  'openai-completions': 'OpenAICompletionsCompat',
  'openai-responses': 'OpenAIResponsesCompat',
}

const sorted = (list) => [...list].sort()

/** interface 名 → 可选字段名列表(字段恒为 4 空格缩进的 `name?:` 形态) */
function interfaceFields(interfaceName) {
  const body = TYPES.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  assert.ok(body, `types.d.ts 中找不到 interface ${interfaceName}:pi-ai 类型布局变化,守卫本身需重对表`)
  return [...body.matchAll(/^    ([A-Za-z]\w*)\s*\?\s*:/gm)].map((match) => match[1])
}

/** 字段声明中的 union 合法值:命名别名查 export type,内联 union 直接取字符串字面量 */
function fieldUnion(interfaceName, fieldName) {
  const body = TYPES.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`))?.[1]
  if (body === undefined) return undefined
  const declaration = body.match(new RegExp(`^\\s{4}${fieldName}\\s*\\?\\s*:\\s*([^;]+);`, 'm'))?.[1]
  if (declaration === undefined) return undefined
  let expression = declaration.trim()
  if (/^[A-Z]/.test(expression)) {
    expression = TYPES.match(new RegExp(`export type ${expression} = ([^;]+);`))?.[1]
      ?? `types.d.ts 缺 type ${declaration.trim()} 定义`
  }
  return [...expression.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

/** 值域字段可能出现在多个协议 interface(compat 共用别名),union 必须一致后合并 */
function fieldUnionAny(fieldName) {
  const unions = Object.values(COMPAT_INTERFACES)
    .map((interfaceName) => fieldUnion(interfaceName, fieldName))
    .filter((union) => union !== undefined)
  assert.ok(unions.length > 0, `types.d.ts 三协议 interface 中均找不到字段 ${fieldName}`)
  for (const union of unions) {
    assert.deepEqual(sorted(union), sorted(unions[0]), `${fieldName} 在不同协议间 union 不一致,COMPAT_VALUE_CHECKS 无法单值表达`)
  }
  return unions[0]
}

test('场景: 三协议 compat 名单与装机 pi-ai 类型双向一致(pi-ai 加/删字段即红,防名单漂移)', () => {
  for (const [protocol, interfaceName] of Object.entries(COMPAT_INTERFACES)) {
    const official = interfaceFields(interfaceName)
    const mine = COMPAT_FIELDS_BY_PROTOCOL[protocol]
    assert.ok(mine !== undefined, `本包缺少协议 ${protocol} 的 compat 名单`)
    assert.deepEqual(
      sorted(mine), sorted(official),
      `${protocol}:本包 compat 名单与 pi-ai ${interfaceName} 不一致;按《对表指南.md》比读官方源码决定纳入或偏离,勿直接改本测试`,
    )
  }
})

test('场景: 枚举类 compat 值域与装机 pi-ai union 一致(pi-ai 加值即红,防非法拼写静默缺省)', () => {
  for (const [fieldName, allowed] of Object.entries(COMPAT_VALUE_CHECKS)) {
    const official = fieldUnionAny(fieldName)
    assert.deepEqual(
      sorted(allowed), sorted(official),
      `${fieldName} 值域与 pi-ai union 不一致;非法拼写会被 pi-ai 静默按缺省处理,按《对表指南.md》对表后同步`,
    )
  }
})

test('场景: 协议全集与官方 supportedProtocols 双向一致(官方加/删协议即红,防路由与发现分支缺失)', async () => {
  const official = await import('@deepseek-ai/dsh-llm-pi-ai')
  assert.deepEqual(
    sorted(Object.keys(PROTOCOL_MODULES)), sorted(official.supportedProtocols()),
    '本包协议表与官方 supportedProtocols 不一致;官方新增协议须补 PROTOCOL_MODULES 路由与发现分支,删除协议须清理名单',
  )
})
