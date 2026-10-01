// 设置 schema 与 argv 组装(纯函数):条目结构、出厂默认、按 kind 的 argv 形。
// pwsh argv 与编码前缀官方 dsh-pwsh-local 同构;bash argv 官方 dsh-bash-local 同构;
// cmd /d /s /c 与 wsl --exec 为本包定义的保守形态。

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

// 支持的 shell 形态
export const KINDS = ['pwsh', 'bash', 'cmd', 'wsl']

// path 字段的自动解析标记值:空串走候选探测
export const RESOLVED_AUTO = ''

// pwsh 每命令前置的 UTF-8 输出钉扎(官方同构):子进程按 UTF-8 解码,
// Windows PowerShell 5.1 兜底默认写 OEM 代码页,不加会乱码
export const PWSH_ENCODING_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

// 模板占位符:args 数组中该标记项替换为 command;无标记则 command 追加末项
const COMMAND_PLACEHOLDER = '{command}'

// 执行器预算字段(官方 dsh-pwsh-local Config 同构,默认值逐项对齐;
// cwd 同官方无 default,缺省态由 resolve 落 process.cwd())
const EXECUTOR_DEFAULTS = {
  timeoutMs: 12e4,
  maxTimeoutMs: 6e5,
  maxOutputBytes: 64e3,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3e3,
}

const shellEntry = z.object({
  id: z.string().required(),
  kind: z.union(KINDS).required(),
  path: z.string().default(RESOLVED_AUTO),
  args: z.array(z.string()).default([]),
  login: z.boolean().default(false),
  distro: z.string().default(''),
  env: z.dict(z.string()).default({}),
})

export const Config = z.object({
  // 0.1.7 设置页写路径(settings.write)只接受 volatile 字段(免重挂载的活
  // 字段,官方 dsh-bash-local Config 逐字段 volatile 同构);缺声明即
  // "has no volatile fields" 保存失败
  shells: z.array(shellEntry).default([
    { id: 'pwsh', kind: 'pwsh', path: RESOLVED_AUTO, args: [] },
    { id: 'git-bash', kind: 'bash', path: RESOLVED_AUTO, args: [] },
    { id: 'cmd', kind: 'cmd', path: RESOLVED_AUTO, args: [] },
  ]).volatile(),
  default: z.string().default('pwsh').volatile(),
  // 命令黑名单(整文本正则,大小写不敏感):命中即拒,deny 绝对无豁免;
  // 精细放行用正则前瞻在模式内表达。空数组 = 不拦截。
  // 护栏防误触,非安全边界(真边界是沙箱与访问模式)
  deny: z.array(z.string()).default([]).volatile(),
  cwd: z.string().volatile(),
  timeoutMs: z.number().default(EXECUTOR_DEFAULTS.timeoutMs).volatile(),
  maxTimeoutMs: z.number().default(EXECUTOR_DEFAULTS.maxTimeoutMs).volatile(),
  maxOutputBytes: z.number().default(EXECUTOR_DEFAULTS.maxOutputBytes).volatile(),
  maxSpillBytes: z.number().default(EXECUTOR_DEFAULTS.maxSpillBytes).volatile(),
  graceMs: z.number().default(EXECUTOR_DEFAULTS.graceMs).volatile(),
})

// volatile 字段解箱:schema 声明 .volatile() 后(0.1.7 设置页写路径只接受
// volatile 字段,缺声明即 "has no volatile fields" 拒写),Config 产物字段为
// boxed ref(读值须 .get(),官方 dsh-bash-local 同构)。统一在此解箱,消费者
// (executor/web-routes/测试)一律拿普通对象。
// structuredClone 深拷贝双向:输入侧(sanitize 产物)切断与调用方对象的耦合——
// volatile ref .get() 产物是 cosmokit snapshot 深冻结对象,schemastery resolve
// 原地改写入参,冻结 env 直接炸挂载;输出侧:schemastery resolve 会原地改写入参
// (填默认/键归一)并把产出对象置为不可扩展,二轮 resolve(快照回灌,web 写路径
// current+patch 合并常态)对不可扩展对象赋值即炸;clone 切断产物与 schema 的原地
// 耦合,保证 resolveConfig 幂等且对输入不可变。
export function unwrapConfig(value) {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    const raw = typeof field?.get === 'function' ? field.get() : field
    return [key, raw !== null && typeof raw === 'object' ? structuredClone(raw) : raw]
  }))
}

/** schema 应用 + 解箱 + 输入深拷:全部消费者经此入口,不直接触 Config 产物。 */
export function resolveConfig(entry) {
  const sanitized = sanitizeConfigEntry(entry ?? {})
  return unwrapConfig(Config(structuredClone(sanitized)))
}

/** 执行面严格解析:输入键被类型对账丢弃时抛。执行面(挂载/refresh)输入是
 * 宿主刚 resolve 的产物,形态非法 = 宿主契约变化或调用方未解箱,必须炸在
 * 挂载点(接管序列有回滚告警)而非静默回落出厂默认——静默曾让行 config
 * 长期失效(0.2.0-rc.2 真机实证)。持久化读回路径(落盘写坏降级、行不死
 * 可保存修复)仍用 resolveConfig 的宽容语义。 */
export function resolveConfigStrict(entry) {
  const input = entry ?? {}
  const sanitized = sanitizeConfigEntry(input)
  const dropped = Object.keys(FIELD_TYPES)
    .filter((key) => input[key] !== undefined && !(key in sanitized))
  if (dropped.length > 0) {
    throw new Error(`shell-select: config 字段形态非法(执行面输入须先解箱为普通对象): ${dropped.join(', ')}`)
  }
  return unwrapConfig(Config(structuredClone(sanitized)))
}

