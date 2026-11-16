// dsh-session-manager Host 半区:自动归档评估 + 取消归档 + 删除(回收站) + 已删除台账与重挂载。
// 评估三触发源共用同一门闩:新会话创建(session/created,按工作区限定)、settings 就绪后的
// 启动补扫(全量)、每日周期轮(全量,经宿主 timer 软依赖);取消归档与删除后的归档清理经
// 官方 workspaceRegistry.unarchiveSession(0.2.1-rc.2 起);删除按失败矩阵
// 执行链路:公共 stat 快照定位 → trash → detach → 归档清理,台账记录删除产物路径供回收站还原后
// 一键重挂载(官方 attachSession)。面板数据不在此处:client 侧以 session.list
// 行与归档集合做交集。

import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import * as nodeZlib from 'node:zlib'

import schemastery from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'

import {
  DAY_MS,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS,
  activeUnarchiveGraces,
  aggregateDeleteOutcome,
  artifactLooksBlank,
  deleteEligibility,
  isDerivedSessionHeader,
  isSessionRunning,
  mergeDeletedEntry,
  mergeOutcomeMessages,
  removeDeletedEntry,
  selectArchiveCandidates,
  unarchiveGraceActive,
  updatedAtOf,
} from './core.mjs'
import { moveToQuarantine, restoreFromQuarantine, trashPath } from './trash.mjs'
import { withRouteGate } from './route-gate.mjs'

export const name = 'dsh-session-manager'

export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'storageDomain', 'agents', 'sessions', 'sessionPersistence']

const NAMESPACE = 'session-manager'

// 已删除台账域:global 单列表,条目为回收站还原后重挂载所需的最小信息;
// heldPath 仅回收区降级条目携带(暂存路径,重挂载时移回 path 原位置)
const LEDGER_SPEC = defineDomain({
  name: 'session_manager',
  version: 1,
  tables: {},
  global: {
    schema: z.object({
      deleted: z.array(z.object({
        sessionId: z.string(),
        path: z.string(),
        heldPath: z.string().optional(),
        deletedAt: z.number(),
      })),
    }),
    initial: { deleted: [] },
  },
})

const BLANK_PROBE_CHUNK_BYTES = 64 * 1024
// 台账条目上限:超过即裁掉最旧条目(数组头部为新,尾部最旧),防无界增长写放大
const LEDGER_MAX_ENTRIES = 200
// 自动归档评估整体超时:超时只标记中止后续归档,门闩等 work 真正收尾后释放
const EVALUATION_TIMEOUT_MS = 30 * 1000
// 宽限年龄用单调时钟:墙钟回拨/前跳不改变会话恢复保护窗口
function monotonicNow() {
  return performance.now()
}
const HOUR_MS = 60 * 60 * 1000
// 周期评估固定短 tick:tick 内做到期判断,间隔设置变更自下一周期生效
const PERIODIC_TICK_MS = 60 * 1000
// 台账单次读改写超时:宿主存储域挂起时调用方按失败降级,不把删除路由挂死
const LEDGER_OP_TIMEOUT_MS = 10 * 1000
// 台账互斥链逃生阈值:超时 job 仍在写时链条继续等它真实落定(否则旧快照写回会整表
// 覆盖新条目);只有存储域彻底挂死才按该阈值放行链条,防台账永久冻结
const LEDGER_CHAIN_ESCAPE_MS = 60 * 1000
// 归档行批量大小查询:单次请求上限(前端按同批大小分批),并发上限为宿主 IO 压力与聚合等待的折中
export const SIZES_MAX_IDS = 500
const SIZES_CONCURRENCY = 8

// 台账时序参数的测试注入口:生产恒为上方常量,测试注入缩短值以覆盖超时/迟到写路径
export const ledgerRuntime = {
  opTimeoutMs: LEDGER_OP_TIMEOUT_MS,
  chainEscapeMs: LEDGER_CHAIN_ESCAPE_MS,
}
// 自动归档评估超时的测试注入口:生产恒为上方常量,测试注入短阈值验证中止/门闩
export const evaluationRuntime = {
  timeoutMs: EVALUATION_TIMEOUT_MS,
}

// 路由响应文案;导出供测试断言与实现同步。
// trash 半失败聚合 5 条在 core.DELETE_MESSAGES(经 aggregateDeleteOutcome 组装),此处不重复
export const MESSAGES = {
  unsupportedBackend: '当前存储后端不支持按会话删除',
  notArchived: '仅已归档会话可删除',
  archiveRevoked: '会话已恢复为未归档状态,删除已中止,请刷新面板后重试',
  unknownSession: '会话不存在',
  derivedSession: '子 agent 会话不参与会话管理',
  descendantRunning: '子会话运行中,不能删除父会话',
  cascadeScanFailed: '读取子会话清单失败,已中止删除',
  running: '运行中的会话不可删除',
  trashFailed: '移入回收站失败',
  notRestored: '会话产物不在持久层,请先到系统回收站还原后重试',
  ghostCleanup: '产物已不存在,已完成列表清理',
  ghostDetach: '产物已不存在,但移除列表记录失败',
  ghostArchiveSuffix: ',且移除归档记录失败',
  cascadeDetach: '产物已回收,但移除列表记录失败',
  noWorkspace: '未找到会话所属工作区,无法重新挂载',
  ledgerCleanup: '已重新挂载,但清除台账记录失败;可在「已删除」区移除记录收尾',
  inFlight: '该会话正在删除中,请稍后重试',
  badJsonBody: '请求体不是合法 JSON',
  systemError: '操作失败(系统级错误,详见服务端日志)',
  heldMissing: '回收区暂存已缺失,原位置亦无产物,无法找回',
  restoreFailed: '回收区还原失败',
}

// trash 执行器出口:进程级唯一 OS 副作用注入点(回收站/回收区搬移/移回),测试经此桩替
export const executor = { trashPath, moveToQuarantine, restoreFromQuarantine }

const SETTINGS_SCHEMA = schemastery.object({
  autoArchiveDays: schemastery.number().min(0).step(1).default(DEFAULT_AUTO_ARCHIVE_DAYS)
    .description('自动归档阈值天数,0 表示关闭;新会话创建、启动与周期评估时生效'),
  autoArchiveIntervalHours: schemastery.number().min(0).step(1).default(DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS)
    .description('周期评估间隔小时数,0 表示关闭周期评估;变更经周期 tick 对账,关闭即时暂停、重启用最迟下个 tick 生效'),
})

// 0.1.7 宿主以静态 Config 导出生成设置节表单(maintain 同构);legacy 宿主经
// settings.register 注册同名命名空间。根级 volatile 包装:0.1.7 下整节为 live
// 表单,节写经 loader 原地热更;旧宿主 schemastery 无 volatile 方法,特性检测原样返回
export const Config = volatileWrap(SETTINGS_SCHEMA)

