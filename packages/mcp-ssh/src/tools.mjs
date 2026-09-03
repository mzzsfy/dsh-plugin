// MCP 工具定义与分发。所有工具结果走 events 广播(DSH UI 观察通道)。
// run 是核心:本机(平台 shell)或 SSH 统一入口,黑白名单 + 审批前置。

import { runLocal } from './exec.mjs'
import { createSessions } from './session.mjs'
import { discoverHosts } from './ssh-config.mjs'
import { runSsh, checkHost, transferFile, assertSafeHostAlias } from './ssh.mjs'
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from './config.mjs'

const HOST_PROP = {
  type: 'string',
  description: '目标主机:留空=本机;SSH 为 ~/.ssh/config 别名或 known_hosts 主机名',
}

export const TOOL_DEFINITIONS = [
  {
    name: 'run',
    description:
      '执行一条命令(本机或 SSH)。本机用平台默认 shell(cmd/sh),所有命令兼容;SSH 走系统 ssh(密钥/agent/config 全兼容)。危险命令会被护栏拦截并等待用户在面板批准。同步等待完成,适合常规命令;长驻/交互程序用 start。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令行' },
        host: HOST_PROP,
        cwd: { type: 'string', description: '工作目录(本机绝对路径;SSH 时为远端起始目录,通常留空)' },
        timeoutMs: { type: 'number', description: `超时毫秒,默认 ${DEFAULT_COMMAND_TIMEOUT_MS},上限 ${MAX_COMMAND_TIMEOUT_MS};超时杀进程树` },
        stdin: { type: 'string', description: '预写入标准输入的文本(可选)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'start',
    description: '启动交互/长驻会话(dev server、REPL、需要密码的安装器),立即返回 sessionId。之后用 read 读输出、send 写输入(密码、确认),用户也会在面板里看到并可直接输入。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要启动的命令行' },
        host: HOST_PROP,
        cwd: { type: 'string', description: '工作目录(本机)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: '读取交互会话的增量输出。cursor 传上次返回的 cursor;不传则从头读。返回会话状态(running/exited)。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cursor: { type: 'number', description: '上次 read 返回的字节游标' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'send',
    description: '向交互会话写入一行输入(自动补换行)。用于回答密码提示(先让用户在面板输入或用此工具)、确认 y/n、REPL 表达式等。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string', description: '要写入的文本' },
        newline: { type: 'boolean', description: '是否追加换行,默认 true' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'kill',
    description: '终止交互会话(杀进程树)。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'listHosts',
    description: '列出可用 SSH 主机(~/.ssh/config 与 known_hosts 自动发现)。passwordAuth:true 表示该主机配置了密码注释,连接时自动经 askpass 注入,密码不会出现在任何输出里。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'checkHost',
    description: '测试 SSH 主机连通性(执行 echo connected)。',
    inputSchema: {
      type: 'object',
      properties: { host: HOST_PROP },
      required: ['host'],
    },
  },
  {
    name: 'upload',
    description: '上传本地文件到 SSH 主机(scp)。',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST_PROP,
        localPath: { type: 'string', description: '本地文件路径' },
        remotePath: { type: 'string', description: '远端目标路径' },
      },
      required: ['host', 'localPath', 'remotePath'],
    },
  },
  {
    name: 'download',
    description: '从 SSH 主机下载文件到本地(scp;禁止写入 ~/.ssh)。',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST_PROP,
        remotePath: { type: 'string', description: '远端文件路径' },
        localPath: { type: 'string', description: '本地目标路径' },
      },
      required: ['host', 'remotePath', 'localPath'],
    },
  },
]

function textResult(payload, isError = false) {
  const result = { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] }
  if (isError) result.isError = true
  return result
}

// 命令经 guard 审批后执行;审批事件实时广播,UI 批准即放行
async function runWithGuard(core, command, host, execute) {
  const verdict = await core.guard.judge(command)
  if (verdict.verdict === 'allow') return await execute()
  const config = core.guard.config()
  const approvalMode = core.controlEnabled ? config.approvalMode : 'deny'
  if (approvalMode !== 'ui') {
    const message = `命令被护栏拦截(${verdict.reason})。当前无人工批准通道,已直接拒绝。可在配置中调整黑白名单,或在安装了面板(如 DSH 插件)的环境执行。`
    return { blocked: textResult({ error: message, command }, true) }
  }
  const approval = core.guard.requestApproval(command, host)
  core.emit({ kind: 'approval', id: approval.id, command, host, state: 'pending', reason: verdict.reason })
  const timeout = setTimeout(() => core.guard.resolveApproval(approval.id, false), config.approvalTimeoutMs)
  let approved
  try {
    approved = await approval.promise
  } finally {
    clearTimeout(timeout)
  }
  core.emit({ kind: 'approval', id: approval.id, command, host, state: approved ? 'approved' : 'denied', reason: verdict.reason })
  if (!approved) {
    return { blocked: textResult({ error: `用户拒绝了该命令(${verdict.reason})`, command }, true) }
  }
  return await execute()
}

