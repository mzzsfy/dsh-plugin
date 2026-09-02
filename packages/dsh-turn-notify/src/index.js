// dsh-turn-notify Host 半区:回合通知单源决策。观察 session/event 与 approval/request,
// 命中分类即发 webhook、写入内存投影;webServer 路由供浏览器半区轮询投影与管理音效。
// 音效持久化在 ~/.dsh/dsh-turn-notify/sounds/,投影不落盘。

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CATEGORIES,
  CATEGORY_ASK,
  CATEGORY_APPROVAL,
  MIN_TURN_DURATION_MS,
  buildUnit,
  buildWebhookPayload,
  collectSessionEvents,
  createApprovalTap,
  createProjection,
  mapEventToCategory,
  pruneMapping,
  readRawBody,
  sendWebhook,
  sessionTitle,
  shouldNotify,
  uploadExt,
  UPLOAD_FILE_MAX_BYTES,
  validateConfigPatch,
  validateMappingId,
  validateUpload,
  publicConfig,
} from './core.mjs'

export const name = 'dsh-turn-notify'

export const inject = ['webServer']

const NAMESPACE = settingsNamespace('turn-notify')
const SOUNDS_DIR = join(homedir(), '.dsh', 'dsh-turn-notify', 'sounds')
const REQUEST_BODY_MAX_BYTES = 64 * 1024

const TURN_END_KIND = 'turn/end'
const TOOL_CALL_KIND = 'tool/call'
const ASK_TOOL_NAME = 'ask_user_question'

// 注册即声明 GUI 设置表单,schema 默认值即生效默认值;webhookUrl 属凭据标 secret。
const SETTINGS_SCHEMA = z.object({
  webhookUrl: z.string().role('secret').default('').description('webhook 目标 URL(Slack-compatible {text}),留空禁用'),
  minTurnDurationMs: z.number().default(MIN_TURN_DURATION_MS).description('回合最短时长过滤,毫秒,仅作用于 turn/end 类'),
  rootsOnly: z.boolean().default(true).description('子代理会话不通知'),
  enabled: z.object(Object.fromEntries(CATEGORIES.map((key) => [key, z.boolean().default(true)]))).description('六分类独立开关'),
  soundMapping: z.object(Object.fromEntries(CATEGORIES.map((key) => [key, z.string().default('')]))).description('每分类音效映射,空为内置默认,非空为上传音效 id'),
})