function volatileWrap(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

// volatile ref 动态解包(get 协议):0.1.7 下 apply 入参 config 为整节单 ref;
// legacy 宿主 config 为普通对象原样透传
function unwrapVolatile(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 错误响应出口:业务错误(Error 无错误码)原样透传消息;系统级错误(带 fs 错误码,
// message 内嵌绝对路径)收敛为固定文案,原始错误仅进服务端日志。协议层错误自带
// statusCode(413 超限 / 408 超时 / 400 中止)必须原样透出,不得一律降级成 400
function respondError(ctx, res, error) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && ctx.logger) ctx.logger.warn('session-manager 系统级错误: ' + String(error && error.stack || error))
  const message = isSystem
    ? MESSAGES.systemError
    : (error && error.message ? error.message : String(error))
  const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 400
  sendJson(res, status, { error: message })
}

function readSettings(ctx, config) {
  const settings = ctx.get('settings')
  // 双形读(maintain 同构):legacy settings 命名空间 get;0.1.7+ apply 入参
  // config 整节解包。方法面守卫兼防:服务在但缺 get(宿主升级变更面)时回落默认值,
  // 防 timer 回调抛错崩进程
  const value = settings && typeof settings.get === 'function' ? settings.get(NAMESPACE) : unwrapVolatile(config)
  const days = Number(value && value.autoArchiveDays)
  const hours = Number(value && value.autoArchiveIntervalHours)
  return {
    days: Number.isInteger(days) && days >= 0 ? days : DEFAULT_AUTO_ARCHIVE_DAYS,
    intervalHours: Number.isInteger(hours) && hours >= 0 ? hours : DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS,
  }
}

// auto-archive 路由请求体 → settings patch:仅接受出现且为非负整数的字段(部分更新),
// 一个合法字段都没有即拒绝;返回形态错误以业务错误抛出,由路由统一转 400
const AUTO_ARCHIVE_FIELDS = [['days', 'autoArchiveDays'], ['intervalHours', 'autoArchiveIntervalHours']]

function readAutoArchivePatch(body) {
  const patch = {}
  for (const [input, setting] of AUTO_ARCHIVE_FIELDS) {
    const raw = body ? body[input] : undefined
    if (raw === undefined) continue
    if (!Number.isInteger(raw) || raw < 0) throw new Error('自动归档配置须为非负整数: ' + input)
    patch[setting] = raw
  }
  if (Object.keys(patch).length === 0) throw new Error('缺少可更新的配置字段')
  return patch
}

// settings 双形写(maintain 同构,判定延迟到使用点):legacy 方法面以 register 为准
// (0.1.7 的 settings.update 名义在场但按命名空间找条目必败,不可作判据);
// 0.1.7+ 走 configEditor.edit 落 profile 条目(fiber.entry,与命名空间解耦)
async function persistSettings(ctx, patch) {
  const settings = ctx.get('settings')
  if (typeof settings?.register === 'function' && typeof settings?.update === 'function') {
    await settings.update(NAMESPACE, patch)
    return
  }
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (!editor || typeof editor.edit !== 'function' || !entry) throw new Error('宿主设置服务不可用')
  await editor.edit(entry, (current) => ({ ...current, ...patch }))
}

const BODY_MAX_BYTES = 64 * 1024
// 请求体读取时限:半开连接不得永久占住 handler
export const BODY_READ_TIMEOUT_MS = 30 * 1000

function requestAbortedError() {
  const error = new Error('请求已中止')
  error.statusCode = 400
  return error
}

// 请求体读取:data/end 正常路径之外监听 aborted/close/error 与总时限;超限不销毁
// socket(销毁会让 413 响应送不出),暂停读取后由路由回错误响应。与
// dsh-context-manager 同构(P2-33),修改需两处同步
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks = []
    const finish = (settler, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      req.off?.('aborted', onAborted)
      req.off?.('close', onClose)
      settler(value)
    }
    const onData = (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        chunks.length = 0
        const error = new Error('请求体超过上限')
        error.statusCode = 413
        req.pause?.()
        finish(reject, error)
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'))
    const onError = (error) => finish(reject, error)
    const onAborted = () => finish(reject, requestAbortedError())
    // close 在正常 end 后也会触发;只有未 complete 才是客户端中途断开
    const onClose = () => {
      if (!req.complete) finish(reject, requestAbortedError())
    }
    const timer = setTimeout(() => {
      const error = new Error('请求体读取超时')
      error.statusCode = 408
      finish(reject, error)
    }, BODY_READ_TIMEOUT_MS)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
  })
}

// 协议错误(读体超限/超时/中止)自带 statusCode,必须原样上抛;只有 JSON 解析失败
// 才收敛为固定业务文案,不透出引擎 SyntaxError
async function readJsonBody(req) {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(MESSAGES.badJsonBody)
  }
}

async function requireSessionId(req) {
  const body = await readJsonBody(req)
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId.length === 0) throw new Error('sessionId 不能为空')
  return sessionId
}

// zstd 帧魔数(小端):宿主 0.2.x 默认压缩产物,直接读压缩字节会在随机数据里
// 数出换行,把空白会话误判成非空白(实测 508 条中 495 条误判)
const ZSTD_MAGIC = 0xfd2fb528

function isZstdFrame(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
}

// 截断前缀帧解压:ZSTD_e_flush 让解码器吐出已完整块的明文、不要求尾部校验和。
// 宿主产物是「每行一个独立帧」的拼接流,而 Node 的解压器只处理首帧,必须自行
// 按帧边界循环(否则任何会话都只看到 header 一行、被判空白)。运行时不支持
// zstd(旧 Node)或帧损坏时返回 null,由调用方退回事件数
function zstdFrameEnd(buffer, offset) {
  if (offset + 5 > buffer.length || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return -1
  let at = offset + 4
  const descriptor = buffer[at]
  at += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (singleSegment === 0) at += 1
  at += [0, 1, 2, 4][dictionaryFlag]
  if (contentSizeFlag === 0) {
    if (singleSegment === 1) at += 1
  } else {
    at += [0, 2, 4, 8][contentSizeFlag]
  }
  if (at > buffer.length) return -1
  for (;;) {
    if (at + 3 > buffer.length) return -1
    const header = buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16)
    at += 3
    if (((header >> 1) & 3) === 3) return -1
    at += ((header >> 1) & 3) === 1 ? 1 : header >>> 3
    if (at > buffer.length) return -1
    if ((header & 1) === 1) break
  }
  if (checksum === 1) at += 4
  return at > buffer.length ? -1 : at
}

function decodeZstdPrefix(buffer) {
  const decompress = nodeZlib.zstdDecompressSync
  if (typeof decompress !== 'function') return null
  const chunks = []
  let breaks = 0
  let offset = 0
  try {
    while (offset < buffer.length) {
      const end = zstdFrameEnd(buffer, offset)
      // 前缀可能截断最后一帧:交给 flush 解出已完整块
      const frame = buffer.subarray(offset, end === -1 ? buffer.length : end)
      const text = decompress(frame, { finishFlush: nodeZlib.constants.ZSTD_e_flush }).toString('utf8')
      chunks.push(text)
      for (const char of text) {
        if (char === '\n') breaks += 1
        // 两行即足以判非空白,不必解完整份前缀
        if (breaks >= 2) return chunks.join('')
      }
      if (end === -1) break
      offset = end
    }
    return chunks.join('')
  } catch {
    return null
  }
}

/**
 * 产物空白探测:读文件头部并按产物编码解码——zstd 产物先解压再按行判定,
 * 解压不可用/失败时退回事件数(readSession 的 events 长度);两者都不可得按
 * 非空白处理(宁可漏归档不可误归档)。live 会话不走此处(seq=0 直接判定)。
 * @param path - 会话产物文件路径
 * @param readEventCount - 事件数兜底读取器,返回该会话事件总数
 */
