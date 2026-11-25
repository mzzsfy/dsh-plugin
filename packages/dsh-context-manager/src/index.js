// dsh-context-manager Host 半区:历史输入工作区缓存对齐 + 启停/数据路由
// (inputs / prompts/toggle 与 history/history-button/steer-recall/fork/fork-auto-resend/copy-sid
// 六条启停)。
// 浮层请求直接读缓存文件立即返回;对齐在后台解压范围内会话产物与缓存合并写回,
// 运行中会话也参与(实时追加其新输入)。fork 分叉动作走 client 服务面,
// host 侧只有其启停路由。
// 插话撤回启停与历史浮层启停读走 settings(原生设置页与本分区开关同一存储)。

import { stat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

import schemastery from '@deepseek-ai/schemastery'

import {
  TARGET_EMPTY_DIR,
  TARGET_FILE,
  TARGET_MISSING,
  TARGET_NONEMPTY_DIR,
  parentOf,
  resolveCloneRequest,
  runClone,
} from './clone.mjs'

import {
  HISTORY_ALIGN_SLICE_MS,
  HISTORY_ALIGN_THROTTLE_MS,
  HISTORY_ALIGN_YIELD_MS,
  HISTORY_FOCUS_WAIT_MS,
  HISTORY_INPUT_LIMIT,
  HISTORY_INPUT_MAX_CHARS,
  HISTORY_EXTRACT_VERSION,
  HISTORY_PROMPTS_MAX,
  HISTORY_SCOPES,
  HISTORY_SESSION_SCAN_LIMIT,
  HISTORY_STARTUP_DELAY_MS,
  HISTORY_STARTUP_SCAN_LIMIT,
  aggregateInputs,
  extractUserInputs,
  isSessionRunning,
  maxArtifactBytesForHost,
  promptsToInputs,
  renamePromptItem,
  trimPrompts,
  reorderPrompts,
} from './core.mjs'
import { ensureCacheDir, listWorkspaceCachesCached, readPrompts, readWorkspaceCache, removeWorkspaceCache, updatePrompts, updateWorkspaceCache } from './history-cache.mjs'
import { createRequire } from 'node:module'
import { withRouteGate } from './route-gate.mjs'

export const name = 'dsh-context-manager'


export const inject = ['webServer', 'agents', 'sessionQuery', 'sessionPersistence', 'sessions']

const NAMESPACE = 'context'

// 克隆并发拒绝文案:导出供测试断言
export const CLONE_BUSY_MESSAGE = '已有克隆任务进行中,请等待完成'

// 进程树终止:git 在 Windows 派生子进程(git-remote-https 等),单杀留孤儿;
// POSIX 直接 SIGKILL;进程已退出时终止动作按无害失败处理。taskkill 不可用时
// spawn 会异步抛 error,必须监听否则成为未捕获异常拖垮宿主;windowsHide 防闪窗。
export function killTree(pid, { spawnImpl = spawn, platform = process.platform } = {}) {
  if (platform === 'win32') {
    try {
      const child = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      if (child && typeof child.on === 'function') child.on('error', () => {})
      if (child && typeof child.unref === 'function') child.unref()
    } catch {
      // taskkill 不可用不阻断克隆失败收尾
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程已退出
  }
}

// 路由响应文案;导出供测试断言与实现同步。
export const MESSAGES = {
  unknownSession: '会话不存在',
  badJsonBody: '请求体不是合法 JSON',
  systemError: '操作失败(系统级错误,详见服务端日志)',
  attachmentUnavailable: '附件服务不可用',
  attachmentInvalid: '附件请求不合法',
  attachmentTooLarge: '附件过大,无法恢复',
}

// 撤回附件读回上限:浏览器 File 必须持有完整字节,超限拒绝比拖垮页面好
const ATTACHMENT_READ_MAX_BYTES = 64 * 1024 * 1024

const SETTINGS_SCHEMA = schemastery.object({
  historyEnabled: schemastery.boolean().default(true)
    .description('历史输入浮层(Alt+↑),低频功能,关闭后输入框锚点与快捷键整体不渲染;变更刷新页面生效'),
  historyButtonEnabled: schemastery.boolean().default(true)
    .description('输入框工具排的历史输入按钮,点击开关浮层,与 Alt+↑ 等效;关闭仅隐藏按钮,快捷键与浮层不受影响;变更刷新页面生效'),
  steerRecallEnabled: schemastery.boolean().default(true)
    .description('插话撤回图标,低频功能,关闭后撤回图标整体不渲染;变更刷新页面生效'),
  forkEnabled: schemastery.boolean().default(true)
    .description('消息气泡操作排的分叉按钮,关闭后按钮整体不渲染;变更刷新页面生效'),
  forkAutoResendEnabled: schemastery.boolean().default(false)
    .description('分叉成功后自动把该轮原输入发送到子会话(重生成语义);关闭时仅回填子会话输入框供编辑重发'),
  copySidEnabled: schemastery.boolean().default(true)
    .description('会话标题栏的复制 sessionId 按钮,平时隐藏,鼠标悬停标题栏时显示,点击复制当前会话 id;关闭后按钮整体不渲染;变更刷新页面生效'),
  cloneEnabled: schemastery.boolean().default(true)
    .description('官方「添加工作区」浏览目录弹窗内的「克隆仓库」按钮,输入远程仓库地址克隆到所选目录并自动打开为新工作区;关闭后按钮不再注入,刷新页面生效'),
})

// 0.1.7 宿主以静态 Config 导出生成设置节表单(maintain 同构);legacy 宿主经
// settings.register 注册命名空间。根级 volatile 包装:0.1.7 下整节为 live 表单,
// 节写经 loader 原地热更;旧宿主 schemastery 无 volatile 方法,特性检测原样返回
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
// message 内嵌绝对路径)收敛为固定文案,原始错误仅进服务端日志;带 statusCode 的
// 请求体错误按状态码回(413 超限),其余一律 400
function respondError(ctx, res, error) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && ctx.logger) ctx.logger.warn('context-manager 系统级错误: ' + String(error && error.stack || error))
  const message = isSystem
    ? MESSAGES.systemError
    : (error && error.message ? error.message : String(error))
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400
  sendJson(res, status, { error: message })
}

