// 本机监听端口发现: 只读系统 TCP 监听表并映射进程名, 供设置页候选与 AI 工具使用。
// 发现失败只降级为空列表, 不影响隧道增删改查。
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 3_000
const CACHE_TTL_MS = 2_000
const COMMAND_MAX_BUFFER = 1024 * 1024
const PRIVILEGED_PORT_MAX = 1024
const EPHEMERAL_PORT_MIN = 49_152
const PROBE_TIMEOUT_MS = 500

const SYSTEM_PROCESS_NAMES = new Set([
  'system', 'system idle process', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'spoolsv.exe', 'fontdrvhost.exe', 'registry',
])
// 桌面/IM/浏览器等常驻进程的监听端口不是开发服务, 默认不进候选; 只列已知高噪音进程, 不用语言白名单。
const NOISY_PROCESS_NAMES = new Set([
  'wechat.exe', 'weixin.exe', 'dingtalk.exe', 'tim.exe', 'wpscloudsvr.exe', 'ditto.exe',
  'awe sun.exe', 'awesun.exe', 'chrome.exe', 'msedge.exe', 'adb.exe', 'clash-verge.exe',
  'verge-mihomo.exe', 'mihomo.exe', 'qq.exe',
])

const normalizeProcess = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim().split(/[\\/]/).pop().toLowerCase()
}

const isSystemProcess = (processName) => processName !== null && SYSTEM_PROCESS_NAMES.has(processName)
const isNoisyProcess = (processName) => processName !== null && NOISY_PROCESS_NAMES.has(processName)

function splitAddress(value) {
  const text = String(value)
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1 || text[end + 1] !== ':') return null
    return { address: text.slice(1, end), port: Number(text.slice(end + 2)) }
  }
  const at = text.lastIndexOf(':')
  if (at <= 0) return null
  return { address: text.slice(0, at), port: Number(text.slice(at + 1)) }
}

const isWildcard = (address) => address === '0.0.0.0' || address === '::'
const isLoopbackAddress = (address) => address === '::1' || address.startsWith('127.') || address === 'localhost'
const isLoopbackBind = (address) => isWildcard(address) || isLoopbackAddress(address)
const familyOf = (address) => (String(address).includes(':') ? 'ipv6' : 'ipv4')

export function parseWindowsNetstat(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (match === null) continue
    const parsed = splitAddress(match[1])
    if (parsed === null || !Number.isInteger(parsed.port)) continue
    rows.push({ bind: parsed.address, port: parsed.port, pid: Number(match[2]) })
  }
  return rows
}

// CSV 引号字段可能含逗号(进程名一般不含, 但按 CSV 规范解析, 不靠 split)
export function parseTasklist(text) {
  const names = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    const fields = []
    let current = ''
    let quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { current += '"'; index += 1 } else quoted = !quoted
      } else if (char === ',' && !quoted) {
        fields.push(current)
        current = ''
      } else current += char
    }
    fields.push(current)
    if (fields.length >= 2 && /^\d+$/.test(fields[1])) names.set(Number(fields[1]), fields[0])
  }
  return names
}

export function parseSs(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+\s*(.*)$/i)
    if (match === null) continue
    const parsed = splitAddress(match[1])
    if (parsed === null || !Number.isInteger(parsed.port)) continue
    const processMatch = match[2].match(/\(\("([^"]+)",pid=(\d+)/)
    rows.push({
      bind: parsed.address,
      port: parsed.port,
      pid: processMatch === null ? null : Number(processMatch[2]),
      process: processMatch === null ? null : processMatch[1],
    })
  }
  return rows
}

export function parseLsof(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+TCP\s+(\S+)\s+\(LISTEN\)\s*$/)
    if (match === null) continue
    const parsed = splitAddress(match[3])
    if (parsed === null || !Number.isInteger(parsed.port)) continue
    rows.push({ bind: parsed.address, port: parsed.port, pid: Number(match[2]), process: match[1] })
  }
  return rows
}