async function artifactIsBlank(path, readEventCount) {
  let handle
  try {
    handle = await open(path, 'r')
    const { buffer, bytesRead } = await handle.read(
      Buffer.allocUnsafe(BLANK_PROBE_CHUNK_BYTES), 0, BLANK_PROBE_CHUNK_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    const hasMore = bytesRead === BLANK_PROBE_CHUNK_BYTES
    const text = isZstdFrame(head) ? decodeZstdPrefix(head) : head.toString('utf8')
    if (text !== null) return artifactLooksBlank(text, hasMore)
  } catch {
    // 产物不可读(已被移走等)时按非空白处理
    return false
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
  if (typeof readEventCount === 'function') {
    try {
      const count = await readEventCount()
      if (Number.isInteger(count)) return count === 0
    } catch {
      // 事件读取失败同按非空白
    }
  }
  return false
}

function rejectMethod(req, res, method) {
  if (req.method === method) return true
  sendJson(res, 405, { error: 'method not allowed' })
  return false
}

// 写路由守卫(宿主闸门 → Origin↔Host 同源 → JSON content-type)由共享
// route-gate 的 withRouteGate 统一提供:同源比对大小写不敏感、content-type 按
// essence 精确比较,缺 content-type 一律 400(与全仓其余写路由同口径)。
// 本地不再保留 415/缺头放行的分叉实现

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  let evaluating = false
  let disposed = false
  let activeEvaluation
  let evaluationGeneration = 0
  // 取消归档宽限表(会话 id → 恢复时刻,仅进程内,重启失效可接受):恢复该会话到
  // 用户发出首条消息之间的评估窗口保护,首条消息更新产物 mtime 后由阈值自然接管。
  // 按会话记账:恢复 A 不得顺带保护同期超期的 B
  const unarchiveGraceBySession = new Map()
  // 清理路径发起的 unarchive(删除收尾/幽灵清理/级联/启动自愈)与用户恢复共用宿主事件:
  // 清理期间按会话抑制事件记账,避免把内部清理误记为用户恢复;并发的外部恢复不受影响。
  const unarchiveCleanupIds = new Set()
  // 无事件宿主补记宽限:上一轮评估看到的归档集合。评估轮次对比集合移除补记用户恢复;
  // 内部清理实际移除时同步从该基线剔除,避免把清理误当恢复。
  let previousArchivedIds
  // 删除路由同 id 并发去重(进程内)
  const inFlightDeletes = new Set()

  // 插件回收区:系统回收站不可用环境的删除降级暂存地,重挂载时移回原位置。
  // 测试经 env DSH_QUARANTINE_DIR 注入临时目录;缺省从宿主 home 派生(DSH_HOME 即 .dsh 根)
  const quarantineDir = process.env.DSH_QUARANTINE_DIR
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'trash', 'session-manager')

  // header 查找缓存:归档/删除/重挂载路由共用(inputs 浮层已迁 dsh-context-manager)
  const headerCache = new Map()
  ctx.effect(() => () => headerCache.clear(), 'session-manager header cache')
  // 插件卸载:中止在途自动归档评估,后续 await 返回时不得再触发 archiveSession
  ctx.effect(() => () => {
    disposed = true
    if (activeEvaluation !== undefined) activeEvaluation.aborted = true
  }, 'session-manager evaluation abort')

  // 台账域:应用装载即打开,路由内 await;打开失败由路由响应,此处仅防未处理拒绝
  const ledgerReady = ctx.storageDomain.open(LEDGER_SPEC)
  ledgerReady.catch(() => {})
  ctx.effect(() => () => {
    void ledgerReady.then((domain) => domain.close()).catch(() => {})
  }, 'session-manager ledger domain')

  // 周期评估状态:running 供设置页降级提示;timer 为软依赖,服务缺失不阻塞插件装载
  const periodic = { running: false, reason: '' }

  // 归档集合可能残留子会话 id(历史版本把子会话当用户会话归档):启动清一次。
  // 只处理列表里仍有 header 且判为派生的 id;已删除/未知 id 留给宿主集合自然淘汰,
  // 不凭集合里的 id 直接做归属写入。失败单项不中断,下轮启动重试。
  async function healDerivedArchived() {
    let registry
    let ids
    try {
      registry = ctx.workspaceRegistry
      if (!registry || typeof registry.unarchiveSession !== 'function') return
      ids = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : []
    } catch (error) {
      // registry 未启动时 getter 抛错:本轮跳过,下次启动重试
      ctx.logger && ctx.logger.warn('session-manager 归档集合自愈读取注册表失败: ' + String(error))
      return
    }
    if (ids.length === 0) return
    let records
    try {
      records = await ctx.sessionQuery.listSessions()
    } catch (error) {
      ctx.logger && ctx.logger.warn('session-manager 归档集合自愈读取会话失败: ' + String(error))
      return
    }
    const headers = new Map(records.map((recordItem) => [String(recordItem.header.id), recordItem.header]))
    for (const id of ids) {
      const header = headers.get(id)
      if (header === undefined || !isDerivedSessionHeader(header)) continue
      try {
        await removeArchivedId(id)
        ctx.logger && ctx.logger.info && ctx.logger.info('session-manager 已清理归档集合中的子会话: ' + id)
      } catch (error) {
        ctx.logger && ctx.logger.warn('session-manager 清理归档子会话 ' + id + ' 失败: ' + String(error))
      }
    }
  }

  // 自动归档评估:筛出待归档会话并逐个走官方 archiveSession。cwd 缺省时全量评估
  // (启动补扫 / 周期轮),传入 cwd 时仅评估该工作区(新建会话触发)。
  // 门闩与超时守卫对全部触发源生效。两级筛选:先用 createdAt 纯内存预筛(mtime 只会
  // 增大 updatedAt,createdAt 未超期必不超期),仅对预筛存活者做产物 stat/blank 探测,
  // 活跃会话零 IO。返回是否真正启动:被门闩/关闭挡下的调用方(周期 tick)保持到期态
  // 由下个 tick 重试,不得据此重排周期
  function evaluateArchives(cwd) {
    const { days } = readSettings(ctx, config)
    if (disposed || days === 0 || evaluating) return false
    evaluating = true
    // 代际令牌:卸载与超时只标记当前代中止;每个 await 返回后核验,旧代不得再归档
    const evaluation = { generation: ++evaluationGeneration, aborted: false }
    activeEvaluation = evaluation
    const evaluationTimeoutMs = evaluationRuntime.timeoutMs
    const current = () => !disposed && activeEvaluation === evaluation && !evaluation.aborted
    const work = (async () => {
      if (!current()) return
      const registry = ctx.workspaceRegistry
      const archived = new Set(registry.archivedSessionIds.map(String))
      // 无事件宿主:本轮开始前对比归档集合移除,先把用户原生恢复补记为宽限
      reconcileArchivedRemovals(archived)
      const sessionsService = ctx.get('sessions')
      const agents = ctx.get('agents')
      const persistence = ctx.get('sessionPersistence')
      const records = await ctx.sessionQuery.listSessions()
      if (!current()) return
      const artifactMap = await listArtifactMap(persistence)
      if (!current()) return
      const nowMs = Date.now()
      const graceNowMs = monotonicNow()
      // 宽限表顺轮清理过期项(表随恢复动作增长,过期条目不再有意义)
      pruneUnarchiveGrace(graceNowMs)
      const cutoff = nowMs - days * DAY_MS
      const candidates = []
      // 单会话探测异常(后端 stat 抛错等)只跳过该会话:一个坏记录不得拖垮整轮,
      // 否则同批健康会话也永不归档。失败逐条 warn + 轮末计数汇总,保证可观测
      let probeFailed = 0
      for (const recordItem of records) {
        if (!current()) return
        const header = recordItem && recordItem.header
        try {
          if (header === undefined) throw new Error('listSessions 记录缺少 header')
          if (cwd !== undefined && header.cwd !== cwd) continue
          // subagent 内部会话不属主列表(官方 sessionVisible 以 origin 排除),归档集合
          // 仅服务用户会话:误归档只产出不可辨认的面板行与无意义通知
          if (isDerivedSessionHeader(header)) continue
          // 预筛:createdAt 未超期必不超期(见上),跳过产物 IO
          if (header.createdAt >= cutoff) continue
          // 已归档记录永不是候选,集合随历史增长,提前跳过省产物 IO
          if (archived.has(String(header.id))) continue
          // 会话级宽限:只保护刚被恢复的那条,同轮其余超期会话照常归档
          if (unarchiveGraceActive(unarchiveGraceBySession.get(String(header.id)), graceNowMs)) continue
          const live = sessionsService && sessionsService.get(header.id)
          const running = isSessionRunning({ agents, sessionId: header.id })
          // 运行中永不入选归档,超期 running 在此早退免付产物 IO(64KB 读);
          // core.selectArchiveCandidates 的 !running 过滤保留作第二道防线
          if (running) continue
          const artifact = await resolveArtifact(persistence, header, artifactMap)
          if (!current()) return
          // 无观测能力(旧宿主)与产物不落盘同规跳过:仅凭 createdAt 判活跃会绕过
          // mtime 保护,与 delete 的 unsupportedBackend 拒绝口径对齐
          if (artifact === undefined || artifact.missing) continue
          const activityAt = await safeMtime(artifact.path)
          if (!current()) return
          // 产物不可读视为已删除,不参与归档:否则删除后的会话(重连前仍在持久层
          // 列表中)会因超期被重新归档,面板行复活且无法再删
          if (activityAt === null) continue
          // stat 后即可判活跃度:未超期不必做空白探测。冷会话按解码后文本判定;
          // 运行时无 zstd 能力时退回事件数(整份解码,正确性优先)
          const updatedAt = updatedAtOf(header, activityAt)
          if (updatedAt >= cutoff) continue
          const blank = live
            ? live.seq === 0
            : Boolean(await artifactIsBlank(artifact.path, async () => {
              const snapshot = await ctx.sessionQuery.readSession(header.id)
              return snapshot && Array.isArray(snapshot.events) ? snapshot.events.length : undefined
            }))
          if (!current()) return
          candidates.push({
            id: String(header.id),
            archived: false,
            running,
            blank,
            updatedAt,
          })
        } catch (error) {
          probeFailed += 1
          ctx.logger && ctx.logger.warn('session-manager 自动归档评估跳过会话(' + String(header && header.id || '<unknown>') + '): ' + String(error && error.stack || error))
        }
      }
      if (!current()) return
      if (probeFailed > 0) {
        ctx.logger && ctx.logger.warn('session-manager 自动归档评估: ' + probeFailed + ' 个会话探测失败已跳过,其余会话照常处理')
      }
      for (const id of selectArchiveCandidates({ records: candidates, nowMs, thresholdDays: days })) {
        if (!current()) return
        try {
          await registry.archiveSession(id)
        } catch (error) {
          // 单个归档失败不中断整轮,剩余候选继续;失败者由下一次触发重试
          ctx.logger && ctx.logger.warn('session-manager 归档 ' + id + ' 失败: ' + String(error))
          continue
        }
        if (!current()) return
        if (previousArchivedIds !== undefined) previousArchivedIds.add(id)
        ctx.logger && ctx.logger.info && ctx.logger.info('session-manager 已归档会话: ' + id)
      }
      if (!current()) return
      // 基线刷新到本轮结束时的事实:本轮新归档的会话若在下一轮前被原生恢复,
      // 下一轮对比仍能补记宽限;本轮期间发生的移除同样在收尾对比中补记
      reconcileArchivedRemovals(new Set(registry.archivedSessionIds.map(String)))
    })()
    // 超时先中止当前代,不提前复位门闩;宿主调用永不落定时由硬上界作废旧代,
    // 否则自动归档会永久停摆。旧代 current() 因 activeEvaluation 失配恒假。
    let hardGuard
    const timeoutGuard = setTimeout(() => {
      if (activeEvaluation !== evaluation) return
      evaluation.aborted = true
      ctx.logger && ctx.logger.warn('session-manager 自动归档评估超时,已停止后续归档;等待在途评估收尾')
      hardGuard = setTimeout(() => {
        if (activeEvaluation !== evaluation) return
        evaluation.aborted = true
        evaluationGeneration += 1
        activeEvaluation = undefined
        evaluating = false
        ctx.logger && ctx.logger.warn('session-manager 自动归档评估超过硬上界,作废旧代并释放门闩')
      }, evaluationTimeoutMs)
    }, evaluationTimeoutMs)
    void work.catch((error) => {
      if (activeEvaluation === evaluation) ctx.logger && ctx.logger.warn('session-manager 自动归档评估失败: ' + String(error))
    }).finally(() => {
      clearTimeout(timeoutGuard)
      if (hardGuard !== undefined) clearTimeout(hardGuard)
      // 仅当前代拥有门闩时才释放;硬上界作废旧代后不得清掉新代的门闩
      if (activeEvaluation === evaluation) {
        activeEvaluation = undefined
        evaluating = false
      }
    })
    return true
  }

  ctx.on('session/created', (session) => {
    const header = session.header
    // 子会话创建同样触发本事件:它们永不入选归档,不必触发全量评估
    if (header === undefined || isDerivedSessionHeader(header)) return
    const cwd = header.cwd
    if (cwd === undefined) return
    evaluateArchives(cwd)
  })

  // 取消归档:官方 workspaceRegistry.unarchiveSession(0.2.1-rc.2+ 串行实现,
  // 未归档 id 幂等不写)写穿 state,无私有直写的读改写窗口与快照失同步问题;
  // 合并自愈语义随私有写一并退役(开发守则:移除被宿主能力取代的实现)。
  // 本入口同时服务清理路径,事件记账按 id 抑制;用户取消归档路由在调用后显式记账。
  // 清理的实际移除同步剔除无事件宿主基线,集合差分不会把它误记为用户恢复。
  async function removeArchivedId(sessionId, { cleanup = true } = {}) {
    const sid = String(sessionId)
    const wasArchived = ctx.workspaceRegistry.archivedSessionIds.map(String).includes(sid)
    unarchiveCleanupIds.add(sid)
    try {
      await ctx.workspaceRegistry.unarchiveSession(sid)
    } finally {
      unarchiveCleanupIds.delete(sid)
    }
    if (cleanup && wasArchived && previousArchivedIds !== undefined) previousArchivedIds.delete(sid)
  }

  // 台账记账:trash 成功即记录,路径为回收站「原位置」还原所需。
  // ledgerChain 串行化所有读改写:get→set 交错时后写者会用旧快照整体覆盖,丢条目。
  // 调用方按 ledgerRuntime.opTimeoutMs 超时失败(路由不被挂死),但互斥链等 job 真实
  // 落定才放行下一个 —— 超时 job 仍在写时,后来的读改写不会与它的旧快照交错覆盖;
  // 存储域彻底挂死时按 chainEscapeMs 放行链条(迟到写可能与后续写交错,落 warn)
  let ledgerChain = Promise.resolve()

  function withTimeoutGuard(promise, timeoutMs, message) {
    let guard
    const timeout = new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(guard))
  }

  function withLedgerLock(job) {
    const run = ledgerChain.then(job, job)
    // 链尾等真实落定;逃生阈值到期才放行,防存储域永久挂起把台账冻死
    ledgerChain = new Promise((resolve) => {
      let escape
      const release = () => {
        clearTimeout(escape)
        resolve()
      }
      escape = setTimeout(() => {
        ctx.logger && ctx.logger.warn('session-manager 台账互斥链逃生:在途读改写超时未落定,迟到写可能与后续写交错')
        resolve()
      }, ledgerRuntime.chainEscapeMs)
      run.then(release, release)
    })
    return withTimeoutGuard(run, ledgerRuntime.opTimeoutMs, '台账操作超时(' + ledgerRuntime.opTimeoutMs / 1000 + 's)')
  }

  async function recordDeletedEntry(sessionId, path, heldPath) {
    return withLedgerLock(async () => {
      const ledger = await ledgerReady
      const current = ledger.global.get()
      const entry = { sessionId, path, deletedAt: Date.now(), ...(heldPath !== undefined ? { heldPath } : {}) }
      const merged = mergeDeletedEntry(current.deleted, entry)
      await ledger.global.set({ ...current, deleted: merged.slice(0, LEDGER_MAX_ENTRIES) })
    })
  }

  // 台账移除:幂等,未命中不产生写回
  async function removeLedgerEntry(sessionId) {
    return withLedgerLock(async () => {
      const ledger = await ledgerReady
      const current = ledger.global.get()
      const { deleted, removed } = removeDeletedEntry(current.deleted, sessionId)
      if (removed) await ledger.global.set({ ...current, deleted })
    })
  }

  // 宽限记账:按会话记取消归档时刻(进程内表,无持久化副作用),顺带清过期项
  function recordUnarchiveGrace(sessionId) {
    const now = monotonicNow()
    pruneUnarchiveGrace(now)
    unarchiveGraceBySession.set(String(sessionId), now)
  }

  // 宿主外部恢复(官方 workspace.unarchiveSession / 撤销 toast)不经插件路由,同样要记
  // 宽限:0.2.2 宿主在移除归档标记前派发 workspace/session-unarchiving(parallel),
  // 监听即覆盖两种恢复入口。清理路径的 unarchive 已在 unarchiveCleanupIds 登记时抑制,
  // 不把删除/自愈当成用户恢复。事件面能力门:精简上下文无 on 时跳过,插件路由的显式
  // 记账仍在;无事件旧宿主由 reconcileArchivedRemovals 按集合差分补记。
  if (typeof ctx.on === 'function') {
    ctx.on('workspace/session-unarchiving', ({ sessionId } = {}) => {
      if (sessionId === undefined || sessionId === null) return
      if (unarchiveCleanupIds.has(String(sessionId))) return
      recordUnarchiveGrace(sessionId)
    })
  }

  // 无事件宿主补记宽限:事件面缺失(0.2.1 / 0.2.2-rc.1)时,原生恢复只表现为
  // 归档集合移除。对比上一轮评估集合,按会话补记用户恢复;首次评估只建基线。
  // 内部清理的实际移除会在 removeArchivedId 中同步剔除基线,不会被误当恢复。
  function reconcileArchivedRemovals(archivedNow) {
    if (previousArchivedIds !== undefined) {
      for (const id of previousArchivedIds) {
        if (!archivedNow.has(id)) recordUnarchiveGrace(id)
      }
    }
    previousArchivedIds = archivedNow
  }

  function pruneUnarchiveGrace(nowMs) {
    const active = activeUnarchiveGraces(unarchiveGraceBySession, nowMs)
    unarchiveGraceBySession.clear()
    for (const [sessionId, unarchivedAtMs] of active) unarchiveGraceBySession.set(sessionId, unarchivedAtMs)
  }

  // 台账命中查询:同 id 曾删除过(重删场景的幽灵资格依据);域不可用时按未命中
  async function ledgerHasEntry(sessionId) {
    try {
      const ledger = await ledgerReady
      return ledger.global.get().deleted.some((item) => item.sessionId === sessionId)
    } catch {
      return false
    }
  }

  // 台账条目读取:重挂载移回依据;域不可用或未命中均按无条目
  async function ledgerEntryFor(sessionId) {
    try {
      const ledger = await ledgerReady
      return ledger.global.get().deleted.find((item) => item.sessionId === sessionId)
    } catch {
      return undefined
    }
  }

  // 幽灵残留清理:产物已缺失的会话仅解除列表可见性(detach + 归档清理),
  // 无回收与台账动作;失败点聚合成后缀,重试即补全。detach 失败时保留归档
  // 集合与台账(会话仍在主列表,清归档会让它失去重试资格),只报 detach 失败。
  async function cleanupDeletedSession(sessionId) {
    let suffix = ''
    const detachError = await detachSession(ctx, sessionId)
    if (detachError !== undefined) {
      ctx.logger && ctx.logger.warn('session-manager 幽灵清理 detach 失败(' + sessionId + '): ' + String(detachError && detachError.stack || detachError))
      return MESSAGES.ghostDetach
    }
    try {
      await removeArchivedId(sessionId)
    } catch (error) {
      ctx.logger && ctx.logger.warn('session-manager 幽灵清理归档移除失败(' + sessionId + '): ' + String(error && error.stack || error))
      suffix = MESSAGES.ghostCleanup + MESSAGES.ghostArchiveSuffix
    }
    return suffix
  }

  // 重挂载前把回收区暂存产物移回原位置:回收区条目的找回动作就是重挂载本身,
  // 不要求用户手工搬移。原位置已有产物(已自行还原)或暂存缺失时不动
  async function restoreHeldArtifact(sessionId) {
    const entry = await ledgerEntryFor(sessionId)
    if (entry === undefined || entry.heldPath === undefined) return
    const originalGone = await stat(entry.path).then(() => false, (error) => {
      if (error && error.code === 'ENOENT') return true
      throw error
    })
    if (!originalGone) return
    const heldExists = await stat(entry.heldPath).then(() => true, (error) => {
      if (error && error.code === 'ENOENT') return false
      throw error
    })
    if (!heldExists) throw new Error(MESSAGES.heldMissing)
    try {
      await executor.restoreFromQuarantine(entry.heldPath, entry.path)
    } catch (error) {
      throw new Error(MESSAGES.restoreFailed + ': ' + String(error && error.message || error))
    }
  }

  // 命令不可执行(spawn 失败)与产物消失同码 ENOENT:前者必须走回收区降级,
  // 后者才按无产物收尾。spawn 错误的 syscall 为 "spawn <file>",文件系统错误为
  // rename/stat 等操作名,据此区分,不做版本或平台硬编码。
  function isCommandSpawnError(error) {
    return Boolean(error && error.code === 'ENOENT'
      && typeof error.syscall === 'string' && error.syscall.startsWith('spawn'))
  }

  // 回收区搬移只有在 rename/cp 的源路径 ENOENT 时才是产物已消失;mkdir 等
  // 目标侧 ENOENT 表示回收区不可用,必须按 trashFailed 拒绝并保留会话。
  function isQuarantineSourceGone(error, artifactDir) {
    if (!error || error.code !== 'ENOENT') return false
    const syscall = typeof error.syscall === 'string' ? error.syscall : ''
    if (syscall !== 'rename' && syscall !== 'cp') return false
    return typeof error.path !== 'string' || error.path === '' || samePath(error.path, artifactDir)
  }

  // 删除产物:系统回收站优先,不可用降级插件回收区;失败返回可读错误,由调用方决定响应
  async function disposeArtifact(sessionId, artifactDir) {
    try {
      await executor.trashPath(artifactDir)
      return { mode: 'os', heldPath: undefined }
    } catch (trashError) {
      // 目录在探测与处置之间消失:产物已不存在,按无产物收尾,不误报回收失败
      if (trashError && trashError.code === 'ENOENT' && !isCommandSpawnError(trashError)) return { missing: true }
      ctx.logger && ctx.logger.warn('session-manager 系统回收站不可用(' + sessionId + '),尝试回收区降级: ' + String(trashError))
      try {
        const heldPath = await executor.moveToQuarantine(artifactDir, quarantineDir)
        return { mode: 'quarantine', heldPath }
      } catch (heldError) {
        if (isQuarantineSourceGone(heldError, artifactDir)) return { missing: true }
        return { error: MESSAGES.trashFailed + '(系统回收站与插件回收区均不可用): ' + String(heldError && heldError.message || heldError) }
      }
    }
  }

  // 派生子会话后裔:按 parentSession 建邻接表做 BFS,只收可判定为派生的记录;
  // 普通 fork(depth 0)是用户会话,不随父会话级联。
  function derivedDescendants(records, rootId) {
    const childrenByParent = new Map()
    for (const recordItem of records) {
      const header = recordItem.header
      if (!isDerivedSessionHeader(header) || header.parentSession === undefined) continue
      const parent = String(header.parentSession)
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      childrenByParent.get(parent).push(recordItem)
    }
    const out = []
    const seen = new Set([String(rootId)])
    const queue = [String(rootId)]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const recordItem of childrenByParent.get(current) ?? []) {
        const id = String(recordItem.header.id)
        if (seen.has(id)) continue
        seen.add(id)
        out.push(recordItem)
        queue.push(id)
      }
    }
    return out
  }

  // 级联清理:父会话删除后,子会话仍被父 catalog 引用且无独立 UI 入口;
  // 逐个走同一回收/归档清理链,失败项如实返回,不静默留产物。
  // 子会话不写已删除台账:重挂载拒绝派生子会话,台账行只会指向不可执行动作。
  async function cascadeDeleteDescendants(records, rootId) {
    const persistence = ctx.get('sessionPersistence')
    const artifactMap = await listArtifactMap(persistence)
    const deleted = []
    const failed = []
    for (const recordItem of derivedDescendants(records, rootId)) {
      const header = recordItem.header
      const sessionId = String(header.id)
      // 父会话回收窗口内子会话可能被唤醒:逐个子会话复检,运行中者不搬产物
      if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
        failed.push({ sessionId, error: MESSAGES.descendantRunning })
        continue
      }
      let artifact
      try {
        artifact = await resolveArtifact(persistence, header, artifactMap)
      } catch (error) {
        failed.push({ sessionId, error: String(error && error.message || error) })
        continue
      }
      // 无观测能力或产物未落盘:没有可回收目录,不制造台账条;仍照常 detach/清归档
      let artifactDir
      if (artifact !== undefined && !artifact.missing) {
        const candidateDir = dirname(artifact.path)
        try {
          await stat(candidateDir)
          artifactDir = candidateDir
        } catch (error) {
          // 目录 ENOENT = 产物已不存在,按无产物继续收尾;其余错误如实失败
          if (error && error.code !== 'ENOENT') {
            failed.push({ sessionId, error: String(error && error.message || error) })
            continue
          }
        }
      }
      if (artifactDir !== undefined) {
        const disposal = await disposeArtifact(sessionId, artifactDir)
        if (disposal.error !== undefined) {
          failed.push({ sessionId, error: disposal.error })
          continue
        }
        // 派生子会话不记台账:台账唯一用途是「还原后重挂载」,而重挂载明确拒绝
        // 子会话(isDerivedSessionHeader)= 记了也只会生成点击必 400 的面板行。
        // 回收区降级场景下产物会留作孤儿,落 warn 使其可观测(无台账入口可重挂载)
        if (disposal.mode === 'quarantine') {
          ctx.logger && ctx.logger.warn('session-manager 子会话产物降级入回收区(无台账入口,不可重挂载): ' + sessionId)
        }
      }
      // detach 失败与父路径同口径:产物已移走但列表仍引用它,进 failed+partial,
      // 且不清理归档集合(保留归档资格供重试);不能计入 deleted 谎报清理完成
      const detachError = await detachSession(ctx, sessionId)
      if (detachError !== undefined) {
        failed.push({ sessionId, error: MESSAGES.cascadeDetach, partial: true })
        continue
      }
      try {
        await removeArchivedId(sessionId)
      } catch (error) {
        ctx.logger && ctx.logger.warn('session-manager 级联归档清理失败(' + sessionId + '): ' + String(error && error.stack || error))
      }
      deleted.push(sessionId)
    }
    return { deleted, failed }
  }

  // 产物缺失统一收尾:与幽灵分支同语义——只解除列表可见性(detach + 归档清理),
  // 不写台账(无产物可还原),级联子会话照常清理。
  async function finishMissingSession(sessionId, records, descendants) {
    const cascade = descendants.length > 0 ? await cascadeDeleteDescendants(records, sessionId) : undefined
    const cleanupError = await cleanupDeletedSession(sessionId)
    headerCache.delete(sessionId)
    return { cascade, cleanupError }
  }

  // 缺失收尾响应:基础文案与幽灵分支一致,级联/清理失败按既有聚合口径并入
  function respondMissingCleanup(res, { cascade, cleanupError }) {
    const cascadeMessage = cascade !== undefined && cascade.failed.length > 0
      ? `父会话已清理,${cascade.failed.length} 个子会话未完全清理`
      : ''
    if (cleanupError !== '') {
      sendJson(res, 200, {
        ok: true,
        partial: true,
        message: mergeOutcomeMessages(cleanupError, cascadeMessage),
        ...(cascade === undefined ? {} : { cascade }),
      })
      return
    }
    sendJson(res, 200, {
      ok: true,
      ...(cascadeMessage === ''
        ? { message: MESSAGES.ghostCleanup }
        : { partial: true, message: mergeOutcomeMessages(MESSAGES.ghostCleanup, cascadeMessage) }),
      ...(cascade === undefined ? {} : { cascade }),
    })
  }

  const routes = [
    {
      path: '/api/session-manager/unarchive',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const sessionId = await requireSessionId(req)
          const header = await findHeader(ctx, sessionId, headerCache)
          if (header !== undefined && isDerivedSessionHeader(header)) {
            sendJson(res, 400, { error: MESSAGES.derivedSession })
            return
          }
          await removeArchivedId(sessionId, { cleanup: false })
          // 取消归档成功后缓存仍可用(header 未变),但该 id 可能曾被删除路径写脏,
          // 一并失效:后续重挂载/删除按持久层现状重新判定
          headerCache.delete(sessionId)
          recordUnarchiveGrace(sessionId)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/info',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const sessionId = await requireSessionId(req)
          const header = await findHeader(ctx, sessionId, headerCache)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          const persistence = ctx.get('sessionPersistence')
          sendJson(res, 200, await probeArtifactSize(persistence, header))
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/sizes',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          if (!body || !Array.isArray(body.sessionIds)) throw new Error('sessionIds 必须为数组')
          const sessionIds = [...new Set(body.sessionIds
            .filter((value) => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value !== ''))]
          if (sessionIds.length === 0) throw new Error('sessionIds 不能为空')
          if (sessionIds.length > SIZES_MAX_IDS) {
            throw new Error('一次最多查询 ' + SIZES_MAX_IDS + ' 个会话的产物大小')
          }
          const records = await ctx.sessionQuery.listSessions()
          const headerById = new Map(records.map((recordItem) => [String(recordItem.header.id), recordItem.header]))
          const persistence = ctx.get('sessionPersistence')
          // 批量查询一次 list 快照:有 stat 的后端也可避免逐会话代际扫描
          const artifactMap = await listArtifactMap(persistence)
          const sizes = {}
          await mapWithConcurrency(sessionIds, SIZES_CONCURRENCY, async (sessionId) => {
            const header = headerById.get(sessionId)
            if (header === undefined) {
              sizes[sessionId] = { supported: false }
              return
            }
            try {
              sizes[sessionId] = await probeArtifactSize(persistence, header, artifactMap)
            } catch (error) {
              // 单条定位/探测失败不拖垮整批:该行按不可得处理,原始错误进服务端日志
              ctx.logger && ctx.logger.warn('session-manager 产物大小查询失败(' + sessionId + '): ' + String(error && error.message || error))
              sizes[sessionId] = { supported: false }
            }
          })
          sendJson(res, 200, { sizes })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/delete',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        const sessionId = await requireSessionId(req).catch((error) => {
          respondError(ctx, res, error)
          return undefined
        })
        if (sessionId === undefined) return
        // 同 id 去重:并发第二次删除会走幽灵清理,语义混乱且响应文案不一致
        if (inFlightDeletes.has(sessionId)) {
          sendJson(res, 400, { error: MESSAGES.inFlight })
          return
        }
        inFlightDeletes.add(sessionId)
        try {
          const header = await findHeader(ctx, sessionId, headerCache)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          // 子 agent 会话不属用户会话:面板不展示,也不接受删除(避免父会话 catalog
          // 留下指向已消失子会话的条目)
          if (isDerivedSessionHeader(header)) {
            sendJson(res, 400, { error: MESSAGES.derivedSession })
            return
          }
          // 运行中守卫:与归档评估同款判据,落实"运行中会话永不被删除"不变量
          if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
            sendJson(res, 400, { error: MESSAGES.running })
            return
          }
          const persistence = ctx.get('sessionPersistence')
          const artifact = await resolveArtifact(persistence, header)
          if (artifact === undefined) {
            sendJson(res, 400, { error: MESSAGES.unsupportedBackend })
            return
          }
          // 快照 location 指向会话目录下的真实日志文件;回收对象是目录整体,残留空目录
          // 会让已删除会话在面板以空壳复活。缺失判定按目录级:日志缺失但目录在
          // (半删除残留)仍走完整回收,目录消失才是幽灵
          let artifactDir
          let artifactMissing = artifact.missing === true
          if (!artifactMissing) {
            artifactDir = dirname(artifact.path)
            try {
              await stat(artifactDir)
            } catch (error) {
              if (error && error.code !== 'ENOENT') throw error
              artifactMissing = true
            }
          }
          if (artifactMissing) {
            // 幽灵资格:已归档或台账有记录(同 id 重删的残留清理)才放行;
            // 两者皆无的 ENOENT 可能是新建会话尚未落盘,剥离活会话属于破坏性误删
            const archivedNow = ctx.workspaceRegistry.archivedSessionIds.map(String).includes(sessionId)
            if (!archivedNow && !(await ledgerHasEntry(sessionId))) {
              sendJson(res, 400, { error: MESSAGES.notArchived })
              return
            }
            // 父产物已缺失不代表子产物不存在:幽灵清理同样要级联,否则遗留子会话目录
            let ghostRecords
            try {
              ghostRecords = await ctx.sessionQuery.listSessions()
            } catch (error) {
              ctx.logger && ctx.logger.warn('session-manager 幽灵清理前列会话失败(' + sessionId + '): ' + String(error))
              sendJson(res, 400, { error: MESSAGES.cascadeScanFailed })
              return
            }
            const ghostDescendants = derivedDescendants(ghostRecords, sessionId)
            for (const recordItem of ghostDescendants) {
              if (isSessionRunning({ agents: ctx.get('agents'), sessionId: String(recordItem.header.id) })) {
                sendJson(res, 400, { error: MESSAGES.descendantRunning })
                return
              }
            }
            // 幽灵收尾后持久层不再产出该会话:缓存由统一收尾失效,否则重挂载守卫被旧 header 击穿
            respondMissingCleanup(res, await finishMissingSession(sessionId, ghostRecords, ghostDescendants))
            return
          }
          // host 端到端权威:归档资格在执行前校验
          const eligibility = deleteEligibility({
            archivedIds: ctx.workspaceRegistry.archivedSessionIds.map(String),
            sessionId,
          })
          if (!eligibility.ok) {
            sendJson(res, 400, { error: MESSAGES.notArchived })
            return
          }
          // TOCTOU 复检:守卫通过到执行间存在多个 await 间隙,会话可能已恢复运行
          if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
            sendJson(res, 400, { error: MESSAGES.running })
            return
          }
          // 删除父会话前收集派生子会话并复核运行态:级联把产物移入回收站后
          // 子会话无法继续写入,运行中的子会话必须挡住整次删除
          let records
          try {
            records = await ctx.sessionQuery.listSessions()
          } catch (error) {
            ctx.logger && ctx.logger.warn('session-manager 删除前列会话失败(' + sessionId + '): ' + String(error))
            sendJson(res, 400, { error: MESSAGES.cascadeScanFailed })
            return
          }
          const descendants = derivedDescendants(records, sessionId)
          for (const recordItem of descendants) {
            if (isSessionRunning({ agents: ctx.get('agents'), sessionId: String(recordItem.header.id) })) {
              sendJson(res, 400, { error: MESSAGES.descendantRunning })
              return
            }
          }
          // 归档资格 TOCTOU 复核:资格判定到执行间隔了全量扫描(数百 ms),期间用户
          // 可能已在另一窗口「恢复」该会话;已恢复的会话不得再移走产物(显式意图优先),
          // 409 中止,产物与台账零副作用
          const stillArchived = deleteEligibility({
            archivedIds: ctx.workspaceRegistry.archivedSessionIds.map(String),
            sessionId,
          })
          if (!stillArchived.ok) {
            ctx.logger && ctx.logger.warn('session-manager 删除执行前资格复核失败(会话已恢复): ' + sessionId)
            sendJson(res, 409, { error: MESSAGES.archiveRevoked })
            return
          }
          // 处置:优先系统回收站;不可用(容器无 gio/dbus 等)降级插件回收区
          // rename 搬移,仍可经重挂载移回原位置。双失败才会话保留并拒绝,
          // 原始回收站错误落日志(降级环境的诊断依据),拒绝响应携回收区错误
          const disposal = await disposeArtifact(sessionId, artifactDir)
          if (disposal.error !== undefined) {
            sendJson(res, 400, { error: disposal.error })
            return
          }
          // 处置窗口内用户恢复:回收站/回收区操作是异步的,执行前复核挡不住这之后的
          // 档案集合变化。已恢复则回退回收区暂存(OS 回收站无程序化回退,仅保留可手动
          // 还原)并 409 中止,台账、detach、归档清理全部不执行——恢复意图优先。
          if (!ctx.workspaceRegistry.archivedSessionIds.map(String).includes(sessionId)) {
            ctx.logger && ctx.logger.warn('session-manager 删除处置期间会话恢复为未归档,已回退并中止: ' + sessionId)
            if (disposal.mode === 'quarantine' && disposal.heldPath !== undefined) {
              try {
                await executor.restoreFromQuarantine(disposal.heldPath, artifactDir)
              } catch (error) {
                ctx.logger && ctx.logger.warn('session-manager 删除回退回收区暂存失败(' + sessionId + '): ' + String(error && error.stack || error))
              }
            }
            sendJson(res, 409, { error: MESSAGES.archiveRevoked })
            return
          }
          // 产物在探测与处置之间消失:与幽灵分支同语义,不写台账、不谎报已移入回收站
          if (disposal.missing === true) {
            respondMissingCleanup(res, await finishMissingSession(sessionId, records, descendants))
            return
          }
          // 产物已离开原位置:该 id 的 header 缓存从此不得再被重挂载当作「仍可查到」
          headerCache.delete(sessionId)
          const heldPath = disposal.heldPath
          const quarantined = disposal.mode === 'quarantine'
          // 执行期翻转检测:OS 回收存在数百 ms 异步窗口,复检通过后仍可能恢复运行。
          // 产物已移走,中断只会更糟,照常完成收尾,但把不变量破坏变为可观测事件
          const runningDuringTrash = isSessionRunning({ agents: ctx.get('agents'), sessionId })
          if (runningDuringTrash) {
            ctx.logger && ctx.logger.warn('session-manager 删除执行期间会话恢复运行: ' + sessionId)
          }
          // 台账在处置成功后立即记录:产物已离开原位置,后续任何半失败都不影响还原资格;
          // 台账失败只降级重挂载便利,不回滚删除
          let ledgerError
          try {
            await recordDeletedEntry(sessionId, artifactDir, heldPath)
          } catch (error) {
            ledgerError = error
            ctx.logger && ctx.logger.warn('session-manager 台账记录失败(' + sessionId + '): ' + String(error && error.stack || error))
          }
          const detachError = await detachSession(ctx, sessionId)
          if (detachError !== undefined) {
            ctx.logger && ctx.logger.warn('session-manager detach 失败(' + sessionId + '): ' + String(detachError && detachError.stack || detachError))
          }
          // 归档集合同步清理:残留 id 会让面板行持续可见;detach 失败时不清理,
          // 保留归档资格供重试
          let archiveCleanupFailed = false
          if (detachError === undefined) {
            try {
              await removeArchivedId(sessionId)
            } catch (error) {
              archiveCleanupFailed = true
              ctx.logger && ctx.logger.warn('session-manager 归档清理失败(' + sessionId + '): ' + String(error && error.stack || error))
            }
          }
          const cascade = descendants.length > 0 ? await cascadeDeleteDescendants(records, sessionId) : undefined
          // 级联失败点是父级失败点的补充而非替代:两段文案合并,父级「台账/归档清理」
          // 提示不得被「N 个子会话未清理」覆盖掉
          const outcome = aggregateDeleteOutcome({
            detachFailed: detachError !== undefined,
            archiveCleanupFailed,
            ledgerFailed: ledgerError !== undefined,
            runningDuringTrash,
            quarantined,
          })
          const cascadeMessage = cascade !== undefined && cascade.failed.length > 0
            ? `父会话已删除,${cascade.failed.length} 个子会话未完全清理`
            : ''
          const message = mergeOutcomeMessages(outcome.message, cascadeMessage)
          sendJson(res, 200, {
            ok: true,
            ...(message === '' ? {} : { message }),
            ...(outcome.partial === true || cascadeMessage !== '' ? { partial: true } : {}),
            mode: quarantined ? 'quarantine' : 'os',
            ...(cascade === undefined ? {} : { cascade }),
          })
        } catch (error) {
          respondError(ctx, res, error)
        } finally {
          inFlightDeletes.delete(sessionId)
        }
      },
    },
    {
      path: '/api/session-manager/status',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'GET')) return
        sendJson(res, 200, { periodic: { ...periodic } })
      },
    },
    {
      // 自动归档配置:读回生效值(含默认回退),写经 settings.update 部分更新;
      // 0 = 关闭(阈值天数关自动归档,间隔小时数关周期轮),与评估逻辑同源语义
      path: '/api/session-manager/auto-archive',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const current = readSettings(ctx, config)
            sendJson(res, 200, { days: current.days, intervalHours: current.intervalHours })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          const patch = readAutoArchivePatch(body)
          await persistSettings(ctx, patch)
          const current = readSettings(ctx, config)
          sendJson(res, 200, { days: current.days, intervalHours: current.intervalHours })
        } catch (error) {
          respondError(ctx, res, error)
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
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/remount',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const sessionId = await requireSessionId(req)
          // 移回依据是台账条目,台账域不可用时整个重挂载拒绝:
          // 静默按无条目处理会让回收区产物永远找不回,还误导用户去系统回收站
          try {
            await ledgerReady
          } catch {
            sendJson(res, 400, { error: MESSAGES.systemError })
            return
          }
          // 回收区暂存的产物先移回原位置(host 按产物现状列会话,移回后 header 可见);
          // OS 回收站条目无 heldPath,此调用为空操作
          await restoreHeldArtifact(sessionId)
          // 产物还原的判定即持久层能重新读到 header:未还原时在此拒绝。
          // 必须先失效缓存——缓存命中会让「删除后 10 分钟内」的重挂载绕过本守卫,
          // 直接调 attachSession 吃宿主原始英文错误
          headerCache.delete(sessionId)
          const header = await findHeader(ctx, sessionId, headerCache)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.notRestored })
            return
          }
          // 子会话不写归属行:attachSession 只校验 cwd,不拦 origin
          if (isDerivedSessionHeader(header)) {
            sendJson(res, 400, { error: MESSAGES.derivedSession })
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
          respondError(ctx, res, error)
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
          respondError(ctx, res, error)
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: withRouteGate(ctx, route.handler) }),
      'dsh-session-manager ' + route.path)
  }

  // 周期评估软依赖 timer:顶层注册(不嵌套在 settings 回调内,settings 服务重启会
  // 重跑其回调并新建 fiber,嵌套会使周期轮随重启累积复制)。服务未激活则回调不执行,
  // 插件其余能力不受影响,设置页提示降级
  ctx.inject(['timer'], (timerCtx) => {
    if (typeof timerCtx.interval !== 'function') {
      periodic.reason = '宿主定时服务不可用'
      return () => {
        periodic.running = false
      }
    }
    // 固定短 tick + 到期判断:间隔设置变更自下一周期生效,缩短经 earliest 钳制前移
    let nextDueAt = null
    let lastArmedAt = 0
    const scheduleNext = () => {
      const { intervalHours } = readSettings(ctx, config)
      lastArmedAt = Date.now()
      nextDueAt = intervalHours > 0 ? lastArmedAt + intervalHours * HOUR_MS : null
    }
    try {
      const dispose = timerCtx.interval(() => {
        const { intervalHours } = readSettings(ctx, config)
        // 设置变更对账:0 即时暂停;缺失 due(0 重启用)时补排,防周期轮静默死亡;
        // 缩短间隔时以 lastArmedAt 锚定前移,最长等新间隔而非等满旧周期
        if (intervalHours === 0) {
          nextDueAt = null
          return
        }
        const earliest = lastArmedAt > 0 ? lastArmedAt + intervalHours * HOUR_MS : Infinity
        if (nextDueAt !== null && nextDueAt > earliest) nextDueAt = earliest
        if (nextDueAt === null || Date.now() >= nextDueAt) {
          // 门闩占用(他源评估在途)时保持到期态,60s 后下个 tick 重试;
          // 仅评估真正启动才重排周期,被丢弃的到期轮不会静默失效一个周期
          if (evaluateArchives()) scheduleNext()
        }
      }, PERIODIC_TICK_MS)
      // disposer 挂本 inject fiber:timer 服务移除/重启时复位降级状态并清理 interval
      periodic.running = true
      return () => {
        dispose()
        periodic.running = false
      }
    } catch (error) {
      periodic.reason = '宿主定时服务调用失败: ' + String(error && error.message || error)
      return undefined
    }
  })

  ctx.inject(['settings'], (settingsCtx) => {
    // 方法面守卫:settings 服务在但缺 register(宿主升级变更面)时跳过注册,
    // 周期轮与启动补扫按 readSettings 的默认值降级运行,不因服务形变炸 fiber;
    // 0.1.7 关闭原生自动设置页,设置面由本包自带分区承担(maintain 同构)
    if (typeof settingsCtx.settings.register !== 'function') {
      if (typeof settingsCtx.settings?.configure === 'function') {
        settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
      }
    } else {
      settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: config })
    }
    // 启动补扫与归档集合自愈只依赖 workspaceRegistry/sessionQuery,与设置方法面无关:
    // 必须放在 register 分支之外,否则现役宿主(无 register)上永远不执行
    void healDerivedArchived()
    evaluateArchives()
  })
}

