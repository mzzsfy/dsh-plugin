// dsh-session-manager Host 半区:自动归档评估 + 取消归档 + 删除(回收站) + 已删除台账与重挂载。
// 评估由 session/created 事件触发;取消归档与删除后的归档清理经 workspace 域
// global 直写 archivedSessionIds 并同步注册表进程内快照(官方无 unarchive 表面,
// 域写入经 domain/changed 触发 workspace.follow 的 archived 帧);删除按失败矩阵
// 执行 locate → trash → detach → 归档清理,台账记录删除产物路径供回收站还原后
// 一键重挂载(官方 attachSession)。面板数据不在此处:client 侧以 session.list
// 行与归档集合做交集。

import { open, realpath, stat } from 'node:fs/promises'

import schemastery from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'

import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DELETE_CODES,
  artifactLooksBlank,
  deleteEligibility,
  deleteOutcome,
  isSessionRunning,
  mergeDeletedEntry,
  removeDeletedEntry,
  selectArchiveCandidates,
  updatedAtOf,
} from './core.mjs'
import { trashPath } from './trash.mjs'

export const name = 'dsh-session-manager'

export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'storageDomain']

const NAMESPACE = settingsNamespace('session-manager')
const WORKSPACE_DOMAIN_NAME = 'workspace'

// 已删除台账域:global 单列表,条目为回收站还原后重挂载所需的最小信息
const LEDGER_SPEC = defineDomain({
  name: 'session_manager',
  version: 1,
  tables: {},
  global: {
    schema: z.object({
      deleted: z.array(z.object({
        sessionId: z.string(),
        path: z.string(),
        deletedAt: z.number(),
      })),
    }),
    initial: { deleted: [] },
  },
})

const BLANK_PROBE_CHUNK_BYTES = 64 * 1024

const MESSAGES = {
  unsupportedBackend: '当前存储后端不支持按会话删除',
  notArchived: '仅已归档会话可删除',
  unknownSession: '会话不存在',
  running: '运行中的会话不可删除',
  trashFailed: '移入回收站失败',
  partial: '已移入回收站,但移除列表记录失败',
  archiveCleanup: '已移入回收站,但移除归档记录失败',
  ledgerFailed: '已移入回收站,但重挂载记录失败',
  notRestored: '会话产物不在持久层,请先到系统回收站还原后重试',
  noWorkspace: '未找到会话所属工作区,无法重新挂载',
  ledgerCleanup: '已重新挂载,但清除台账记录失败;可在「已删除」区移除记录收尾',
  ledgerSuffix: ',且重挂载记录失败',
}

// trash 执行器出口:进程级唯一 OS 副作用注入点,测试经此桩替
export const executor = { trashPath }

const SETTINGS_SCHEMA = schemastery.object({
  autoArchiveDays: schemastery.number().min(0).step(1).default(DEFAULT_AUTO_ARCHIVE_DAYS)
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

function rejectMethod(req, res, method) {
  if (req.method === method) return true
  sendJson(res, 405, { error: 'method not allowed' })
  return false
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  let evaluating = false

  // 台账域:应用装载即打开,路由内 await;打开失败由路由响应,此处仅防未处理拒绝
  const ledgerReady = ctx.storageDomain.open(LEDGER_SPEC)
  ledgerReady.catch(() => {})
  ctx.effect(() => () => {
    void ledgerReady.then((domain) => domain.close()).catch(() => {})
  }, 'session-manager ledger domain')

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

  // 台账记账:trash 成功即记录,路径为回收站「原位置」还原所需
  async function recordDeletedEntry(sessionId, path) {
    const ledger = await ledgerReady
    const current = ledger.global.get()
    await ledger.global.set({
      ...current,
      deleted: mergeDeletedEntry(current.deleted, { sessionId, path, deletedAt: Date.now() }),
    })
  }

  // 台账移除:幂等,未命中不产生写回
  async function removeLedgerEntry(sessionId) {
    const ledger = await ledgerReady
    const current = ledger.global.get()
    const { deleted, removed } = removeDeletedEntry(current.deleted, sessionId)
    if (removed) await ledger.global.set({ ...current, deleted })
  }

  const routes = [
    {
      path: '/api/session-manager/unarchive',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
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
        if (!rejectMethod(req, res, 'POST')) return
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
        if (!rejectMethod(req, res, 'POST')) return
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
            await executor.trashPath(location.path)
          } catch (error) {
            trashError = error
          }
          const outcome = deleteOutcome({ located: true, trashError })
          if (outcome.code === DELETE_CODES.TRASH_FAILED) {
            sendJson(res, 400, { error: MESSAGES.trashFailed + ': ' + String(outcome.error) })
            return
          }
          // 台账在 trash 成功后立即记录:产物已进回收站,后续任何半失败都不影响还原资格;
          // 台账失败只降级重挂载便利,不回滚删除
          let ledgerError
          try {
            await recordDeletedEntry(sessionId, location.path)
          } catch (error) {
            ledgerError = error
          }
          const ledgerFailedSuffix = ledgerError !== undefined ? MESSAGES.ledgerSuffix : ''
          const detachError = await detachSession(ctx, sessionId)
          if (detachError !== undefined) {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.partial + ledgerFailedSuffix })
            return
          }
          // 归档集合同步清理:残留 id 会让面板行持续可见;detach 失败时不清理,
          // 保留归档资格供重试
          try {
            await removeArchivedId(sessionId)
          } catch {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.archiveCleanup + ledgerFailedSuffix })
            return
          }
          if (ledgerError !== undefined) {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.ledgerFailed })
            return
          }
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/session-manager/deleted',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'GET')) return
        try {
          const ledger = await ledgerReady
          sendJson(res, 200, { deleted: ledger.global.get().deleted })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/session-manager/remount',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const sessionId = await requireSessionId(req)
          // 产物还原的判定即持久层能重新读到 header:未还原时在此拒绝
          const header = await findHeader(ctx, sessionId)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.notRestored })
            return
          }
          const workspace = await findWorkspaceByCwd(ctx, header.cwd)
          if (workspace === undefined) {
            sendJson(res, 400, { error: MESSAGES.noWorkspace })
            return
          }
          // 官方挂载通道:自带 header cwd 校验,失败即整体拒绝,台账保留供重试
          await workspace.attachSession(sessionId)
          // 挂载已成功:台账清除失败只影响收尾,不得报成挂载失败
          try {
            await removeLedgerEntry(sessionId)
          } catch {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.ledgerCleanup })
            return
          }
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/session-manager/forget',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          await removeLedgerEntry(await requireSessionId(req))
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

// win32 路径大小写不敏感:realpath 已规范大小写,但比对侧可能存在大小写漂移
function samePath(left, right) {
  if (left === right) return true
  return process.platform === 'win32' && String(left).toLowerCase() === String(right).toLowerCase()
}

// 按会话 cwd 找归属工作区:cwd 不可解析(目录已移除)时退回原值比对,
// 最终归属校验仍由官方 attachSession 完成
async function findWorkspaceByCwd(ctx, cwd) {
  if (cwd === undefined) return undefined
  let resolved = cwd
  try {
    resolved = await realpath(cwd)
  } catch {
    // 目录不存在时按原值比对
  }
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (samePath(workspace.path, resolved)) return workspace
  }
  return undefined
}
