// takeover — 模式内引擎接管:pre-step 拦截 + RunDriver 启动 + 消息入队 + notice
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSON5 from 'json5'
import { validateTemplate } from './template-v4.mjs'
import { RunDriver } from './driver/index.mjs'
import { registerDriver, unregisterDriver, registerInitiator, unregisterInitiator, initiatorOf, post } from './driver/control.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = '@mzzsfy/dsh-rs-workflow'
const PRESET_ROOT_NAME = '.agent-presets'
const FLOW_PRESET_PREFIX = 'rs-'

function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() !== '' ? resolve(fromEnv.trim()) : join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

function readSettingsValue(ctx) {
  try {
    const settings = ctx.get('settings')
    const value = settings ? settings.get('rs-workflow') : undefined
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

async function resolveCwd(ctx, agent) {
  try {
    const sessionId = agent && agent.session ? String(agent.session.id || agent.id || '') : ''
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionId && sessionQuery && typeof sessionQuery.listSessions === 'function') {
      const records = await sessionQuery.listSessions()
      const hit = (records || []).find((item) => item && item.header && String(item.header.id) === sessionId)
      if (hit && hit.header && typeof hit.header.cwd === 'string' && hit.header.cwd !== '') return hit.header.cwd
    }
  } catch {
    // 会话服务缺失:回退进程目录
  }
  return process.cwd()
}

async function readSkill(ctx, name) {
  const skills = ctx.get('skills')
  if (!skills || typeof skills.get !== 'function') return null
  const skill = await skills.get(name)
  if (!skill) return null
  if (typeof skill === 'string') return skill
  if (typeof skill.content === 'string') return skill.content
  return null
}

function readDocFile(workspace, path) {
  const full = resolve(workspace || process.cwd(), path)
  if (!existsSync(full)) return null
  return readFileSync(full, 'utf8')
}

// 释放模式集合(rs-* 目录 flow.json5):嵌套子流程动态路由候选
export function discoverFlowRegistry(dshHome) {
  const root = join(dshHome, PRESET_ROOT_NAME)
  const registry = {}
  if (!existsSync(root)) return registry
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(FLOW_PRESET_PREFIX)) continue
      const flowFile = join(root, name, 'flow.json5')
      const markerFile = join(root, name, '.dsh-rs-workflow-source.json')
      if (!existsSync(flowFile) || !existsSync(markerFile)) continue
      try {
        const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
        if (marker && marker.package === PLUGIN_NAME && marker.kind === 'flow') {
          const flow = JSON5.parse(readFileSync(flowFile, 'utf8'))
          if (flow && typeof flow.id === 'string') registry[flow.id] = flow
        }
      } catch {
        // 残缺模式目录跳过
      }
    }
  } catch {
    // 预设根不可读:空候选
  }
  return registry
}

function templateSetOf(dshHome) {
  return Object.values(discoverFlowRegistry(dshHome))
}

/** 模式行激活入口(config: { kind:'flow', flowFile });dshHome/store 仅供测试注入 */
export function registerTakeover(ctx, config, { dshHome, store: storeInject } = {}) {
  const home = dshHome || resolveHome()
  const flowText = readFileSync(config.flowFile, 'utf8')
  const flow = JSON5.parse(flowText)
  const errors = validateTemplate(flow)
  if (errors.length > 0) {
    throw new Error('flow.json5 校验失败:\n- ' + errors.map((e) => `${e.target}: ${e.message}`).join('\n- '))
  }

  // 在飞账本:同一会话同一时刻至多一个 run(pre-step 串行化依赖单线程语义)
  const active = new Map()
  let engine = null

  function note(agent, text) {
    try {
      agent.session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: text.split('\n')[0].slice(0, 120) },
        content: [{ type: 'text', text }],
      }, { surfaceOp: 'append' })
    } catch (error) {
      ctx.logger?.warn?.(`rs-workflow 会话提示写入失败: ${error?.message ?? error}`)
    }
  }

  function launch(agent, request, inputs, seed) {
    const settings = readSettingsValue(ctx)
    const runId = `r-${Date.now().toString(36)}-${(launch.seq = (launch.seq ?? 0) + 1)}`
    const driver = new RunDriver({
      template: flow, templateSet: templateSetOf(home), runId, request, inputs: inputs ?? {}, state: seed,
      parent: agent, engine, slots: settings.slots ?? {}, budgets: settings.budgets ?? {},
      sessionId: agent?.session ? String(agent.session.id || agent.id || '') : '',
      store: storeInject,
    })
    const origFinish = driver.finish.bind(driver)
    driver.finish = (status, summary) => {
      origFinish(status, summary)
      unregisterDriver(driver.runId)
      for (const [agentId, entry] of [...active]) {
        if (entry.runId !== driver.runId) continue
        active.delete(agentId)
        const record = driver.store.get(driver.runId)
        note(entry.agent, status === 'completed' ? `若水编排完成: ${record.summary}` : `若水编排未完成(${status}): ${record.summary}`)
      }
    }
    return driver
  }

  async function startRun(agent, request, inputs, seed) {
    const workspace = await resolveCwd(ctx, agent)
    const driver = launch(agent, request, inputs, seed)
    driver.readDoc = (path) => readDocFile(workspace, path)
    active.set(agent.id, { runId: driver.runId, agent })
    // 发起器按会话 upsert(board resume-from 经 initiatorOf(record.sessionId) 挂回本会话)
    const sessionId = agent?.session ? String(agent.session.id || agent.id || '') : ''
    if (sessionId !== '') {
      unregisterInitiator(sessionId)
      registerInitiator(sessionId, (payload) => startRun(payload.agent ?? agent, payload.request, payload.inputs, payload.seed))
    }
    driver.start()
    return driver
  }

  ctx.inject(['workflowEngine'], (engineCtx) => {
    engine = engineCtx.workflowEngine
    engineCtx.effect(() => engineCtx.on('agent/pre-step', (payload, next) => {
      const agent = payload.agent
      if (agent?.session?.header?.parentSession !== undefined) return next()
      const text = messageText(payload.messages)
      if (text === '') return next()
      if (active.has(agent.id)) {
        const entry = active.get(agent.id)
        const accepted = post(entry.runId, { kind: 'message', text, inject: false })
        if (accepted) {
          note(agent, '若水编排进行中,该消息已排队,将在下一步骤边界进入编排')
          return { kind: 'reject' }
        }
        // post=false:run 已终态,消息放行进主会话模型
        return next()
      }
      const userText = text.split(/<\/?system-reminder>/i)[0].trim()
      const request = userText === '' ? text : userText
      startRun(agent, request).catch((error) => {
        ctx.logger?.error?.(`rs-workflow 编排启动失败: ${error?.stack ?? error?.message ?? error}`)
        note(agent, '若水编排启动失败: ' + String(error?.message ?? error).slice(0, 200))
      })
      note(agent, `若水编排已接管本请求(模板 ${flow.id})。运行中可继续发送消息,将在下一步骤进入编排;会话页签可暂停或取消`)
      return { kind: 'reject' }
    }), 'rs-workflow takeover pre-step')
  })

  return { note, startRun, active, initiatorKey: config.flowFile }
}

function messageText(messages) {
  return (messages || [])
    .map((m) => {
      if (!m) return ''
      if (typeof m.content === 'string') return m.content.trim()
      if (Array.isArray(m.content)) {
        return m.content
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
          .trim()
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