// 批量任务并发池:worker 自行落结果;limit 非正整数时按串行处理
async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  const width = Number.isInteger(limit) && limit > 0 ? limit : 1
  let next = 0
  const run = async () => {
    while (next < list.length) {
      const index = next
      next += 1
      await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, run))
}

// 产物真源:公共 SessionPersistence 契约的 stat()/list() 快照。快照的 location
// 由后端按实际选中的代解析——旧代产物(formatStatus=migration-required)指向真实
// 历史文件;locate() 是 JSONL 后端私有诊断钩子,按当前代编码拼路径,旧代时会指向
// 不存在的当前代文件,只给没有 stat 的旧宿主兜底。
function artifactFromSnapshot(snapshot) {
  const location = snapshot && snapshot.location
  if (!location || typeof location.path !== 'string') return undefined
  return {
    path: location.path,
    sizeBytes: Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : undefined,
    revision: snapshot.revision,
    formatStatus: snapshot.formatStatus,
  }
}

async function listArtifactMap(persistence) {
  if (!persistence || typeof persistence.list !== 'function') return undefined
  try {
    const snapshots = await persistence.list()
    if (!Array.isArray(snapshots)) return null
    // 旧宿主 list() 返回裸 header(无 header 字段):不能当快照用,交给 locate 兜底
    if (snapshots.length > 0 && snapshots.every((snapshot) => !snapshot || !snapshot.header)) return null
    const map = new Map()
    for (const snapshot of snapshots) {
      const id = snapshot && snapshot.header ? String(snapshot.header.id) : undefined
      if (id === undefined) continue
      map.set(id, artifactFromSnapshot(snapshot) ?? { missing: true })
    }
    return map
  } catch {
    return null
  }
}