function readSettings(ctx, config) {
  const settings = ctx.get('settings')
  // 双形读(maintain 同构):legacy settings 命名空间 get;0.1.7+ apply 入参
  // config 整节解包。方法面守卫兼防:服务在但缺 get 时回落默认值,防路由 handler 抛错
  const value = settings && typeof settings.get === 'function' ? settings.get(NAMESPACE) : unwrapVolatile(config)
  return {
    historyEnabled: !value || value.historyEnabled !== false,
    historyButtonEnabled: !value || value.historyButtonEnabled !== false,
    steerRecallEnabled: !value || value.steerRecallEnabled !== false,
    forkEnabled: !value || value.forkEnabled !== false,
    forkAutoResendEnabled: Boolean(value && value.forkAutoResendEnabled === true),
    copySidEnabled: !value || value.copySidEnabled !== false,
    cloneEnabled: !value || value.cloneEnabled !== false,
  }
}

// 双形写(maintain 同构,判定延迟到使用点):legacy 方法面以 register 为准
// (0.1.7 的 settings.update 名义在场但按命名空间找条目必败,不可作判据);
// 0.1.7+ 走 configEditor.edit 落 profile 条目(fiber.entry,与命名空间解耦),
// 仅 volatile 字段变化时 loader 原地热更不重启。await 保证持久化完成后再读回
async function persistToggle(ctx, patch) {
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
// 请求体读取时限:半开连接不得永久占住 handler(克隆单飞行由此泄漏)
export const BODY_READ_TIMEOUT_MS = 30 * 1000

function requestAbortedError() {
  const error = new Error('请求已中止')
  error.statusCode = 400
  return error
}

// 请求体读取:data/end 正常路径之外监听 aborted/close/error 与总时限;超限不销毁
// socket(销毁会让 413 响应送不出),暂停读取后由路由回错误响应。
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

async function readJsonBody(req) {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(MESSAGES.badJsonBody)
  }
}

