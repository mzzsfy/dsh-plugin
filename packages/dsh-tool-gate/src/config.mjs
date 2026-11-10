// 设置 schema 与解析管线(纯函数):白名单数组 + 总开关,出厂默认,解箱与
// 严格解析。管线形态 shell-select config.mjs 同构(sanitize → resolve →
// unwrap,执行面 strict),schema 面收缩到两个字段。

import z from '@deepseek-ai/schemastery'

// 出厂白名单 = 宿主官方核心工具集 + 平台终端。插件注入的工具一律不进默认:
// 出厂状态全部延迟加载,由用户在 GUI 按需勾选;唯一例外是 Windows 的
// shell-select `shell`(见 terminalTools)。拼错名不阻断收敛只 warn。
const CORE_HEAD = Object.freeze(['read', 'edit', 'write'])

const CORE_TAIL = Object.freeze([
  'glob',
  'grep',
  'todo_write',
  'ask_user_question',
  'present',
  'web_search',
  'skill',
  'subagent',
  'job_kill',
  'read_image',
])

// 终端槽位:Windows 出厂 `shell`(shell-select 接管,用户显式要求带) + 官方
// `pwsh` 兜底(shell-select 缺席时仍可执行,在场时其请求缝隐藏 pwsh);
// POSIX 只有官方 `bash`——shell-select 在 POSIX 全部行停用,不能预置 `shell`。
function terminalTools(platform) {
  return platform === 'win32' ? ['shell', 'pwsh'] : ['bash']
}

/** 平台出厂白名单(纯函数):核心工具 + 该平台的终端工具。 */
export function defaultAllowlistFor(platform = process.platform) {
  return [...CORE_HEAD, ...terminalTools(platform), ...CORE_TAIL]
}

export const DEFAULT_ALLOWLIST = Object.freeze(defaultAllowlistFor())

export const Config = z.object({
  allowlist: z.array(z.string()).default([...DEFAULT_ALLOWLIST]).volatile(),
  enabled: z.boolean().default(true).volatile(),
  collapse: z.boolean().default(true).volatile(),
})

// 字段类型契约(落盘坏值防御的对账依据):设置写路径可能把 volatile 字段以
// ref 序列化产物等非预期形态持久化,冷启动 Config 直接抛会行死;类型不符的
// 键降级 schema 默认,行活、设置页活、可保存覆盖修复(shell-select 同款)。
const FIELD_TYPES = {
  allowlist: 'array',
  enabled: 'boolean',
  collapse: 'boolean',
}

function sanitizeConfigEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {}
  const out = {}
  for (const [key, kind] of Object.entries(FIELD_TYPES)) {
    const value = entry[key]
    if (value === undefined) continue
    const valid = kind === 'array' ? Array.isArray(value) : typeof value === kind
    if (valid) out[key] = value
  }
  return out
}

// volatile 字段解箱(schema 声明 .volatile() 后产物字段为 boxed ref,读值须
// .get();structuredClone 切断 cosmokit snapshot 深冻结产物与 schema 的原地
// 耦合,resolveConfig 幂等)。全部消费者经 resolve 管线,不直接触 Config 产物。
export function unwrapConfig(value) {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    const raw = typeof field?.get === 'function' ? field.get() : field
    return [key, raw !== null && typeof raw === 'object' ? structuredClone(raw) : raw]
  }))
}

/** schema 应用 + 解箱 + 输入深拷:持久化读回路径的宽容语义(坏值降默认)。 */
export function resolveConfig(entry) {
  return unwrapConfig(Config(structuredClone(sanitizeConfigEntry(entry ?? {}))))
}

/** 执行面严格解析:输入键被类型对账丢弃时抛(宿主刚 resolve 的产物形态
 * 非法 = 契约变化或调用方未解箱,必须炸在收敛点而非静默回落)。 */
export function resolveConfigStrict(entry) {
  const input = entry ?? {}
  const sanitized = sanitizeConfigEntry(input)
  const dropped = Object.keys(FIELD_TYPES).filter((key) => input[key] !== undefined && !(key in sanitized))
  if (dropped.length > 0) {
    throw new Error(`tool-gate: config 字段形态非法(执行面输入须先解箱为普通对象): ${dropped.join(', ')}`)
  }
  return unwrapConfig(Config(structuredClone(sanitized)))
}
