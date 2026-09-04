// dsh-turn-notify Host 半区:回合通知单源决策。观察 session/event 与 approval/request,
// 命中分类即发 webhook、写入内存投影;webServer 路由供浏览器半区轮询投影与管理音效。
// 音效持久化在 ~/.dsh/dsh-turn-notify/sounds/,投影不落盘。

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  CATEGORIES,
  CATEGORY_ASK,
  CATEGORY_APPROVAL,
  MIN_TURN_DURATION_MS,
  OPEN_TURN_STALE_MS,
  SUBAGENT_WAKE_WINDOW_MS,
  buildUnit,
  buildWebhookPayload,
  collectSessionEvents,
  createApprovalTap,
  createProjection,
  isSubagent,
  isSubagentWakeTurn,
  isValidImBotId,
  mapEventToCategory,
  mimeOf,
  normalizeImTargets,
  pruneTimestamps,
  readRawBody,
  resolvedConfig,
  sendWebhook,
  shouldNotify,
  storedSessionTitle,
  uploadExt,
  UPLOAD_FILE_MAX_BYTES,
  validateConfigPatch,
  validateMappingId,
  validateSoundName,
  validateUpload,
  WEBHOOK_TIMEOUT_MS,
  publicConfig,
} from './core.mjs'

export const name = 'dsh-turn-notify'

export const inject = ['webServer']

const NAMESPACE = 'turn-notify'
const SOUNDS_DIR = join(homedir(), '.dsh', 'dsh-turn-notify', 'sounds')
const REQUEST_BODY_MAX_BYTES = 64 * 1024

// dsh-im 投递错误码到 HTTP 状态的映射,未收录错误按网关失败处理
const IM_ERROR_STATUS = { 'bad-request': 400, 'unknown-bot': 404, 'bot-not-connected': 503 }

const TURN_END_KIND = 'turn/end'
const TOOL_CALL_KIND = 'tool/call'
const ASK_TOOL_NAME = 'ask_user_question'

// 注册即声明 GUI 设置表单,schema 默认值即生效默认值;webhookUrl 属凭据标 secret。
const SETTINGS_SCHEMA = z.object({
  webhookUrl: z.string().role('secret').default('').description('webhook 目标 URL(Slack-compatible {text}),留空禁用'),
  minTurnDurationMs: z.number().default(MIN_TURN_DURATION_MS).description('回合最短时长过滤,毫秒,仅作用于 turn/end 类'),
  rootsOnly: z.boolean().default(true).description('子代理会话不通知'),
  suppressSubagentWake: z.boolean().default(true).description('子代理完成唤醒的回合不通知'),
  enabled: z.object(Object.fromEntries(CATEGORIES.map((key) => [key, z.boolean().default(true)]))).description('六分类独立开关'),
  soundMapping: z.object(Object.fromEntries(CATEGORIES.map((key) => [key, z.string().default('')]))).description('每分类音效映射,空为内置默认,非空为上传音效 id'),
  imTargets: z.array(z.object({ botId: z.string().default(''), targetId: z.string().default('') })).default([]).description('dsh-im 投递目标列表'),
})

