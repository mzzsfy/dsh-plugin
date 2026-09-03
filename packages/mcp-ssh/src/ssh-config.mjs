// ~/.ssh/config + known_hosts 解析:Host 块(多别名)、Include 递归、跳过通配默认块、
// # @password: 注释(passwordAuth 布尔,密码本体绝不外传)。

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const CONFIG_PATH = () => process.env.AGENT_SSH_CONFIG || join(homedir(), '.ssh', 'config')
const KNOWN_HOSTS_PATH = () => process.env.AGENT_SSH_KNOWN_HOSTS || join(homedir(), '.ssh', 'known_hosts')

// 通配块(Host * / * !except)是默认配置,不是可连主机
function isPatternsConnectable(patterns) {
  return patterns.some((pattern) => !pattern.includes('*') && !pattern.includes('?') && !pattern.startsWith('!'))
}

// 展开 Include(相对 ~/.ssh 或绝对,glob 单个 * 仅按目录展开,不追求完整 glob 语义)
async function expandInclude(line, baseDir) {
  const target = line.replace(/^["']|["']$/g, '')
  const absolute = target.startsWith('~') ? join(homedir(), target.slice(1)) : resolve(baseDir, target)
  const star = absolute.indexOf('*')
  if (star === -1) return [absolute]
  // 单星 glob:按目录拆 prefix/suffix 精确匹配,不做完整 glob 语义
  const sep = absolute.includes('/') ? '/' : '\\'
  const sepIndex = absolute.lastIndexOf(sep, star)
  if (sepIndex === -1) return []
  const dir = absolute.slice(0, sepIndex)
  const pattern = absolute.slice(sepIndex + 1)
  const starInPattern = pattern.indexOf('*')
  const prefix = pattern.slice(0, starInPattern)
  const suffix = pattern.slice(starInPattern + 1)
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    return entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
      .map((entry) => join(dir, entry))
  } catch {
    return []
  }
}

// 解析单个 config 文件为块列表;Include 递归(深度上限防环)
async function parseConfigFile(path, depth = 0, seen = new Set()) {
  const blocks = []
  if (depth > 8 || seen.has(resolve(path))) return blocks
  seen.add(resolve(path))
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return blocks
  }
  let current = null
  let pendingPassword = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      // @password 注释:写在可连块内直接归属;否则(块外/通配块后)pending 给下一个块认领
      const password = /^#\s*@password:(.*)$/.exec(line)
      if (password) {
        if (current !== null && current.aliases.length > 0) current._password = password[1]
        else pendingPassword = password[1]
      }
      continue
    }
    const match = /^(\S+)\s+(.*)$/.exec(line.replace(/=/, ' '))
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      const patterns = value.split(/\s+/)
      current = {
        patterns,
        aliases: isPatternsConnectable(patterns) ? patterns : [],
        hostname: null,
        user: null,
        port: null,
        identityFile: null,
        proxyJump: null,
        _password: pendingPassword,
        configFile: path,
      }
      pendingPassword = null
      if (current.aliases.length > 0) blocks.push(current)
      continue
    }
    if (current === null) {
      if (key === 'include' && depth < 8) {
        for (const includePath of await expandInclude(value, dirname(path))) {
          blocks.push(...await parseConfigFile(includePath, depth + 1, seen))
        }
      }
      continue
    }
    if (key === 'hostname') current.hostname = value
    else if (key === 'user') current.user = value
    else if (key === 'port') current.port = Number(value) || null
    else if (key === 'identityfile') current.identityFile = value.replace(/^~(?=\/|\\)/, homedir())
    else if (key === 'proxyjump') current.proxyJump = value
  }
  return blocks
}

// known_hosts:hashed 条目(|1|...)跳过,返回主机名列表
async function readKnownHostNames() {
  let text
  try {
    text = await readFile(KNOWN_HOSTS_PATH(), 'utf8')
  } catch {
    return []
  }
  const names = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('|1|')) continue
    const hostField = trimmed.split(/\s+/)[0]
    // 逗号分隔多主机名
    for (const name of hostField.split(',')) {
      if (name && !name.includes('!') && !name.includes('*')) names.add(name)
    }
  }
  return [...names]
}

// 对外:合并 config 块 + known_hosts 补充(known_hosts 主机不在 config 时以别名=主机名收录)
export async function discoverHosts() {
  const blocks = await parseConfigFile(CONFIG_PATH())
  const hosts = []
  const seenAliases = new Set()
  for (const block of blocks) {
    // 无 Hostname 的块不可达,跳过(采纳参考实现:hosts without Hostname are skipped)
    if (!block.hostname) continue
    // 多别名共享一块:主机记录 alias 取首个,aliases 全量
    for (const alias of block.aliases) seenAliases.add(alias)
    hosts.push({
      alias: block.aliases[0],
      aliases: block.aliases,
      hostname: block.hostname,
      user: block.user,
      port: block.port,
      identityFile: block.identityFile,
      proxyJump: block.proxyJump,
      passwordAuth: block._password !== null,
      source: 'ssh_config',
    })
  }
  for (const name of await readKnownHostNames()) {
    if (seenAliases.has(name)) continue
    seenAliases.add(name)
    hosts.push({ alias: name, aliases: [name], hostname: name, passwordAuth: false, source: 'known_hosts' })
  }
  return hosts
}

export { CONFIG_PATH, parseConfigFile }

// 别名是否存在(config 别名或 known_hosts 主机名)
export async function isKnownAlias(alias) {
  const hosts = await discoverHosts()
  return hosts.some((host) => host.aliases.includes(alias) || host.alias === alias)
}

export async function configExists() {
  try {
    await stat(CONFIG_PATH())
    return true
  } catch {
    return false
  }
}
