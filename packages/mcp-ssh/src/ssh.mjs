// ssh/scp 原生二进制封装。安全不变量(采纳自 aiondadotcom/mcp-ssh):
// - 永远 shell:false + argv 数组 + `--` 终止选项解析
// - hostAlias 严格白名单,禁 '-' 开头(防 -oProxyCommand= 选项注入到本机执行)
// - hostAlias 必须已在 ~/.ssh/config 或 known_hosts 定义(模型只能触达用户配置过的主机)
// - scp localPath 防"第二远端"注入;禁止写入 ~/.ssh(ProxyCommand 本地 RCE 面)
// - @password 经 SSH_ASKPASS 环境注入,密码不进 argv、不进模型上下文

import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile, chmod } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import { discoverHosts } from './ssh-config.mjs'

const execFileAsync = promisify(execFile)
const WIN32 = process.platform === 'win32'
const MAX_OUTPUT = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120 * 1000
const HOST_KEY_OPTS = ['-o', 'StrictHostKeyChecking=accept-new']

const SSH_BIN = () => process.env.AGENT_SSH_BIN || 'ssh'
const SCP_BIN = () => process.env.AGENT_SCP_BIN || 'scp'

export function assertSafeHostAlias(alias) {
  if (typeof alias !== 'string' || alias.length === 0) throw new Error('host 必须是非空字符串')
  if (!/^[A-Za-z0-9_.@:][A-Za-z0-9._@:\-]*$/.test(alias)) {
    throw new Error(`非法 host "${alias}":仅允许 [A-Za-z0-9._@:-] 且不得以 '-' 开头`)
  }
}

// scp 以"第一个不在分隔符前的冒号"判定远端;C:\ 前缀在 Windows 视为本地
export function assertLocalPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('localPath 必须是非空字符串')
  const colon = path.indexOf(':')
  if (colon === -1) return
  if (WIN32 && /^[A-Za-z]:[\\/]/.test(path)) return
  const separator = path.search(WIN32 ? /[/\\]/ : /\//)
  if (separator !== -1 && separator < colon) return
  throw new Error('非法 localPath:不能是 scp 远端写法(host:path)')
}

// 禁写 ~/.ssh:该目录的 config 定义信任边界,ProxyCommand 会被 ssh 在本机经 /bin/sh 执行
export function assertNotSshDirectory(path) {
  const sshDir = join(homedir(), '.ssh')
  const expanded = /^~(?=$|[\\/])/.test(path) ? join(homedir(), path.slice(1)) : path
  const norm = (value) => (WIN32 ? value.toLowerCase() : value)
  const target = norm(resolve(expanded))
  const dir = norm(resolve(sshDir))
  if (target === dir || target.startsWith(dir + sep)) {
    throw new Error(`拒绝写入 ${sshDir}:该目录定义 SSH 信任边界`)
  }
}

async function assertKnownAlias(alias) {
  const hosts = await discoverHosts()
  const known = hosts.some((host) => host.aliases.includes(alias))
  if (!known) {
    throw new Error(`未知 host "${alias}":须先在 ~/.ssh/config 或 known_hosts 中定义`)
  }
}

let askpassScript = null
async function ensureAskpass() {
  if (askpassScript) return askpassScript
  const dir = mkdtempSync(join(tmpdir(), 'agent-shell-'))
  if (WIN32) {
    askpassScript = join(dir, `askpass-${process.pid}.cmd`)
    await writeFile(askpassScript, '@echo off\r\necho %AGENT_SSH_PASS%\r\n', { flag: 'wx' })
  } else {
    askpassScript = join(dir, `askpass-${process.pid}.sh`)
    await writeFile(askpassScript, '#!/bin/sh\necho "$AGENT_SSH_PASS"\n', { flag: 'wx', mode: 0o700 })
    await chmod(askpassScript, 0o700)
  }
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  process.once('exit', cleanup)
  return askpassScript
}

// @password 注释的密码:仅进环境,永不返回给模型
async function passwordEnvFor(alias) {
  const { parseConfigFile, CONFIG_PATH } = await import('./ssh-config.mjs')
  const blocks = await parseConfigFile(CONFIG_PATH())
  const at = alias.lastIndexOf('@')
  const bare = at === -1 ? alias : alias.slice(at + 1)
  const block = blocks.find((entry) => entry.aliases.includes(alias) || entry.aliases.includes(bare))
  if (!block || block._password === null || block._password === undefined) return null
  const script = await ensureAskpass()
  return {
    ...process.env,
    AGENT_SSH_PASS: block._password,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
  }
}

// 执行 ssh 命令(别名已在调用前完成校验)。返回 {code, stdout, stderr, timedOut}
export async function runSsh(alias, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}, onSpawn) {
  assertSafeHostAlias(alias)
  const env = await passwordEnvFor(alias)
  return await new Promise((resolve) => {
    let child
    try {
      child = nodeSpawn(SSH_BIN(), [...HOST_KEY_OPTS, '--', alias, command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        ...(env ? { env } : {}),
        ...(!WIN32 && env ? { detached: true } : {}),
      })
    } catch (error) {
      resolve({ code: 1, stdout: '', stderr: String(error.message || error), timedOut: false })
      return
    }
    onSpawn?.(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: String(error.message || error), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: timedOut ? 124 : (code ?? 0),
        stdout,
        stderr: timedOut ? stderr + '\n[命令超时被终止]' : stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

// scp 传输。direction: 'upload' | 'download'
export async function transferFile(alias, localPath, remotePath, direction) {
  assertSafeHostAlias(alias)
  assertLocalPath(localPath)
  if (direction === 'download') assertNotSshDirectory(localPath)
  await assertKnownAlias(alias)
  // scp 对 host:path 按第一个冒号切分;[] 括号固定 host 边界(IPv6/含冒号别名安全)
  const at = alias.lastIndexOf('@')
  const hostPart = at === -1 ? `[${alias}]` : `${alias.slice(0, at + 1)}[${alias.slice(at + 1)}]`
  const paths = direction === 'upload'
    ? [localPath, `${hostPart}:${remotePath}`]
    : [`${hostPart}:${remotePath}`, localPath]
  try {
    await execFileAsync(SCP_BIN(), [...HOST_KEY_OPTS, '--', ...paths], {
      timeout: 120 * 1000,
      windowsHide: true,
      shell: false,
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error.message || error) }
  }
}

export async function checkHost(alias) {
  assertSafeHostAlias(alias)
  await assertKnownAlias(alias)
  const result = await runSsh(alias, 'echo connected', { timeoutMs: 30 * 1000 })
  return {
    connected: result.code === 0 && result.stdout.trim() === 'connected',
    message: result.code === 0 ? '连接成功' : `连接失败 code=${result.code}: ${result.stderr.trim().slice(0, 500)}`,
  }
}

// SSH 交互会话的 argv 包装(供 session.mjs 使用):stdin 管道直连 ssh
export async function sshSessionArgv(alias) {
  assertSafeHostAlias(alias)
  await assertKnownAlias(alias)
  return [SSH_BIN(), [...HOST_KEY_OPTS, '-tt', '--', alias]]
}