function rejectMethod(req, res, method) {
  if (req.method === method) return true
  sendJson(res, 405, { error: 'method not allowed' })
  return false
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  // 历史输入:工作区粒度持久缓存(~/.dsh/historyPrompt/<工作区>-<hash>.json)。
  // 浮层请求直接读缓存文件立即返回(毫秒级);对齐在后台解压范围内会话产物,
  // 与缓存合并去重后写回——运行中会话也参与(实时追加其新输入)。
  // 解压不重复执行:每会话提取结果持久化在工作区缓存 extracts 段,附产物 stat 指纹
  // (mtimeMs+size),对齐时先 stat 比对,产物没变零解压——判断全部基于磁盘,跨重启生效。
  // 运行中会话(当前会话)提取结果只保留内存不落盘(产物持续变化,落盘指纹立即失效)。
  // 解压是同步 CPU 操作:对齐中连续占用超 SLICE 即让出 YIELD,启动对齐延迟
  // STARTUP_DELAY 再跑,绝不阻塞宿主启动。测试经 env DSH_HISTORY_CACHE_DIR 注入临时目录;
  // 缺省从宿主 home 派生(DSH_HOME 即 .dsh 根,rs-workflow 同构)
  const cacheDir = process.env.DSH_HISTORY_CACHE_DIR
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'historyPrompt')
  // 巨产物跳过线按宿主版本黑名单取值:0.1.1/0.1.2 解压实现无周期让出从严 8MiB,
  // 其余 16MiB。运行宿主清单经 require 链解析(插件随宿主树部署时必命中),
  // 探测失败按黑名单保守回退旧线。激活时求值一次即冻结,热路径只读值;
  // 宿主热升级后重启生效
  const maxArtifactBytes = resolveMaxArtifactBytes()
  function resolveMaxArtifactBytes() {
    let version = null
    try {
      version = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version
    } catch {
      version = null
    }
    return maxArtifactBytesForHost(version)
  }
  const alignThrottle = new Map()
  const runtimeExtracts = new Map()
  const headerCache = new Map()
  ctx.effect(() => () => { alignThrottle.clear(); runtimeExtracts.clear(); headerCache.clear() }, 'context-manager history align state')

  // 双车道对齐队列:批量车道(启动/请求触发,一次解一整个窗口)与焦点车道
  // (单会话实时追加,延时敏感)各自串行、互不等待——焦点车道不被冷启动
  // 批量任务的分钟级解压堵死。提交时按文件短锁重读合并,防跨车道丢更新
  function makeLane() {
    const tasks = []
    let draining = false
    return (body) => new Promise((resolve) => {
      tasks.push(() => body().then(resolve, resolve))
      if (draining) return
      draining = true
      void (async () => {
        while (tasks.length > 0) await tasks.shift()()
        draining = false
      })()
    })
  }
  const enqueueBulkAlign = makeLane()
  const enqueueFocusAlign = makeLane()

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function safeStat(path) {
    try {
      const info = await stat(path)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return null
    }
  }

  // 产物定位:真源是公共 SessionPersistence 契约的 stat()/list() 快照——快照的
  // location 由后端按实际选中的代解析,旧代产物(formatStatus=migration-required)
  // 指向真实历史文件。locate() 是 JSONL 后端的私有诊断钩子,按当前代编码拼路径,
  // 旧代时会指向不存在的当前代文件,只能给没有 stat/list 的旧宿主兜底。
  // 两者都缺失或抛错按「不可定位」降级(无指纹路径),不得把请求打成 400;
  // 降级事实落一次 warn 保持可观测(逐请求刷日志会淹没日志)
  let locateFallbackWarned = false
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
  // listSessions 记录在未来宿主上可能直接携带 location(当前 0.2.x 没有)
  function artifactFromRecord(recordItem) {
    const location = recordItem && recordItem.location
    if (!location || typeof location.path !== 'string') return undefined
    return { path: location.path, sizeBytes: Number.isFinite(recordItem.sizeBytes) ? recordItem.sizeBytes : undefined }
  }
  async function statArtifact(persistence, header) {
    if (persistence && typeof persistence.stat === 'function') {
      try {
        const snapshot = await persistence.stat(header.id)
        if (snapshot === undefined) return { status: 'missing', path: null }
        const artifact = artifactFromSnapshot(snapshot)
        return artifact === undefined
          ? { status: 'missing', path: null }
          : { status: 'ready', ...artifact }
      } catch (error) {
        if (!locateFallbackWarned) {
          locateFallbackWarned = true
          if (ctx.logger) ctx.logger.warn('context-manager 持久化 stat() 失败,尝试 locate 兜底: ' + String(error && error.stack || error))
        }
      }
    }
    if (persistence && typeof persistence.locate === 'function') {
      try {
        const located = persistence.locate(header)
        if (located && typeof located.path === 'string') return { status: 'ready', path: located.path }
      } catch {
        // 落入下方统一告警
      }
    }
    if (!locateFallbackWarned) {
      locateFallbackWarned = true
      if (ctx.logger) ctx.logger.warn('context-manager 持久化后端不提供 stat/locate 产物观测:历史输入对齐退化为逐次读取,不落指纹缓存')
    }
    return undefined
  }
  // 批量车道一次 list() 拿全部快照,避免逐会话 stat 的代际扫描开销;
  // list 不可用/失败返回 undefined,由调用方逐会话 statArtifact 兜底
  async function listArtifacts(persistence) {
    if (!persistence || typeof persistence.list !== 'function') return undefined
    try {
      const snapshots = await persistence.list()
      if (!Array.isArray(snapshots)) return undefined
      // 旧宿主 list() 返回裸 header(无 header 字段):不能当快照用,退回逐会话观测
      if (snapshots.length > 0 && snapshots.every((snapshot) => !snapshot || !snapshot.header)) return undefined
      const map = new Map()
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const id = snapshot && snapshot.header ? String(snapshot.header.id) : undefined
        if (id === undefined) continue
        map.set(id, artifactFromSnapshot(snapshot) ?? null)
      }
      return map
    } catch (error) {
      if (!locateFallbackWarned) {
        locateFallbackWarned = true
        if (ctx.logger) ctx.logger.warn('context-manager 持久化 list() 失败,退回逐会话 stat: ' + String(error && error.stack || error))
      }
      return undefined
    }
  }

  // 单会话提取:产物 stat 指纹与缓存一致即复用(零解压);否则解压并更新缓存。
  // 运行中会话走内存指纹(runtimeExtracts),其余走磁盘 extracts。
  // 指纹之外校验提取器版本:版本不符即重解压(升级后旧条目自动补齐新格式)。
  // 无指纹(后端无 stat/list 观测能力/产物未落盘)仍落 extracts 条目记录(指纹占位 0/0):
  // session 范围需要该会话全集,而检查侧对无指纹记录不做新鲜度判定
  async function extractSession(recordItem, fingerprint, extracts, isRunning) {
    const sessionId = recordItem.header.id
    const known = isRunning ? runtimeExtracts.get(sessionId) : extracts[sessionId]
    if (fingerprint !== null && known && known.v === HISTORY_EXTRACT_VERSION
      && known.mtimeMs === fingerprint.mtimeMs && known.size === fingerprint.size) {
      return known.entries
    }
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const entries = extractUserInputs(snapshot.events)
    const record = { v: HISTORY_EXTRACT_VERSION, mtimeMs: fingerprint === null ? 0 : fingerprint.mtimeMs, size: fingerprint === null ? 0 : fingerprint.size, entries }
    if (isRunning) {
      runtimeExtracts.set(sessionId, record)
    } else {
      extracts[sessionId] = record
      // 运行→停止:内存记录是停止前的快照,产物最终 flush 后可能已含新尾部;
      // 停止后一律以磁盘记录为准,陈旧内存记录不得继续服务 session 范围
      runtimeExtracts.delete(sessionId)
    }
    return entries
  }

  // 批量对齐执行体:列出范围会话,逐个按指纹增量提取(磁盘 extracts 复用),
  // 与缓存合并后原子写回,extracts 裁剪到完整扫描窗口。经批量队列入队。
  // 超过 MAX_ARTIFACT 的巨产物直接跳过:解压耗时与内存峰值随产物规模失控
  // (宿主内部逐帧解压带周期让出,不阻塞主循环);其历史来自缓存 entries 的既有贡献
  function alignWorkspaceNow(cwd) {
    return enqueueBulkAlign(async () => {
      const agents = ctx.get('agents')
      const persistence = ctx.get('sessionPersistence')
      const records = await ctx.sessionQuery.listSessions()
      const workspaceRecords = records
        .filter((recordItem) => recordItem.header.cwd !== undefined && samePath(recordItem.header.cwd, cwd))
      // subagent 会话不在主列表(官方 sessionVisible 以 origin 排除):其输入是
      // 任务提示与注入文本而非人类输入,且会以更近的产物时间挤占扫描窗口,必须排除
      const mainRecords = workspaceRecords.filter((recordItem) => !isDerivedSessionHeader(recordItem.header))
      const window = mainRecords.slice(0, HISTORY_SESSION_SCAN_LIMIT)
      // 缓存只认宿主清单里仍存在的本工作区主会话:清单是全量逻辑语料(含已归档),
      // 故归档会话仍在册、其输入保留;子会话与已删除会话的 sid 一律不在册,写回
      // 前剔除。liveIds 取全部主会话而非截断后的窗口——窗口外的老会话条目仍有效,
      // 只是不再重解压
      const liveIds = new Set(mainRecords.map((recordItem) => String(recordItem.header.id)))
      if (window.length === 0) {
        // 本工作区已无主会话(会话全被删除,或只剩 subagent 派生):缓存里每个 sid
        // 都失去来源。旧版在此提前 return 跳过读写,已删除会话的输入就永久留在
        // 浮层里。删除整份缓存而不是写空:空文件仍在 global 轮询的缓存清单里,
        // 会每轮再触发本工作区对齐
        await removeWorkspaceCache(cacheDir, cwd)
        return
      }
      const cached = await readWorkspaceCache(cacheDir, cwd)
      const extracts = cached && cached.extracts ? { ...cached.extracts } : {}
      // 一次 list() 取全量产物快照:旧代产物也能拿到真实历史文件路径,
      // 不逐会话做代际扫描;list 不可用时逐会话 statArtifact 兜底
      const artifactMap = await listArtifacts(persistence)
      const fresh = []
      let sliceStart = Date.now()
      for (const recordItem of window) {
        const isRunning = isSessionRunning({ agents, sessionId: recordItem.header.id })
        let artifact = artifactFromRecord(recordItem)
        if (artifact === undefined && artifactMap !== undefined) {
          artifact = artifactMap.get(String(recordItem.header.id)) ?? null
        }
        if (artifact === undefined) {
          const resolved = await statArtifact(persistence, recordItem.header)
          artifact = resolved && resolved.status === 'ready' ? resolved : null
        }
        const fingerprint = artifact && artifact.path ? await safeStat(artifact.path) : null
        if (fingerprint !== null && fingerprint.size > maxArtifactBytes) continue
        try {
          const entries = await extractSession(recordItem, fingerprint, extracts, isRunning)
          fresh.push(...entries.map((entry) => ({ ...entry, sid: recordItem.header.id })))
        } catch (error) {
          ctx.logger && ctx.logger.warn('context-manager 历史输入对齐失败(' + recordItem.header.id + '): ' + String(error && error.stack || error))
        }
        // 解压(可能命中缓存跳过)后检查连续占用:超 SLICE 让出 YIELD 不霸占主循环
        if (Date.now() - sliceStart > HISTORY_ALIGN_SLICE_MS) {
          await sleep(HISTORY_ALIGN_YIELD_MS)
          sliceStart = Date.now()
        }
      }
      // extracts 裁剪:仅保留窗口内非运行会话(运行中走内存,窗口外已淘汰)。
      // 同时清掉已停止会话的内存提取记录:停止后产物可能继续 flush 出尾部,
      // 内存快照不再更新,留着只会让 session 范围缺尾(读取侧另有运行中门控)
      const windowIds = new Set(window.map((recordItem) => recordItem.header.id))
      for (const sessionId of runtimeExtracts.keys()) {
        if (!isSessionRunning({ agents, sessionId })) runtimeExtracts.delete(sessionId)
      }
      const prunedExtracts = {}
      for (const [sessionId, record] of Object.entries(extracts)) {
        if (windowIds.has(sessionId) && !isSessionRunning({ agents, sessionId })) prunedExtracts[sessionId] = record
      }
      // 既往污染自愈:旧版本窗口未排除 subagent,其条目已混入缓存 entries;已删除
      // 会话同理(首条保护让它们永不被时间挤出)——合并前按本工作区现存主会话
      // 白名单剔除。无 sid 的早期条目无从判归属,保留(不触发首条保护)。
      // 清理时机即批量对齐时机(启动对齐/global 范围轮询/缓存缺失与未落盘兜底):
      // workspace 范围正常路径只读缓存,不为清理付全量清单扫描
      await updateWorkspaceCache(cacheDir, cwd, (latest) => {
        const legacyEntries = (latest?.entries ?? []).filter((entry) => entry.sid === undefined || liveIds.has(entry.sid))
        const nextExtracts = { ...latest?.extracts }
        // 提取期间已有新提交的会话保留新指纹,陈旧任务只能替换自己的基线。
        for (const sessionId of new Set([...Object.keys(cached?.extracts ?? {}), ...Object.keys(prunedExtracts)])) {
          if (JSON.stringify(nextExtracts[sessionId]) !== JSON.stringify(cached?.extracts?.[sessionId])) continue
          if (prunedExtracts[sessionId]) nextExtracts[sessionId] = prunedExtracts[sessionId]
          else delete nextExtracts[sessionId]
        }
        return {
          entries: aggregateInputs(legacyEntries.concat(fresh), { limit: HISTORY_INPUT_LIMIT, maxChars: HISTORY_INPUT_MAX_CHARS }),
          extracts: nextExtracts,
        }
      })
    })
  }

  // 焦点对齐执行体:只解目标会话并写回(实时追加路径),走独立焦点车道,
  // 不被批量车道的分钟级解压堵死。不裁剪 extracts(裁剪由批量对齐负责),
  // 只新增/更新目标会话指纹。无指纹(后端无 stat/list 能力/产物未落盘)仍解压取数:
  // 观测能力缺失只影响指纹复用,不得让对齐静默停摆;失败落 warn(车道会吞掉
  // 异常,不记日志则对齐失败在服务端完全不可见)
  function alignSessionFocus(cwd, header) {
    return enqueueFocusAlign(async () => {
      try {
        // 与批量窗口同一不变式:缓存只收主会话输入(正常 UI 不可达,防直调路由)
        if (isDerivedSessionHeader(header)) return
        const sessionId = header.id
        const resolved = await statArtifact(ctx.get('sessionPersistence'), header)
        const fingerprint = resolved && resolved.status === 'ready' && resolved.path ? await safeStat(resolved.path) : null
        if (fingerprint !== null && fingerprint.size > maxArtifactBytes) return
        const isRunning = isSessionRunning({ agents: ctx.get('agents'), sessionId })
        const cached = await readWorkspaceCache(cacheDir, cwd)
        const extracts = cached && cached.extracts ? { ...cached.extracts } : {}
        const entries = await extractSession({ header }, fingerprint, extracts, isRunning)
        await updateWorkspaceCache(cacheDir, cwd, (latest) => {
          const nextExtracts = { ...latest?.extracts }
          if (JSON.stringify(nextExtracts[sessionId]) === JSON.stringify(cached?.extracts?.[sessionId])) {
            if (extracts[sessionId]) nextExtracts[sessionId] = extracts[sessionId]
            else delete nextExtracts[sessionId]
          }
          return {
            entries: aggregateInputs((latest?.entries ?? []).concat(entries.map((entry) => ({ ...entry, sid: sessionId }))), { limit: HISTORY_INPUT_LIMIT, maxChars: HISTORY_INPUT_MAX_CHARS }),
            extracts: nextExtracts,
          }
        })
      } catch (error) {
        if (ctx.logger) ctx.logger.warn('context-manager 历史输入聚焦对齐失败(' + header.id + '): ' + String(error && error.stack || error))
      }
    })
  }

  // 节流壳:请求触发的后台对齐入口,30s 内同工作区只排队一次
  function alignWorkspace(cwd) {
    const now = Date.now()
    const last = alignThrottle.get(cwd)
    if (last !== undefined && now - last < HISTORY_ALIGN_THROTTLE_MS) return
    alignThrottle.set(cwd, now)
    void alignWorkspaceNow(cwd)
  }

  // 启动:只确保目录存在,**零解压**——历史直接读磁盘缓存(重启前的输入本就在
  // entries 里),宿主启动零负担;全量对齐延迟 STARTUP_DELAY 再跑(只解产物变过
  // 的会话)。定时器随插件销毁清理
  const startupTimers = []
  ctx.effect(() => () => { for (const timer of startupTimers) clearTimeout(timer) }, 'context-manager history startup timers')

  function scheduleStartupAlign() {
    startupTimers.push(setTimeout(() => {
      void (async () => {
        await ensureCacheDir(cacheDir)
        const records = await ctx.sessionQuery.listSessions()
        const workspaces = []
        // subagent 会话不参与归纳:纯 subagent 的 cwd 无人类输入,不值得建缓存;
        // 过滤先行再取最近 STARTUP_SCAN 条,subagent 密集派生时不挤占归纳窗口
        for (const recordItem of records
          .filter((item) => !isDerivedSessionHeader(item.header))
          .slice(0, HISTORY_STARTUP_SCAN_LIMIT)) {
          const recordCwd = recordItem.header.cwd
          if (recordCwd === undefined) continue
          if (workspaces.some((known) => samePath(known, recordCwd))) continue
          workspaces.push(recordCwd)
        }
        for (const workspaceCwd of workspaces) alignWorkspace(workspaceCwd)
      })().catch((error) => {
        ctx.logger && ctx.logger.warn('context-manager 历史缓存启动对齐失败: ' + String(error && error.stack || error))
      })
    }, HISTORY_STARTUP_DELAY_MS))
  }
  scheduleStartupAlign()

  // 聚焦对齐去重:同会话在队列/执行中不重复入队(轮询重入须挡住风暴)。
  // 值为在途 promise,路由据此有界等待同一次对齐
  const pendingFocus = new Map()
  ctx.effect(() => () => pendingFocus.clear(), 'context-manager history pending focus')

  // 克隆单飞行守卫:git clone 重且不可并发,完成(含失败)即解锁
  let cloneInFlight = false

  // 单会话提取条目:运行中会话走内存记录(不落盘),其余取 extracts 指纹记录;
  // 旧缓存无 extracts 时回退全局 entries 过滤(仅历史数据,后续对齐自动补齐)。
  // 内存记录只服务运行中会话:会话停止后产物可能继续 flush 出尾部,内存快照
  // 停在停止前,继续优先内存会让 session 范围缺尾且 stale 判定看不到(磁盘已新)
  function sessionEntriesOf(cached, sessionId, running) {
    const withSid = (entries) => entries.map((entry) => ({ ...entry, sid: sessionId }))
    const memory = running ? runtimeExtracts.get(sessionId) : undefined
    if (memory && Array.isArray(memory.entries)) return withSid(memory.entries)
    const extracted = cached && cached.extracts ? cached.extracts[sessionId] : undefined
    if (extracted && Array.isArray(extracted.entries)) return withSid(extracted.entries)
    return cached ? cached.entries.filter((entry) => entry.sid === sessionId) : []
  }

  // 按范围读取历史:全部直接读持久缓存(毫秒级)立即返回,对齐由后台进行;
  // aligned=false 表示数据未就绪(首次无缓存,或请求会话产物已变而缓存未跟上),
  // client 据此提示等待并静默重拉
  async function collectInputs(scope, sessionId, header) {
    const aggregateOptions = { limit: HISTORY_INPUT_LIMIT, maxChars: HISTORY_INPUT_MAX_CHARS }
    // 收藏是全局单文件,与会话头无关(路由为其跳过头部解析,header 为 undefined)。
    // 顺序即用户自定义顺序(拖动排序落盘),不按收藏时间重排
    if (scope === 'prompts') {
      const items = await readPrompts(cacheDir)
      return { inputs: promptsToInputs(items, { maxChars: HISTORY_INPUT_MAX_CHARS }), aligned: true }
    }
    const cwd = header.cwd
    if (scope === 'session') {
      if (cwd === undefined) return { inputs: [], aligned: true }
      // 会话范围取该会话提取全集:全局 entries 受工作区 200 条上限截断且每 sid
      // 只保留最早一条,长期使用的工作区会让老会话只剩一条;完整数据本就存在
      // extracts[sid].entries(运行中在内存 runtimeExtracts)。提取版本过期由
      // check 判 stale 后聚焦对齐补齐。运行中判定在每次读缓存/检查指纹时现取:
      // 停止瞬间仍可能读到内存快照,但下一次轮询按磁盘指纹判定 stale 并刷新
      const agents = ctx.get('agents')
      const read = async () => {
        const cached = await readWorkspaceCache(cacheDir, cwd)
        const isRunning = isSessionRunning({ agents, sessionId })
        return {
          cached,
          mine: aggregateInputs(sessionEntriesOf(cached, sessionId, isRunning), aggregateOptions),
        }
      }
      // 实时追加:产物 stat 与已知指纹不一致 = 会话有新输入未入缓存——聚焦对齐
      // 只解该会话并写回。提取器版本不符同判 stale(升级后旧格式条目在首请求
      // 内经聚焦对齐补齐,不等后台批量)。路由有界等待本次对齐(首条 <3s 预算):
      // 正常会话单次请求内直接拿到新数据;超时(巨产物等)返回既有数据 aligned=false,
      // 后续轮询流式补齐。巨产物跳过聚焦(解压耗时与内存峰值失控),维持 aligned=true。
      // 产物真源是公共 stat/list 快照(旧代产物也能拿到真实历史文件路径);后端
      // 两者都没有时才按不可定位处理——每次请求都聚焦重读该会话(不落指纹),
      // 不退回整工作区对齐(当前会话请求不为邻居付费)
      const check = async (cached) => {
        const resolved = await statArtifact(ctx.get('sessionPersistence'), header)
        const fingerprint = resolved && resolved.status === 'ready' && resolved.path ? await safeStat(resolved.path) : null
        const isRunning = isSessionRunning({ agents, sessionId })
        const known = isRunning ? runtimeExtracts.get(sessionId) : cached && cached.extracts ? cached.extracts[sessionId] : undefined
        return {
          unlocatable: resolved === undefined,
          // 产物尚未落盘(新会话首轮未 flush)或后端报无产物:指纹缺失无从判断新鲜度,
          // 只能退回整工作区对齐取数
          unmaterialized: resolved !== undefined && (resolved.status !== 'ready' || fingerprint === null),
          stale: fingerprint !== null && !(known && known.v === HISTORY_EXTRACT_VERSION && known.mtimeMs === fingerprint.mtimeMs && known.size === fingerprint.size),
          oversize: fingerprint !== null && fingerprint.size > maxArtifactBytes,
        }
      }
      let { cached, mine } = await read()
      let state = await check(cached)
      // 整工作区对齐是重活(全量清单扫描 + 扫描窗口内全部会话解压):只在聚焦对齐
      // 覆盖不到的分界兜底——产物未落盘(无指纹无从判断新鲜度)与工作区缓存缺失
      // (巨产物会话跳过聚焦,没有它首开将无人建缓存,浮层永久停在未对齐)。
      // 不可定位后端由聚焦对齐自建缓存,不为邻居会话付费
      if (!state.unlocatable && (state.unmaterialized || cached === null)) alignWorkspace(cwd)
      if (state.unlocatable || (state.stale && !state.oversize)) {
        let focus = pendingFocus.get(sessionId)
        if (!focus) {
          focus = alignSessionFocus(cwd, header).finally(() => pendingFocus.delete(sessionId))
          pendingFocus.set(sessionId, focus)
        }
        const done = await Promise.race([focus.then(() => true), sleep(HISTORY_FOCUS_WAIT_MS).then(() => false)])
        ;({ cached, mine } = await read())
        if (!done) return { inputs: mine, aligned: false }
        state = await check(cached)
        // 不可定位后端无指纹可收敛:聚焦对齐落定即视为已对齐(后续请求仍会重读)
        if (state.unlocatable) return { inputs: mine, aligned: cached !== null }
        if (state.stale) return { inputs: mine, aligned: false }
        return { inputs: mine, aligned: true }
      }
      return { inputs: mine, aligned: cached !== null }
    }
    if (scope === 'global') {
      // 浮层轮询路径:stat 指纹缓存,产物未变的文件不再重复读盘
      const caches = await listWorkspaceCachesCached(cacheDir)
      for (const cache of caches) alignWorkspace(cache.cwd)
      return { inputs: aggregateInputs(caches.flatMap((cache) => cache.entries), aggregateOptions), aligned: true }
    }
    const cached = await readWorkspaceCache(cacheDir, cwd)
    if (cwd !== undefined) alignWorkspace(cwd)
    return { inputs: aggregateInputs(cached ? cached.entries : [], aggregateOptions), aligned: cached !== null }
  }

  const routes = [
    {
      // 克隆仓库:resolveCloneRequest 校验(url 形态/父目录存在/目录名单段/目标
      // 不存在)后 git clone。单飞行守卫在请求体读完、即将执行克隆前置位:
      // 半开/超时请求不会占锁,冷启动排队请求也不会被读体窗口误判为并发。
      // 成功返回 target 路径,由 client 侧继续创建工作区并打开
      path: '/api/context/git-clone',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          if (cloneInFlight) {
            sendJson(res, 400, { error: CLONE_BUSY_MESSAGE })
            return
          }
          cloneInFlight = true
          try {
            const request = await resolveCloneRequest(body, {
              homedirPath: process.env.DSH_HOME || homedir(),
              // stat + readdir 归一四态:git 允许克隆进空目录,其余占用形态拒绝
              targetState: async (target) => {
                let info
                try {
                  info = await stat(target)
                } catch {
                  return TARGET_MISSING
                }
                if (!info.isDirectory()) return TARGET_FILE
                try {
                  return (await readdir(target)).length > 0 ? TARGET_NONEMPTY_DIR : TARGET_EMPTY_DIR
                } catch {
                  return TARGET_NONEMPTY_DIR
                }
              },
            })
            // 父目录必须存在:spawn 的 cwd 不存在同样抛 ENOENT,与 git 缺失同码,
            // 前置校验避免误报「git 不可用」
            const parentDir = parentOf(request.target)
            let parentInfo
            try {
              parentInfo = await stat(parentDir)
            } catch {
              parentInfo = null
            }
            if (!parentInfo || !parentInfo.isDirectory()) throw new Error('父目录不存在或不是目录:' + parentDir)
            const result = await runClone({ ...request, parent: parentDir, spawn, treeKill: killTree })
            if (ctx.logger) ctx.logger.info('context-manager 克隆完成: ' + result.path)
            sendJson(res, 200, { path: result.path })
          } finally {
            cloneInFlight = false
          }
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 克隆仓库按钮启停:与历史浮层开关同构,读走 settings,写经 settings.update
      path: '/api/context/clone-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).cloneEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { cloneEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).cloneEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/context/inputs',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'GET')) return
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = (url.searchParams.get('sessionId') || '').trim()
          if (sessionId === '') throw new Error('sessionId 不能为空')
          const scopeRaw = url.searchParams.get('scope') || 'session'
          const scope = HISTORY_SCOPES.includes(scopeRaw) ? scopeRaw : 'session'
          // 收藏范围读全局 prompts.json,与会话无关:不为几个收藏去解析会话头
          // (头部解析未命中即全量清单扫描,冷盘秒级),未知会话也照常返回
          const needsHeader = scope !== 'prompts'
          const header = needsHeader ? await findHeader(ctx, sessionId, headerCache) : undefined
          if (needsHeader && header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          // 子 agent 会话的会话范围没有历史聚合语义(对齐入口按 origin 拒绝):
          // 显式返回空且对齐,避免浮层永久停在未对齐并反复触发路由。
          // workspace/global 是工作区/全局聚合,与该会话是否为子会话无关,照常返回
          if (scope === 'session' && header !== undefined && isDerivedSessionHeader(header)) {
            sendJson(res, 200, { inputs: [], aligned: true })
            return
          }
          // workspace 范围依赖 cwd 归属;无 cwd 会话在 session 范围无从定位工作区缓存,
          // global 不依赖 cwd 照常聚合
          const result = scope === 'workspace' && header.cwd === undefined
            ? { inputs: [], aligned: true }
            : await collectInputs(scope, sessionId, header)
          sendJson(res, 200, result)
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 常用提示词收藏切换:text 已收藏则移除,否则收藏(截断与上限同历史输入)
      path: '/api/context/prompts/toggle',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const text = typeof body.text === 'string' ? body.text.trim().slice(0, HISTORY_INPUT_MAX_CHARS) : ''
          if (text === '') throw new Error('text 不能为空')
          let collected
          await updatePrompts(cacheDir, (items) => {
            const at = items.findIndex((item) => item.text === text)
            if (at >= 0) {
              items.splice(at, 1)
              collected = false
              return items
            }
            collected = true
            // 顺序是用户自定义的:新收藏置顶,超限一次裁剪到上限(淘汰收藏时间最旧的几条)
            return trimPrompts([{ text, at: Date.now() }].concat(items), HISTORY_PROMPTS_MAX)
          })
          sendJson(res, 200, { collected })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 常用提示词重命名:原位替换文本,顺序与收藏时间保持不变
      // (顺序是用户自定义的,重命名不得把条目搬到首位);目标文本已存在时合并
      path: '/api/context/prompts/rename',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const from = typeof body.from === 'string' ? body.from.trim().slice(0, HISTORY_INPUT_MAX_CHARS) : ''
          const to = typeof body.to === 'string' ? body.to.trim().slice(0, HISTORY_INPUT_MAX_CHARS) : ''
          if (from === '') throw new Error('from 不能为空')
          let result = 'missing'
          await updatePrompts(cacheDir, (items) => {
            const renamed = renamePromptItem(items, from, to)
            result = renamed.result
            return renamed.items
          })
          sendJson(res, 200, { result })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 常用提示词排序:数组顺序即用户自定义顺序(浮层编辑态拖动松手提交完整文本序)。
      // 未提及条目由 reorderPrompts 保尾——陈旧快照不得丢另一窗口新增的收藏
      path: '/api/context/prompts/reorder',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const texts = body && Array.isArray(body.texts) ? body.texts : null
          if (texts === null || !texts.every((text) => typeof text === 'string')) throw new Error('texts 必须是字符串数组')
          const items = await updatePrompts(cacheDir, (current) => reorderPrompts(current, texts))
          sendJson(res, 200, { texts: items.map((item) => item.text) })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 历史浮层启停:读走 settings(原生设置页与本分区开关同一存储),
      // 写经 settings.update,原生设置页与本分区即时同值
      path: '/api/context/history-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).historyEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { historyEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).historyEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 输入框历史按钮启停:与历史浮层开关同构,读走 settings,写经 settings.update
      path: '/api/context/history-button-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).historyButtonEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { historyButtonEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).historyButtonEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 插话撤回启停:与历史浮层开关同构,读走 settings,写经 settings.update
      path: '/api/context/steer-recall-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).steerRecallEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { steerRecallEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).steerRecallEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 插话撤回附件恢复:宿主 client 面只提供图片字节读取(SessionFace.readAttachment),
      // 文件附件没有读取通道;由 host 侧附件服务按 durable ref 流式回传原始字节。
      // 不声明进主 inject:旧宿主缺 attachments 时路由返回不可用,插件其余功能照常
      path: '/api/context/read-attachment',
      handler: async (req, res) => {
        try {
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          if (!body || body.kind !== 'file' || !body.attachment || typeof body.attachment !== 'object') {
            sendJson(res, 400, { error: MESSAGES.attachmentInvalid })
            return
          }
          if (typeof body.attachment.bytes === 'number' && body.attachment.bytes > ATTACHMENT_READ_MAX_BYTES) {
            sendJson(res, 400, { error: MESSAGES.attachmentTooLarge })
            return
          }
          const attachments = ctx.get('attachments')
          if (!attachments || typeof attachments.readFileStream !== 'function') {
            sendJson(res, 400, { error: MESSAGES.attachmentUnavailable })
            return
          }
          const controller = new AbortController()
          const abort = () => { if (!res.writableEnded) controller.abort() }
          if (typeof res.once === 'function') res.once('close', abort)
          try {
            let headersSent = false
            let total = 0
            for await (const chunk of attachments.readFileStream(body.attachment, controller.signal)) {
              const buffer = Buffer.from(chunk)
              total += buffer.length
              if (total > ATTACHMENT_READ_MAX_BYTES) throw new Error(MESSAGES.attachmentTooLarge)
              if (!headersSent) {
                res.writeHead(200, { 'content-type': 'application/octet-stream' })
                headersSent = true
              }
              if (!res.write(buffer)) {
                if (res.destroyed || res.writableEnded) return
                await new Promise((resolve) => {
                  const finish = () => {
                    if (typeof res.off === 'function') {
                      res.off('drain', finish)
                      res.off('close', finish)
                    }
                    resolve()
                  }
                  res.once('drain', finish)
                  res.once('close', finish)
                })
                if (res.destroyed || res.writableEnded) return
              }
            }
            if (!headersSent) res.writeHead(200, { 'content-type': 'application/octet-stream' })
            res.end()
          } finally {
            if (typeof res.off === 'function') res.off('close', abort)
          }
        } catch (error) {
          if (res.headersSent) { res.destroy(error); return }
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 对话 fork 启停:与历史浮层开关同构,读走 settings,写经 settings.update
      path: '/api/context/fork-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).forkEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { forkEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).forkEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 分叉后自动重发启停:默认关(仅回填供编辑);读走 settings,写经 settings.update
      path: '/api/context/fork-auto-resend-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).forkAutoResendEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { forkAutoResendEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).forkAutoResendEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      // 标题栏复制 sessionId 启停:与历史浮层开关同构,读走 settings,写经 settings.update
      path: '/api/context/copy-sid-enabled',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { enabled: readSettings(ctx, config).copySidEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          const body = await readJsonBody(req)
          await persistToggle(ctx, { copySidEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx, config).copySidEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: withRouteGate(ctx, route.handler) }),
      'dsh-context-manager ' + route.path)
  }

  ctx.inject(['settings'], (settingsCtx) => {
    // 方法面守卫:settings 服务缺 register 面(0.1.7 已移除)即走新形态分支;
    // 0.1.7 关闭原生自动设置页,设置面由本包自带分区承担(maintain 同构)
    if (typeof settingsCtx.settings.register !== 'function') {
      if (typeof settingsCtx.settings?.configure === 'function') {
        settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
      }
      return
    }
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: config })
  })
}