export function createTools(core) {
  const sessions = createSessions()

  const emitExec = (record) => core.emit({ kind: 'exec', ...record })

  async function executeRun(args) {
    const command = args.command
    const host = args.host || null
    const timeoutMs = Math.min(
      Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS,
      MAX_COMMAND_TIMEOUT_MS,
    )
    const startedAt = Date.now()
    const id = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const meta = { id, command, host, cwd: args.cwd || null, source: core.sourceOverride || 'mcp' }
    emitExec({ ...meta, state: 'running' })

    if (host === null) {
      const result = await runLocal(command, { cwd: args.cwd, timeoutMs, stdin: args.stdin }, (child) => {
        core.registry.set(id, child)
      })
      core.registry.delete(id)
      const record = { ...meta, state: 'done', ...result }
      emitExec(record)
      return record
    }
    assertSafeHostAlias(host)
    const { code, stdout, stderr, timedOut, durationMs } = await runSsh(host, command, { timeoutMs }, (child) => {
      core.registry.set(id, child)
    })
    core.registry.delete(id)
    const record = { ...meta, state: 'done', exitCode: code, signal: null, timedOut, durationMs, stdout, stderr, truncated: false }
    emitExec(record)
    return record
  }

  function formatRunResult(record) {
    if (record.timedOut) {
      return textResult({ ...record, error: '命令超时被终止' }, true)
    }
    if (record.exitCode !== 0) {
      return textResult(record, true)
    }
    return textResult(record)
  }

  return {
    definitions: TOOL_DEFINITIONS,
    sessions,
    async call(name, args = {}) {
      switch (name) {
        case 'run': {
          const command = String(args.command ?? '')
          if (!command) return textResult({ error: 'command 不能为空' }, true)
          const outcome = await runWithGuard(core, command, args.host || null, () => executeRun(args))
          if (outcome.blocked) return outcome.blocked
          return formatRunResult(outcome)
        }
        case 'start': {
          const command = String(args.command ?? '')
          if (!command) return textResult({ error: 'command 不能为空' }, true)
          try {
            const host = args.host || null
            if (host !== null) return textResult({ error: 'start 暂不支持 SSH 会话,请用 run 执行远程命令' }, true)
            const outcome = await runWithGuard(core, command, host, async () => {
              const session = sessions.start(command, { cwd: args.cwd })
              emitExec({ id: session.id, command, host, cwd: args.cwd || null, source: core.sourceOverride || 'mcp', state: 'running', session: true })
              return session
            })
            if (outcome.blocked) return outcome.blocked
            return textResult({
              sessionId: outcome.id,
              hint: '用 read 读输出、send 写输入;用户也能在面板实时查看与输入',
              ...sessions.describe(outcome),
            })
          } catch (error) {
            return textResult({ error: String(error.message || error) }, true)
          }
        }
        case 'read':
          try {
            return textResult(sessions.read(String(args.sessionId), Number.isFinite(args.cursor) ? args.cursor : 0))
          } catch (error) {
            return textResult({ error: String(error.message || error) }, true)
          }
        case 'send':
          try {
            const session = sessions.send(String(args.sessionId), String(args.text ?? ''), { newline: args.newline !== false })
            emitExec({ id: session.id, command: session.command, host: session.host, cwd: null, source: 'agent', state: 'input', text: args.text })
            return textResult(session)
          } catch (error) {
            return textResult({ error: String(error.message || error) }, true)
          }
        case 'kill':
          try {
            return textResult(sessions.kill(String(args.sessionId)))
          } catch (error) {
            return textResult({ error: String(error.message || error) }, true)
          }
        case 'listHosts':
          return textResult(await discoverHosts())
        case 'checkHost':
          try {
            return textResult(await checkHost(String(args.host ?? '')))
          } catch (error) {
            return textResult({ connected: false, message: String(error.message || error) }, true)
          }
        case 'upload':
          try {
            return textResult(await transferFile(String(args.host ?? ''), String(args.localPath ?? ''), String(args.remotePath ?? ''), 'upload'))
          } catch (error) {
            return textResult({ success: false, error: String(error.message || error) }, true)
          }
        case 'download':
          try {
            return textResult(await transferFile(String(args.host ?? ''), String(args.localPath ?? ''), String(args.remotePath ?? ''), 'download'))
          } catch (error) {
            return textResult({ success: false, error: String(error.message || error) }, true)
          }
        default:
          return textResult({ error: `未知工具 ${name}` }, true)
      }
    },
  }
}