function mergeListeners(listeners, processNames = new Map()) {
  const byPort = new Map()
  for (const listener of listeners) {
    if (!Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) continue
    const existing = byPort.get(listener.port) ?? { port: listener.port, binds: new Set(), pids: new Set(), processes: new Set() }
    existing.binds.add(listener.bind)
    if (Number.isInteger(listener.pid)) existing.pids.add(listener.pid)
    const fromRow = listener.process ?? processNames.get(listener.pid)
    if (fromRow !== undefined && fromRow !== null && fromRow !== '') existing.processes.add(fromRow)
    byPort.set(listener.port, existing)
  }
  const items = []
  for (const entry of byPort.values()) {
    const binds = [...entry.binds]
    const preferred = binds.find((bind) => isLoopbackAddress(bind) && familyOf(bind) === 'ipv4')
      ?? binds.find((bind) => isLoopbackAddress(bind))
      ?? binds.find((bind) => isWildcard(bind) && familyOf(bind) === 'ipv4')
      ?? binds[0]
    const processName = [...entry.processes][0] ?? null
    const process = normalizeProcess(processName)
    const loopback = binds.some(isLoopbackBind)
    const families = new Set(binds.map(familyOf))
    items.push({
      port: entry.port,
      bind: preferred,
      family: families.size > 1 ? 'dual' : [...families][0],
      pid: [...entry.pids][0] ?? null,
      process: processName,
      loopback,
      system: isSystemProcess(process),
      dev: loopback
        && entry.port >= PRIVILEGED_PORT_MAX
        && entry.port < EPHEMERAL_PORT_MIN
        && !isSystemProcess(process)
        && !isNoisyProcess(process),
    })
  }
  return items.sort((left, right) => left.port - right.port)
}

async function runCommand(execFileImpl, file, args) {
  const result = await execFileImpl(file, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    windowsHide: true,
  })
  return typeof result?.stdout === 'string' ? result.stdout : String(result ?? '')
}

async function scanWindows(execFileImpl) {
  const [netstat, tasklist] = await Promise.all([
    runCommand(execFileImpl, 'netstat', ['-ano', '-p', 'tcp']),
    runCommand(execFileImpl, 'tasklist', ['/FO', 'CSV', '/NH']).catch(() => ''),
  ])
  return mergeListeners(parseWindowsNetstat(netstat), parseTasklist(tasklist))
}

async function scanLinux(execFileImpl) {
  try {
    const ss = await runCommand(execFileImpl, 'ss', ['-ltnp'])
    const rows = parseSs(ss)
    if (rows.length > 0) return mergeListeners(rows)
  } catch { /* 退回 netstat */ }
  const netstat = await runCommand(execFileImpl, 'netstat', ['-ltnp'])
  const rows = []
  for (const line of netstat.split(/\r?\n/)) {
    const match = line.match(/^\s*tcp6?\s+\d+\s+\d+\s+(\S+)\s+\S+\s+LISTEN\s+(?:(\d+)\/(\S+))?/i)
    if (match === null) continue
    const parsed = splitAddress(match[1])
    if (parsed === null) continue
    rows.push({ bind: parsed.address, port: parsed.port, pid: match[2] === undefined ? null : Number(match[2]), process: match[3] ?? null })
  }
  return mergeListeners(rows)
}

async function scanMac(execFileImpl) {
  const lsof = await runCommand(execFileImpl, 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  return mergeListeners(parseLsof(lsof))
}

let cache

export function resetDiscoveryCache() {
  cache = undefined
}

export async function scanListeningPorts(options = {}) {
  const platform = options.platform ?? process.platform
  const execFileImpl = options.execFile ?? execFileAsync
  const excludePorts = new Set(options.excludePorts ?? [])
  const cacheKey = platform + '|' + [...excludePorts].sort((a, b) => a - b).join(',')
  const now = Date.now()
  if (options.refresh !== true && cache !== undefined && cache.key === cacheKey && now - cache.at < CACHE_TTL_MS) {
    return cache.value
  }
  let items
  try {
    if (platform === 'win32') items = await scanWindows(execFileImpl)
    else if (platform === 'darwin') items = await scanMac(execFileImpl)
    else items = await scanLinux(execFileImpl)
  } catch {
    const value = { supported: false, reason: '当前平台无法读取监听端口', scannedAt: new Date().toISOString(), items: [] }
    cache = { key: cacheKey, at: now, value }
    return value
  }
  const value = {
    supported: true,
    scannedAt: new Date().toISOString(),
    items: items.filter((item) => !excludePorts.has(item.port)),
  }
  cache = { key: cacheKey, at: now, value }
  return value
}

export async function probeTcpPort(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const checkedAt = new Date().toISOString()
  const startedAt = Date.now()
  return await new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host: 'localhost', port, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 })
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => finish({ state: 'offline', latencyMs: null, checkedAt, error: 'TIMEOUT' }))
    socket.once('connect', () => finish({ state: 'online', latencyMs: Date.now() - startedAt, checkedAt }))
    socket.once('error', (error) => finish({ state: 'offline', latencyMs: null, checkedAt, error: error.code ?? error.message }))
  })
}