// undefined=后端无观测能力;{missing:true}=持久层无该会话或产物未落盘;否则为可回收产物
async function resolveArtifact(persistence, header, artifactMap) {
  const id = String(header.id)
  if (artifactMap instanceof Map) return artifactMap.get(id) ?? { missing: true }
  if (persistence && typeof persistence.stat === 'function') {
    const snapshot = await persistence.stat(header.id)
    if (snapshot === undefined) return { missing: true }
    const artifact = artifactFromSnapshot(snapshot)
    return artifact === undefined ? { missing: true } : artifact
  }
  // 没有 stat 的旧宿主:先看 list 快照(新版契约),再退回私有 locate
  const listed = artifactMap === null ? null : await listArtifactMap(persistence)
  if (listed instanceof Map) return listed.get(id) ?? { missing: true }
  if (persistence && typeof persistence.locate === 'function') {
    const located = persistence.locate(header)
    if (located && typeof located.path === 'string') return { path: located.path }
  }
  return undefined
}

// 产物大小探测:无观测能力按不支持;快照 sizeBytes 直接可用(旧代也准确),
// 无 sizeBytes 时退回文件 stat;ENOENT 按产物缺失
async function probeArtifactSize(persistence, header, artifactMap) {
  const artifact = await resolveArtifact(persistence, header, artifactMap)
  if (artifact === undefined) return { supported: false }
  if (artifact.missing) return { supported: true, sizeBytes: 0, missing: true }
  if (Number.isFinite(artifact.sizeBytes)) return { supported: true, sizeBytes: artifact.sizeBytes }
  try {
    const info = await stat(artifact.path)
    return { supported: true, sizeBytes: info.size }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { supported: true, sizeBytes: 0, missing: true }
    throw error
  }
}

