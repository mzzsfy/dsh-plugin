// dsh-session-manager Host 半区:自动归档评估 + 取消归档 + 删除(回收站)。
// 评估由 session/created 事件触发;取消归档与删除后的归档清理经 workspace 域
// global 直写 archivedSessionIds 并同步注册表进程内快照(官方无 unarchive 表面,
// 域写入经 domain/changed 触发 workspace.follow 的 archived 帧);删除按失败矩阵
// 执行 locate → trash → detach → 归档清理。面板数据不在此处:client 侧以
// session.list 行与归档集合做交集。

import { open, stat } from 'node:fs/promises'

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DELETE_CODES,
  artifactLooksBlank,
  deleteEligibility,
  deleteOutcome,
  isSessionRunning,
  selectArchiveCandidates,
  updatedAtOf,
} from './core.mjs'
import { trashPath } from './trash.mjs'

export const name = 'dsh-session-manager'

export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'storageDomain']

const NAMESPACE = settingsNamespace('session-manager')
const WORKSPACE_DOMAIN_NAME = 'workspace'

const BLANK_PROBE_CHUNK_BYTES = 64 * 1024

const MESSAGES = {
  unsupportedBackend: '当前存储后端不支持按会话删除',
  notArchived: '仅已归档会话可删除',
  unknownSession: '会话不存在',
  running: '运行中的会话不可删除',
  trashFailed: '移入回收站失败',
  partial: '已移入回收站,但移除列表记录失败',
  archiveCleanup: '已移入回收站,但移除归档记录失败',
}

const SETTINGS_SCHEMA = z.object({
  autoArchiveDays: z.number().min(0).step(1).default(DEFAULT_AUTO_ARCHIVE_DAYS)
    .description('自动归档阈值天数,0 表示关闭;新会话创建时评估'),
})

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readSettings(ctx) {
  const settings = ctx.get('settings')
  const value = settings ? settings.get(NAMESPACE) : undefined
  const days = Number(value && value.autoArchiveDays)
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_AUTO_ARCHIVE_DAYS
}

function readBody(req) {
  const BODY_MAX_BYTES = 64 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function requireSessionId(req) {
  const body = JSON.parse(await readBody(req))
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId.length === 0) throw new Error('sessionId 不能为空')
  return sessionId
}

/** JSONL 产物空白探测:读文件头部,不足两行即视为空白会话。 */
async function artifactIsBlank(path) {
  let handle
  try {
    handle = await open(path, 'r')
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(BLANK_PROBE_CHUNK_BYTES), 0, BLANK_PROBE_CHUNK_BYTES, 0)
    const headText = buffer.toString('utf8', 0, bytesRead)
    return artifactLooksBlank(headText, bytesRead === BLANK_PROBE_CHUNK_BYTES)
  } catch {
    // 产物不可读(已被移走等)时按非空白处理,宁可漏归档不可误归档
    return false
  } finally {
    if (handle !== undefined) await handle.close()
  }
}