const readSettings = (ctx) => {
  const settings = ctx.get('settings')
  const value = settings ? settings.get(NAMESPACE) : undefined
  const fallback = { webhookUrl: '', minTurnDurationMs: MIN_TURN_DURATION_MS, rootsOnly: true, enabled: {}, soundMapping: {} }
  return value ? { ...fallback, ...value } : fallback
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒;无 Origin 的非浏览器客户端放行。
// 配合 JSON 内容类型校验,阻断跨站简单请求 drive-by 改写配置。
function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers.host
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

function rejectNonJson(req, res) {
  const contentType = req.headers ? String(req.headers['content-type'] || '') : ''
  if (contentType.indexOf('application/json') >= 0) return false
  sendJson(res, 400, { error: 'content-type 须为 application/json' })
  return true
}

const soundId = (content) => 'snd-' + createHash('sha256').update(content).digest('hex').slice(0, 16)
const soundPath = (id, ext) => join(SOUNDS_DIR, id + '.' + ext)

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const projection = createProjection({})
  // 打开回合的起始时间,按会话 id 记录,回合结束即清
  const openTurns = new Map()
  // 事件读序:标题提取需要事件流,按会话累积 user/message 文本;标题封账后不再累积
  const sessionEvents = new Map()
  const titledSessions = new Set()
  let seq = 0

  function notifyUnit({ category, kind, reasonKind, session }) {
    const settings = readSettings(ctx)
    const header = session.header || {}
    const sessionId = String(session.id ?? '')
    const events = sessionEvents.get(sessionId) || []
    const durationMs = openTurns.get(sessionId) ?? null
    if (!shouldNotify({ category, kind, durationMs, settings, header })) return
    seq += 1
    const unit = buildUnit({
      id: 'n-' + Date.now().toString(36) + '-' + String(seq) + '-' + String(category),
      category,
      status: reasonKind ?? category,
      sessionTitle: sessionTitle(events),
      workspace: typeof header.cwd === 'string' ? header.cwd : '',
      durationMs,
      ts: Date.now(),
    })
    projection.push(unit)
    void sendWebhook({ url: settings.webhookUrl, payload: buildWebhookPayload(unit) })
  }

  // 权威事件流:turn/start 记时,turn/end 与 ask_user_question tool/call 命中分类
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id ?? '')
    if (event.type === 'user/message') {
      collectSessionEvents(sessionEvents, titledSessions, sessionId, event)
      return
    }
    if (event.type === 'turn/start') {
      openTurns.set(sessionId, Date.now())
      return
    }
    if (event.type === TURN_END_KIND) openTurns.delete(sessionId)
    if (event.type === TOOL_CALL_KIND && event.data && event.data.name !== ASK_TOOL_NAME) return
    const category = mapEventToCategory(event.type, event.data)
    if (category === null) return
    const reasonKind = event.type === TURN_END_KIND && event.data.reason ? event.data.reason.kind : null
    // tool/call 的提问事件与 turn/end 分类共用入口;提问通知不受碎轮过滤
    const kind = category === CATEGORY_ASK ? TOOL_CALL_KIND : TURN_END_KIND
    notifyUnit({ category, kind, reasonKind, session })
  })

  // 审批 waterfall 观察者:next() 同步放行,通知异步投递
  ctx.on('approval/request', createApprovalTap(
    ({ category }) => {
      // waterfall 请求不携带会话对象,标题与工作区留空,仅分类与时间有效
      notifyUnit({ category, kind: 'approval/request', reasonKind: category, session: { header: {} } })
    },
    (fn) => { fn() },
  ))

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA)
  })

  const listSounds = async () => {
    await mkdir(SOUNDS_DIR, { recursive: true })
    const names = await readdir(SOUNDS_DIR)
    return names
      .filter((name) => uploadExt(name) !== '')
      .map((name) => {
        const dot = name.indexOf('.')
        return { id: name.slice(0, dot), ext: name.slice(dot + 1) }
      })
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/projection',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, { units: projection.list(), soundMapping: readSettings(ctx).soundMapping })
      },
    }), 'turn-notify projection route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/sounds',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, { sounds: await listSounds(), builtin: true })
      },
    }), 'turn-notify sounds route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/upload',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res)) return
        try {
          const url = new URL(req.url, 'http://localhost')
          const filename = url.searchParams.get('name') || ''
          const body = await readRawBody(req, UPLOAD_FILE_MAX_BYTES)
          const existing = await listSounds()
          let sum = 0
          for (const sound of existing) sum += (await readFile(join(SOUNDS_DIR, sound.id + '.' + sound.ext))).length
          const verdict = validateUpload({ filename, size: body.length, totalBytes: sum })
          if (!verdict.ok) {
            sendJson(res, 400, { error: verdict.reason })
            return
          }
          const id = soundId(body)
          await mkdir(SOUNDS_DIR, { recursive: true })
          await writeFile(soundPath(id, verdict.ext), body)
          sendJson(res, 200, { ok: true, id })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    }), 'turn-notify upload route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/sound',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const id = url.searchParams.get('id') || ''
        if (req.method === 'GET') {
          try {
            const sounds = await listSounds()
            const sound = sounds.find((item) => item.id === id)
            if (!sound) {
              sendJson(res, 404, { error: '音效不存在' })
              return
            }
            const content = await readFile(join(SOUNDS_DIR, id + '.' + sound.ext))
            res.writeHead(200, { 'content-type': sound.ext === 'wav' ? 'audio/wav' : sound.ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg' })
            res.end(content)
          } catch (error) {
            sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          }
          return
        }
        if (req.method !== 'DELETE') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res)) return
        try {
          const sounds = await listSounds()
          const sound = sounds.find((item) => item.id === id)
          if (!sound) {
            sendJson(res, 404, { error: '音效不存在' })
            return
          }
          await unlink(join(SOUNDS_DIR, id + '.' + sound.ext))
          // 被引用即回落:清掉映射引用,resolveSound 兜底回内置默认
          const settings = ctx.get('settings')
          if (settings) {
            const current = readSettings(ctx)
            const mapping = pruneMapping(current.soundMapping, id)
            await settings.update(NAMESPACE, { soundMapping: mapping })
          }
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    }), 'turn-notify sound route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/mapping',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res) || rejectNonJson(req, res)) return
        try {
          const body = JSON.parse((await readRawBody(req, REQUEST_BODY_MAX_BYTES)).toString('utf8'))
          const category = body && typeof body.category === 'string' ? body.category : ''
          const id = body && typeof body.id === 'string' ? body.id : ''
          if (CATEGORIES.indexOf(category) < 0) {
            sendJson(res, 400, { error: '未知分类: ' + category })
            return
          }
          if (!validateMappingId(id, (await listSounds()).map((sound) => sound.id))) {
            sendJson(res, 400, { error: '未知音效: ' + id })
            return
          }
          const settings = ctx.get('settings')
          if (!settings) {
            sendJson(res, 500, { error: 'settings 服务不可用' })
            return
          }
          const current = readSettings(ctx)
          const mapping = { ...current.soundMapping }
          if (id.length === 0) delete mapping[category]
          else mapping[category] = id
          await settings.update(NAMESPACE, { soundMapping: mapping })
          sendJson(res, 200, { ok: true, soundMapping: mapping })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    }), 'turn-notify mapping route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/config',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, publicConfig(readSettings(ctx)))
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res) || rejectNonJson(req, res)) return
        try {
          const verdict = validateConfigPatch(JSON.parse((await readRawBody(req, REQUEST_BODY_MAX_BYTES)).toString('utf8')))
          if (!verdict.ok) {
            sendJson(res, 400, { error: verdict.reason })
            return
          }
          const settings = ctx.get('settings')
          if (!settings) {
            sendJson(res, 500, { error: 'settings 服务不可用' })
            return
          }
          await settings.update(NAMESPACE, verdict.patch)
          sendJson(res, 200, publicConfig(readSettings(ctx)))
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    }), 'turn-notify config route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/test-webhook',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res)) return
        const settings = readSettings(ctx)
        seq += 1
        const unit = buildUnit({
          id: 'test-' + Date.now().toString(36) + '-' + String(seq),
          category: CATEGORY_APPROVAL,
          status: CATEGORY_ASK,
          sessionTitle: '测试事件',
          workspace: '',
          durationMs: null,
          ts: Date.now(),
        })
        // 等待投递完成,真实结果随响应返回,测试按钮不再谎报
        const result = await sendWebhook({ url: settings.webhookUrl, payload: buildWebhookPayload(unit) })
        sendJson(res, 200, result)
      },
    }), 'turn-notify test-webhook route')
}