// 落盘行 config 的类型防御:设置写路径(原生页/mutate)可能把 volatile 字段
// 以非预期形态(ref 序列化产物 {})持久化,冷启动 Config 直接抛 → 行死 →
// settings describe 无此节 → 设置页保存 "no longer configurable" 死锁,
// 只能手工改 patch 解锁。类型不符的键降级为 schema 默认:行活、设置页活、
// 数据可经保存覆盖修复(官方 schema default 兜底同语义)。
// 字段类型契约:与 schema 声明一一对应,清洗按此对账
const FIELD_TYPES = {
  shells: 'array',
  deny: 'array',
  default: 'string',
  cwd: 'string',
  timeoutMs: 'number',
  maxTimeoutMs: 'number',
  maxOutputBytes: 'number',
  maxSpillBytes: 'number',
  graceMs: 'number',
}
export function sanitizeConfigEntry(entry) {
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

/** 出厂默认配置(供文档与测试比对;schema 内 default 为同构静态值)。 */
export function defaultConfig() {
  return resolveConfig({})
}

// yaml 无引号标量会把 `\` 字面落盘,任何一层再转义都让路径翻倍(C:\\ 实测):
// 入口统一归一,保证进 schema 的 path 就是干净值。
// 仅 Windows 宿主生效:posix 路径以 / 分隔,归一会把合法路径毁成反斜杠字面(CI linux 实测)
export function normalizeWin32Path(path) {
  if (process.platform !== 'win32') return path
  if (typeof path !== 'string' || path.length === 0) return path
  return path.replace(/\\{2,}/g, '\\').replace(/\//g, '\\')
}

// 更新负载深归一:shells[].path 与任意层字符串值只处理 path 键,避免误伤 args 模板
export function normalizeConfigPaths(patch) {
  if (typeof patch !== 'object' || patch === null || !Array.isArray(patch.shells)) return patch
  return {
    ...patch,
    shells: patch.shells.map((entry) => (typeof entry?.path === 'string' ? { ...entry, path: normalizeWin32Path(entry.path) } : entry)),
  }
}

function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`shell-select: ${name} must be a positive finite number`)
}

/** 拒绝无法运行的已解析配置节(schema 之外的正数/时限/清单约束,官方 assertServiceable 同构)。 */
export function assertServiceableConfig(config) {
  assertPositiveFinite('timeoutMs', config.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes)
  assertPositiveFinite('graceMs', config.graceMs)
  if (config.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`shell-select: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  if (!Array.isArray(config.shells) || config.shells.length === 0) throw new Error('shell-select: shells must not be empty')
  const ids = new Set()
  for (const entry of config.shells) {
    if (ids.has(entry.id)) throw new Error(`shell-select: duplicate shell id "${entry.id}"`)
    ids.add(entry.id)
  }
  if (!ids.has(config.default)) throw new Error(`shell-select: default "${config.default}" is not a configured shell id`)
}

/**
 * 按 id 取条目。
 * @param {Array<{id: string}>} shells
 * @param {string} id
 */
export function entryById(shells, id) {
  return shells.find((entry) => entry.id === id)
}

/**
 * 取本次调用生效的条目:显式 id 优先,缺省落 default。
 * @param {Array<{id: string}>} shells
 * @param {string|undefined} requested 模型传的 shell 参数
 * @param {string} fallbackId 配置的 default
 * @returns {{id: string, name: string, kind: string, path: string, args: string[]}}
 * @throws 未指定且 default 缺失/无效,或指定 id 不存在——文案带配置指引
 */
export function requireEntry(shells, requested, fallbackId) {
  const wanted = requested ?? fallbackId
  const entry = entryById(shells, wanted)
  if (entry !== undefined) return entry
  if (requested === undefined) {
    throw new Error(`no shell client to run: default "${fallbackId}" is not in the configured shells list; configure shells/default in the shell-select settings section or pass an explicit shell argument`)
  }
  throw new Error(`unknown shell client "${requested}"; available: ${shells.map((entry) => entry.id).join(', ') || '(none)'}; configure shells in the shell-select settings section`)
}

/**
 * 按条目组装精确 argv。
 * @param {{kind: string, path: string, args?: string[]}} entry 已解析 path 的条目
 * @param {string} command
 * @returns {string[]}
 */
export function buildArgv(entry, command) {
  if (entry.args !== undefined && entry.args.length > 0) {
    const hasPlaceholder = entry.args.includes(COMMAND_PLACEHOLDER)
    return [entry.path, ...entry.args.map((arg) => arg === COMMAND_PLACEHOLDER ? command : arg),
      ...(hasPlaceholder ? [] : [command])]
  }
  switch (entry.kind) {
    case 'pwsh': return [entry.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PWSH_ENCODING_PREAMBLE + command]
    // login:登录壳 source /etc/profile,只把 /usr/bin 注入 PATH;/mingw64/bin
    // 需条目 env 配 MSYSTEM=MINGW64。默认保持 -c:官方 dsh-bash-local 同构,
    // 且不读 profile,输出无用户脚本副作用
    case 'bash': return [entry.path, ...(entry.login === true ? ['-lc'] : ['-c']), command]
    case 'cmd': return [entry.path, '/d', '/s', '/c', command]
    // distro:发行版选择仅默认形生效;args 模板条目全权接管 argv,模板分支优先
    case 'wsl': {
      const distroPrefix = entry.distro ? ['-d', entry.distro] : []
      return [entry.path, ...distroPrefix, '--exec', 'bash', '-c', command]
    }
    default: throw new Error(`shell-select: unknown kind ${JSON.stringify(entry.kind)}`)
  }
}