function rejectNonPost(req, res) {
  if (req.method === 'POST') return true
  sendJson(res, 405, { error: 'method not allowed' })
  return false
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  let evaluating = false

  // 自动归档评估:session/created 触发,按创建会话的工作区限定候选集
  ctx.on('session/created', (session) => {
    const days = readSettings(ctx)
    if (days === 0 || evaluating) return
    evaluating = true
    void (async () => {
      const cwd = session.header && session.header.cwd
      if (cwd === undefined) return
      const registry = ctx.workspaceRegistry
      const archived = new Set(registry.archivedSessionIds.map(String))
      const records = await ctx.sessionQuery.listSessions()
      const nowMs = Date.now()
      const candidates = []
      for (const recordItem of records) {
        const header = recordItem.header
        if (header.cwd !== cwd) continue
        const live = ctx.get('sessions') && ctx.get('sessions').get(header.id)
        const running = isSessionRunning({ agents: ctx.get('agents'), sessionId: header.id })
        const located = ctx.get('sessionPersistence') && ctx.get('sessionPersistence').locate(header)
        const activityAt = located && await safeMtime(located.path)
        // 产物不可读视为已删除,不参与归档:否则删除后的会话(重连前仍在持久层
        // 列表中)会因超期被重新归档,面板行复活且无法再删
        if (located && activityAt === 0) continue
        const blank = live ? live.seq === 0 : Boolean(located && await artifactIsBlank(located.path))
        candidates.push({
          id: String(header.id),
          archived: archived.has(String(header.id)),
          running,
          blank,
          updatedAt: updatedAtOf(header, activityAt),
        })
      }
      for (const id of selectArchiveCandidates({ records: candidates, nowMs, thresholdDays: days })) {
        await registry.archiveSession(id)
      }
    })().catch((error) => {
      ctx.logger && ctx.logger.warn('session-manager 自动归档评估失败: ' + String(error))
    }).finally(() => {
      evaluating = false
    })
  })

  // 取消归档:直写 workspace 域 global,无官方 API 可用。注册表把域 global 快照到
  // 进程内 state 且只在自身写路径同步,直写后必须把快照一并改掉:否则注册表后续
  // 全量写回(含自动归档)与 workspace.list 重连基线都会复活该 id,官方归档的幂等
  // 判定也会因旧快照静默跳过。合并 durable 与快照再移除,可自愈历史失同步与清理
  // 半失败(经取消归档重试即补全),代价是快照中的陈旧 id 会随任一次清理重新落盘,
  // 可经再次取消归档清除。inject 保证注册表就绪,快照缺失即上游形态变更,loud fail;
  // 域 global 仅支持整体写回,读改写窗口若与注册表两阶段变更交错,理论上可回退其
  // pendingMutation/workspaceIds 中间态,下次启动 validateStoredState 将 loud fail,
  // 窗口极窄且域 API 无原子原语可用,属已知取舍(详见 README)。
  async function removeArchivedId(sessionId) {
    const domain = ctx.storageDomain.get(WORKSPACE_DOMAIN_NAME)
    if (domain === undefined) throw new Error('workspace 域未打开')
    const durable = domain.global.get()
    const cached = ctx.workspaceRegistry.state
    if (cached === undefined) throw new Error('workspace 注册表快照不可用')
    const merged = new Set(durable.archivedSessionIds.map(String))
    for (const id of cached.archivedSessionIds) merged.add(String(id))
    if (!merged.delete(String(sessionId))) return
    const next = { ...durable, archivedSessionIds: [...merged] }
    await domain.global.set(next)
    ctx.workspaceRegistry.state = next
  }

  const routes = [
    {
      path: '/api/session-manager/unarchive',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        try {
          await removeArchivedId(await requireSessionId(req))
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/session-manager/info',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        try {
          const sessionId = await requireSessionId(req)
          const header = await findHeader(ctx, sessionId)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          const persistence = ctx.get('sessionPersistence')
          const location = persistence ? persistence.locate(header) : undefined
          if (location === undefined) {
            sendJson(res, 200, { supported: false })
            return
          }
          const info = await stat(location.path)
          sendJson(res, 200, { supported: true, sizeBytes: info.size })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/session-manager/delete',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        try {
          const sessionId = await requireSessionId(req)
          // host 端到端权威:归档资格与 locate 在执行前各校验一次
          const eligibility = deleteEligibility({
            archivedIds: ctx.workspaceRegistry.archivedSessionIds.map(String),
            sessionId,
          })
          if (!eligibility.ok) {
            sendJson(res, 400, { error: MESSAGES.notArchived })
            return
          }
          const header = await findHeader(ctx, sessionId)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          // 运行中守卫:与归档评估同款判据,落实"运行中会话永不被删除"不变量
          if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
            sendJson(res, 400, { error: MESSAGES.running })
            return
          }
          const persistence = ctx.get('sessionPersistence')
          const location = persistence ? persistence.locate(header) : undefined
          if (location === undefined) {
            sendJson(res, 400, { error: MESSAGES.unsupportedBackend })
            return
          }
          let trashError
          try {
            await trashPath(location.path)
          } catch (error) {
            trashError = error
          }
          const outcome = deleteOutcome({ located: true, trashError })
          if (outcome.code === DELETE_CODES.TRASH_FAILED) {
            sendJson(res, 400, { error: MESSAGES.trashFailed + ': ' + String(outcome.error) })
            return
          }
          const detachError = await detachSession(ctx, sessionId)
          if (detachError !== undefined) {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.partial })
            return
          }
          // 归档集合同步清理:残留 id 会让面板行持续可见;detach 失败时不清理,
          // 保留归档资格供重试
          try {
            await removeArchivedId(sessionId)
          } catch {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.archiveCleanup })
            return
          }
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-session-manager ' + route.path)
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: config })
  })
}

// 产物缺失时按无活跃处理,不阻断整轮评估
async function safeMtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function findHeader(ctx, sessionId) {
  const records = await ctx.sessionQuery.listSessions()
  const found = records.find((recordItem) => String(recordItem.header.id) === sessionId)
  return found ? found.header : undefined
}

// detach 幂等:遍历全部工作区逐个移除,不因首个工作区操作失败提前终止
async function detachSession(ctx, sessionId) {
  const errors = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!workspace.sessionIds.some((id) => String(id) === sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors[0]
}