// 产物缺失时按无活跃处理(null),不阻断整轮评估;null 与真实 mtime=0 不混淆
async function safeMtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

// header 查找缓存:inputs 路由每次请求都要查 header,listSessions 为全量扫描
// (单次数百 ms,与后台对齐并发时成倍放大),而 sessionId→header 基本不变——
// 扫一次进缓存,TTL 界定新鲜度,容量上限防无界增长;只缓存命中,
// 未命中不缓存(新会话创建竞态下次扫描即命中,负缓存会误伤)
const HEADER_CACHE_TTL_MS = 10 * 60 * 1000
const HEADER_CACHE_MAX = 500

function findHeader(ctx, sessionId, cache) {
  const hit = cache.get(sessionId)
  if (hit && Date.now() - hit.at < HEADER_CACHE_TTL_MS) return Promise.resolve(hit.header)
  return ctx.sessionQuery.listSessions().then((records) => {
    const found = records.find((recordItem) => String(recordItem.header.id) === sessionId)
    if (!found) return undefined
    if (cache.size >= HEADER_CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(sessionId, { header: found.header, at: Date.now() })
    return found.header
  })
}

// detach 幂等:遍历全部工作区逐个移除,不因首个工作区操作失败提前终止;
// 返回首个失败供响应;单个失败也落日志(单工作区失败曾无任何上报)
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
  if (errors.length > 0 && ctx.logger) {
    ctx.logger.warn('session-manager detach 失败(' + sessionId + ', ' + errors.length + ' 个工作区): ' + errors.map(String).join('; '))
  }
  return errors[0]
}

// win32 路径大小写不敏感:realpath 已规范大小写,但比对侧可能存在大小写漂移
function samePath(left, right) {
  if (left === right) return true
  return process.platform === 'win32' && String(left).toLowerCase() === String(right).toLowerCase()
}

// 按会话 cwd 找归属工作区:两侧都 realpath 后比对(工作区路径本身也可能含
// 符号链接/大小写漂移),任一侧不可解析时按原值兜底,
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
    let workspacePath = workspace.path
    try {
      workspacePath = await realpath(workspacePath)
    } catch {
      // 按原值比对
    }
    if (samePath(workspacePath, resolved)) return workspace
  }
  return undefined
}