// header 查找缓存:inputs 路由每次请求都要查 header,listSessions 为全量扫描
// (单次数百 ms,与后台对齐并发时成倍放大),而 sessionId→header 基本不变——
// 扫一次进缓存,TTL 界定新鲜度,容量上限防无界增长;只缓存命中,
// 未命中不缓存(新会话创建竞态下次扫描即命中,负缓存会误伤)。
// 与 session-manager 各持独立实例,互不共享状态
const HEADER_CACHE_TTL_MS = 10 * 60 * 1000
const HEADER_CACHE_MAX = 500

// 子 agent 会话判定:origin 权威;无 origin 的旧记录按 parentSession + delegationDepth
// (普通 fork 的 depth 为 0,不算)
function isDerivedSessionHeader(header) {
  if (!header) return false
  if (header.origin === 'subagent') return true
  return header.parentSession !== undefined && (header.delegationDepth ?? 0) >= 1
}

function rememberHeader(cache, sessionId, header) {
  if (cache.size >= HEADER_CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(sessionId, { header, at: Date.now() })
}

function findHeader(ctx, sessionId, cache) {
  const hit = cache.get(sessionId)
  if (hit && Date.now() - hit.at < HEADER_CACHE_TTL_MS) return Promise.resolve(hit.header)
  // 活会话注册表直查:零 IO。历史浮层只在当前会话内打开,该会话必然在册,
  // 常规路径因此完全不触碰全量清单扫描
  const live = ctx.sessions ? ctx.sessions.get(sessionId) : undefined
  const liveHeader = live && live.header ? live.header : undefined
  if (liveHeader !== undefined) {
    rememberHeader(cache, sessionId, liveHeader)
    return Promise.resolve(liveHeader)
  }
  return ctx.sessionQuery.listSessions().then((records) => {
    const found = records.find((recordItem) => String(recordItem.header.id) === sessionId)
    if (!found) return undefined
    rememberHeader(cache, sessionId, found.header)
    return found.header
  })
}

// win32 路径大小写不敏感:realpath 已规范大小写,但比对侧可能存在大小写漂移
function samePath(left, right) {
  if (left === right) return true
  return process.platform === 'win32' && String(left).toLowerCase() === String(right).toLowerCase()
}