// 读侧归一交由 core 的 resolvedConfig:字段类型异常回退默认值,与写路径校验宽松度一致
const readSettings = (ctx) => {
  const settings = ctx.get('settings')
  return resolvedConfig(settings ? settings.get(NAMESPACE) : undefined)
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 错误归一:fs 类错误(code 形如 EXXX)属服务端故障回 500,请求体与校验类错误回 400;
// fs 错误原文携带主机绝对路径,仅回错误码不回 message,防向面板访客泄漏目录结构
const FS_ERROR_CODE = /^E[A-Z]+$/
function sendError(res, error) {
  const code = error && error.code
  const isFsError = typeof code === 'string' && FS_ERROR_CODE.test(code)
  const message = isFsError ? '服务端文件操作失败: ' + code : (error && error.message ? error.message : String(error))
  sendJson(res, isFsError ? 500 : 400, { error: message })
}

// 路由样板收敛:方法守卫与可选跨源/JSON 守卫统一在此,业务异常统一归一,handler 只留业务体
const route = (method, guards, handler) => async (req, res) => {
  if (req.method !== method) {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  if (guards.crossOrigin && rejectCrossOrigin(req, res)) return
  if (guards.json && rejectNonJson(req, res)) return
  try {
    await handler(req, res)
  } catch (error) {
    sendError(res, error)
  }
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
  // 子代理会话结束时刻,按父会话 id 记录,用于识别子代理回执唤醒的回合
  const childDoneAt = new Map()
  // 被子代理回执唤醒的回合,回合结束即清
  const wakeTurns = new Set()
  // 事件读序:标题提取需要事件流,按会话累积 user/message 文本;标题封账后不再累积
  const sessionEvents = new Map()
  const titledSessions = new Set()
  let seq = 0
  // 音效文件写互斥:rename 的重名检查与落盘非原子,串行化防并发重命名静默覆盖
  let soundWriteQueue = Promise.resolve()
  const serializedSoundWrite = (fn) => {
    const next = soundWriteQueue.then(fn, fn)
    soundWriteQueue = next.then(() => {}, () => {})
    return next
  }

  // dshIm 在场判定:可选依赖运行期探测,各路由统一由此取语义
  const imReady = () => ctx.get('dshIm') !== undefined

  // 测试事件构造:test-webhook 与 test-im 共用同一形态,防两处样例走样
  const buildTestUnit = () => {
    seq += 1
    return buildUnit({
      id: 'test-' + Date.now().toString(36) + '-' + String(seq),
      category: CATEGORY_APPROVAL,
      status: CATEGORY_ASK,
      sessionTitle: '测试事件',
      workspace: '',
      durationMs: null,
      ts: Date.now(),
    })
  }

  // durationMs 与 wakeTurn 由调用方在清理状态前读取后传入,防先删后读
  function notifyUnit({ category, kind, reasonKind, session, durationMs = null, wakeTurn = false }) {
    const settings = readSettings(ctx)
    const header = session.header || {}
    const sessionId = String(session.id ?? '')
    if (!shouldNotify({ category, kind, durationMs, settings, header, wakeTurn })) return
    seq += 1
    const unit = buildUnit({
      id: 'n-' + Date.now().toString(36) + '-' + String(seq) + '-' + String(category),
      category,
      status: reasonKind ?? category,
      sessionTitle: storedSessionTitle(sessionEvents, sessionId),
      workspace: typeof header.cwd === 'string' ? header.cwd : '',
      durationMs,
      ts: Date.now(),
    })
    projection.push(unit)
    void sendWebhook({ url: settings.webhookUrl, payload: buildWebhookPayload(unit) })
    deliverIm(unit, settings)
  }

  // IM 投递:多目标逐发,fire-and-forget 不重试,失败即弃,与 webhook 同语义;
  // dshIm 经运行期可选读取,未装 dsh-im 的 profile 本插件照常工作;
  // 调用推迟到微任务使同步异常同样被吞;超时与 test-im 同值,防平台挂起堆积
  function deliverIm(unit, settings) {
    const dshIm = ctx.get('dshIm')
    if (dshIm === undefined) return
    for (const { botId, targetId } of normalizeImTargets(settings.imTargets)) {
      void Promise.resolve().then(() => dshIm.send(botId, targetId, unit.text, { signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) })).catch(() => {})
    }
  }

  // 权威事件流:turn/start 记时,turn/end 与 ask_user_question tool/call 命中分类
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id ?? '')
    const now = Date.now()
    // 异常时序残留的惰性回收:超唤醒窗口的子代理回执与超上限的回合起始顺带清扫;
    // 本回合的 start 先捕获,防 prune 误删当前超长回合的起始记录
    const currentTurnStart = openTurns.get(sessionId)
    pruneTimestamps(childDoneAt, now, SUBAGENT_WAKE_WINDOW_MS)
    pruneTimestamps(openTurns, now, OPEN_TURN_STALE_MS)
    // turn/end 清理状态前捕获的决策输入,仅回分类通知消费
    let endedTurn = null
    if (event.type === 'user/message') {
      collectSessionEvents(sessionEvents, titledSessions, sessionId, event)
      return
    }
    if (event.type === 'turn/start') {
      // 子代理结束后窗口内父会话开新回合 = 回执唤醒回合;标记即消费,仅首个回合生效。
      // 依赖运行时契约:子代理 turn/end 先于父会话唤醒 turn/start 到达。
      const done = childDoneAt.get(sessionId)
      if (done !== undefined) {
        childDoneAt.delete(sessionId)
        if (isSubagentWakeTurn({ childDoneAt: done, turnStartMs: now })) wakeTurns.add(sessionId)
      }
      openTurns.set(sessionId, now)
      return
    }
    if (event.type === TURN_END_KIND) {
      // 先读后清:通知决策需要回合时长(相对 start 的差值)与唤醒标记;
      // 无 start 记录(如观察器中途装载)时长置 null,碎轮过滤跳过
      endedTurn = { durationMs: currentTurnStart === undefined ? null : now - currentTurnStart, wakeTurn: wakeTurns.has(sessionId) }
      // 子代理会话收尾:记录到父会话名下,供其唤醒回合判定
      const header = session.header || {}
      if (isSubagent(header) && header.parentSession) childDoneAt.set(String(header.parentSession), now)
      openTurns.delete(sessionId)
      wakeTurns.delete(sessionId)
      // 父会话收尾即不再有唤醒判定意义
      childDoneAt.delete(sessionId)
    }
    if (event.type === TOOL_CALL_KIND && event.data && event.data.name !== ASK_TOOL_NAME) return
    const category = mapEventToCategory(event.type, event.data)
    if (category === null) return
    const reasonKind = event.type === TURN_END_KIND && event.data.reason ? event.data.reason.kind : null
    // tool/call 的提问事件与 turn/end 分类共用入口;提问通知不受碎轮过滤
    const kind = category === CATEGORY_ASK ? TOOL_CALL_KIND : TURN_END_KIND
    notifyUnit({ category, kind, reasonKind, session, ...(endedTurn ?? {}) })
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
      handler: route('GET', {}, async (req, res) => {
        sendJson(res, 200, { units: projection.list(), soundMapping: readSettings(ctx).soundMapping })
      }),
    }), 'turn-notify projection route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/sounds',
      handler: route('GET', {}, async (req, res) => {
        sendJson(res, 200, { sounds: await listSounds(), builtin: true })
      }),
    }), 'turn-notify sounds route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/upload',
      handler: route('POST', { crossOrigin: true }, async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const filename = url.searchParams.get('name') || ''
        // 互斥段外仅读请求体;配额统计到落盘整段串行,防并发上传各自按旧总量绕过上限
        const body = await readRawBody(req, UPLOAD_FILE_MAX_BYTES)
        const id = soundId(body)
        await serializedSoundWrite(async () => {
          const sounds = await listSounds()
          // 内容寻址幂等:同内容已存在(任意扩展名)直接返回既有 id,不产生双文件;
          // 先于配额校验放行——不新增字节,扩展名差异不改变存储事实
          if (sounds.some((item) => item.id === id)) {
            sendJson(res, 200, { ok: true, id })
            return
          }
          let totalBytes = 0
          for (const sound of sounds) {
            try { totalBytes += (await stat(join(SOUNDS_DIR, sound.id + '.' + sound.ext))).size } catch { /* 与删除并发竞态按零计 */ }
          }
          const verdict = validateUpload({ filename, size: body.length, totalBytes })
          if (!verdict.ok) {
            sendJson(res, 400, { error: verdict.reason })
            return
          }
          await mkdir(SOUNDS_DIR, { recursive: true })
          await writeFile(soundPath(id, verdict.ext), body)
          sendJson(res, 200, { ok: true, id })
        })
      }),
    }), 'turn-notify upload route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/sound',
      handler: async (req, res) => {
        try {
          await dispatchSound(req, res)
        } catch (error) {
          sendError(res, error)
        }
      },
    }), 'turn-notify sound route')

  // sound 路由三方法分发:GET 读取 / PUT 重命名 / DELETE 删除,守卫差异在分支内声明
  async function dispatchSound(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id') || ''
    if (req.method === 'GET') {
      const sounds = await listSounds()
      const sound = sounds.find((item) => item.id === id)
      if (!sound) {
        sendJson(res, 404, { error: '音效不存在' })
        return
      }
      const content = await readFile(join(SOUNDS_DIR, id + '.' + sound.ext))
      res.writeHead(200, { 'content-type': mimeOf(sound.ext) })
      res.end(content)
      return
    }
    // 重命名:文件即 id,改名同步迁移映射引用;同名幂等,重名与非法名拒绝。
    if (req.method === 'PUT') {
      if (rejectCrossOrigin(req, res) || rejectNonJson(req, res)) return
      const body = JSON.parse((await readRawBody(req, REQUEST_BODY_MAX_BYTES)).toString('utf8'))
      const renameId = body && typeof body.id === 'string' ? body.id : ''
      // 互斥段覆盖重名检查到落盘,防并发窗口内同名互相覆盖
      await serializedSoundWrite(async () => {
        const sounds = await listSounds()
        const sound = sounds.find((item) => item.id === renameId)
        if (!sound) {
          sendJson(res, 404, { error: '音效不存在' })
          return
        }
        const verdict = validateSoundName(body && typeof body.name === 'string' ? body.name : '')
        if (!verdict.ok) {
          sendJson(res, 400, { error: verdict.reason })
          return
        }
        // 同名 no-op:Windows 上 rename 到自身会失败,幂等语义要求提前放行
        if (verdict.name === renameId) {
          sendJson(res, 200, { ok: true, id: renameId, soundMapping: readSettings(ctx).soundMapping })
          return
        }
        if (sounds.some((item) => item.id === verdict.name)) {
          sendJson(res, 400, { error: '名称已被占用' })
          return
        }
        await rename(join(SOUNDS_DIR, renameId + '.' + sound.ext), join(SOUNDS_DIR, verdict.name + '.' + sound.ext))
        const settings = ctx.get('settings')
        let mapping = readSettings(ctx).soundMapping
        if (settings) {
          // 映射键为分类、值为音效 id:重命名改值,深合并同键覆盖,patch 仅含变化的分类
          const patch = {}
          for (const key of Object.keys(mapping)) {
            if (mapping[key] === renameId) patch[key] = verdict.name
          }
          if (Object.keys(patch).length > 0) await settings.update(NAMESPACE, { soundMapping: patch })
          mapping = readSettings(ctx).soundMapping
        }
        sendJson(res, 200, { ok: true, id: verdict.name, soundMapping: mapping })
      })
      return
    }
    if (req.method !== 'DELETE') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (rejectCrossOrigin(req, res)) return
    // 与 PUT 同互斥:防删除的映射读改写与重命名迁移交叉,旧读写回会清掉迁移结果
    await serializedSoundWrite(async () => {
      const sounds = await listSounds()
      const sound = sounds.find((item) => item.id === id)
      if (!sound) {
        sendJson(res, 404, { error: '音效不存在' })
        return
      }
      await unlink(join(SOUNDS_DIR, id + '.' + sound.ext))
      // 被引用即回落:深合并语义下引用置 null 清除,resolveSound 兜底回内置默认
      const settings = ctx.get('settings')
      if (settings) {
        const current = readSettings(ctx)
        const patch = {}
        for (const key of Object.keys(current.soundMapping)) {
          if (current.soundMapping[key] === id) patch[key] = null
        }
        if (Object.keys(patch).length > 0) await settings.update(NAMESPACE, { soundMapping: patch })
      }
      sendJson(res, 200, { ok: true })
    })
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/mapping',
      handler: route('POST', { crossOrigin: true, json: true }, async (req, res) => {
        const body = JSON.parse((await readRawBody(req, REQUEST_BODY_MAX_BYTES)).toString('utf8'))
        const category = body && typeof body.category === 'string' ? body.category : ''
        const id = body && typeof body.id === 'string' ? body.id : ''
        if (CATEGORIES.indexOf(category) < 0) {
          sendJson(res, 400, { error: '未知分类: ' + category })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        // 校验到写回整段入互斥域:防与 DELETE 清引用并发时把已删音效的 id 写回映射;
        // settings.update 深合并无法删键,清除以 null 表达,读侧 resolvedConfig 过滤
        await serializedSoundWrite(async () => {
          if (!validateMappingId(id, (await listSounds()).map((sound) => sound.id))) {
            sendJson(res, 400, { error: '未知音效: ' + id })
            return
          }
          await settings.update(NAMESPACE, { soundMapping: { [category]: id.length === 0 ? null : id } })
          sendJson(res, 200, { ok: true, soundMapping: readSettings(ctx).soundMapping })
        })
      }),
    }), 'turn-notify mapping route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/config',
      // GET/POST 双方法且守卫差异在 POST 分支,不经单方法 route() 包装
      handler: async (req, res) => {
        // imAvailable 不进 core 纯函数,config 响应处合流;实时判定,无装载时序假设
        if (req.method === 'GET') {
          sendJson(res, 200, { ...publicConfig(readSettings(ctx)), imAvailable: imReady() })
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
          sendJson(res, 200, { ...publicConfig(readSettings(ctx)), imAvailable: imReady() })
        } catch (error) {
          sendError(res, error)
        }
      },
    }), 'turn-notify config route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/test-webhook',
      handler: route('POST', { crossOrigin: true }, async (req, res) => {
        // 等待投递完成,真实结果随响应返回,测试按钮不再谎报
        const result = await sendWebhook({ url: readSettings(ctx).webhookUrl, payload: buildWebhookPayload(buildTestUnit()) })
        sendJson(res, 200, result)
      }),
    }), 'turn-notify test-webhook route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/im-targets',
      handler: route('GET', {}, async (req, res) => {
        const dshIm = ctx.get('dshIm')
        if (dshIm === undefined) {
          sendJson(res, 503, { error: 'dsh-im 未安装' })
          return
        }
        const botId = new URL(req.url, 'http://localhost').searchParams.get('botId') || ''
        if (!isValidImBotId(botId)) {
          sendJson(res, 400, { error: 'botId 缺失或非法' })
          return
        }
        try {
          const targets = await dshIm.listTargets(botId)
          // route 为平台原生路由 ID,选择目标无需知道,不出主机
          sendJson(res, 200, { targets: targets.map(({ targetId, name, kind }) => ({ targetId, name, kind })) })
        } catch (error) {
          const code = error && error.code ? error.code : 'delivery-failed'
          sendJson(res, IM_ERROR_STATUS[code] ?? 502, { error: code })
        }
      }),
    }), 'turn-notify im-targets route')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/turn-notify/test-im',
      handler: route('POST', { crossOrigin: true }, async (req, res) => {
        const dshIm = ctx.get('dshIm')
        if (dshIm === undefined) {
          sendJson(res, 200, { ok: false, detail: 'dsh-im 未安装' })
          return
        }
        const targets = normalizeImTargets(readSettings(ctx).imTargets)
        if (targets.length === 0) {
          sendJson(res, 200, { ok: false, detail: '未配置投递目标' })
          return
        }
        // 逐目标结算,真实结果随响应返回,与 test-webhook 的不谎报原则一致
        const results = await Promise.all(targets.map(async ({ botId, targetId }) => {
          try {
            await dshIm.send(botId, targetId, buildTestUnit().text, { signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) })
            return { botId, targetId, ok: true, detail: 'sent' }
          } catch (error) {
            return { botId, targetId, ok: false, detail: error && error.code ? error.code : 'delivery-failed' }
          }
        }))
        sendJson(res, 200, { ok: results.every((item) => item.ok), results })
      }),
    }), 'turn-notify test-im route')
}
