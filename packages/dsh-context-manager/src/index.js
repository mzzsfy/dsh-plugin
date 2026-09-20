// dsh-context-manager Host 半区:历史输入工作区缓存对齐 + 启停/数据路由
// (inputs / prompts/toggle 与 history/history-button/steer-recall/fork/fork-auto-resend/copy-sid
// 六条启停)。
// 浮层请求直接读缓存文件立即返回;对齐在后台解压范围内会话产物与缓存合并写回,
// 运行中会话也参与(实时追加其新输入)。fork 分叉动作走 client 服务面,
// host 侧只有其启停路由。
// 插话撤回启停与历史浮层启停读走 settings(原生设置页与本分区开关同一存储)。

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import schemastery from '@deepseek-ai/schemastery'

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
} from './core.mjs'
import { ensureCacheDir, listWorkspaceCachesCached, readPrompts, readWorkspaceCache, writePrompts, writeWorkspaceCache } from './history-cache.mjs'
import { createRequire } from 'node:module'

export const name = 'dsh-context-manager'

export const inject = ['webServer', 'agents', 'sessionQuery', 'sessionPersistence']

const NAMESPACE = 'context'

// 路由响应文案;导出供测试断言与实现同步。
export const MESSAGES = {
  unknownSession: '会话不存在',
  badJsonBody: '请求体不是合法 JSON',
  systemError: '操作失败(系统级错误,详见服务端日志)',
}

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
})

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 错误响应出口:业务错误(Error 无错误码)原样透传消息;系统级错误(带 fs 错误码,
// message 内嵌绝对路径)收敛为固定文案,原始错误仅进服务端日志
function respondError(ctx, res, error) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && ctx.logger) ctx.logger.warn('context-manager 系统级错误: ' + String(error && error.stack || error))
  const message = isSystem
    ? MESSAGES.systemError
    : (error && error.message ? error.message : String(error))
  sendJson(res, 400, { error: message })
}

function readSettings(ctx) {
  const settings = ctx.get('settings')
  const value = settings ? settings.get(NAMESPACE) : undefined
  return {
    historyEnabled: !value || value.historyEnabled !== false,
    historyButtonEnabled: !value || value.historyButtonEnabled !== false,
    steerRecallEnabled: !value || value.steerRecallEnabled !== false,
    forkEnabled: !value || value.forkEnabled !== false,
    forkAutoResendEnabled: Boolean(value && value.forkAutoResendEnabled === true),
    copySidEnabled: !value || value.copySidEnabled !== false,
  }
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
  // STARTUP_DELAY 再跑,绝不阻塞宿主启动。测试经 env DSH_HISTORY_CACHE_DIR 注入临时目录
  const cacheDir = process.env.DSH_HISTORY_CACHE_DIR
    || join(homedir(), '.dsh', 'historyPrompt')
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
  // 批量任务的分钟级解压堵死。两车道并发写同一工作区缓存时,最坏丢一次
  // 更新,但批量窗口必含活跃会话(其自身重读即收敛),下轮指纹失配自愈
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

  // 单会话提取:产物 stat 指纹与缓存一致即复用(零解压);否则解压并更新缓存。
  // 运行中会话走内存指纹(runtimeExtracts),其余走磁盘 extracts。
  // 指纹之外校验提取器版本:版本不符即重解压(升级后旧条目自动补齐新格式)
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
    if (isRunning) runtimeExtracts.set(sessionId, record)
    else if (fingerprint !== null) extracts[sessionId] = record
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
      // subagent 会话不在主列表(官方 sessionVisible 以 origin 排除):其输入是
      // 任务提示与注入文本而非人类输入,且会以更近的产物时间挤占扫描窗口,必须排除
      const window = records
        .filter((recordItem) => recordItem.header.origin !== 'subagent'
          && recordItem.header.cwd !== undefined && samePath(recordItem.header.cwd, cwd))
        .slice(0, HISTORY_SESSION_SCAN_LIMIT)
      // 该 cwd 无主会话(纯 subagent 派生或已清空):无可对齐内容,缓存读写一并跳过
      if (window.length === 0) return
      const cached = await readWorkspaceCache(cacheDir, cwd)
      const extracts = cached && cached.extracts ? { ...cached.extracts } : {}
      const fresh = []
      let sliceStart = Date.now()
      for (const recordItem of window) {
        const isRunning = isSessionRunning({ agents, sessionId: recordItem.header.id })
        const located = persistence ? persistence.locate(recordItem.header) : undefined
        const fingerprint = located ? await safeStat(located.path) : null
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
      // extracts 裁剪:仅保留窗口内非运行会话(运行中走内存,窗口外已淘汰)
      const windowIds = new Set(window.map((recordItem) => recordItem.header.id))
      const prunedExtracts = {}
      for (const [sessionId, record] of Object.entries(extracts)) {
        if (windowIds.has(sessionId) && !isSessionRunning({ agents, sessionId })) prunedExtracts[sessionId] = record
      }
      // 既往污染自愈:旧版本窗口未排除 subagent,其条目已混入缓存 entries——
      // 合并前按列表 origin 识别清除;会话已删除的条目无法识别,随时间被挤出
      const subagentIds = new Set(records
        .filter((recordItem) => recordItem.header.origin === 'subagent')
        .map((recordItem) => recordItem.header.id))
      const legacyEntries = subagentIds.size === 0 ? (cached ? cached.entries : [])
        : (cached ? cached.entries : []).filter((entry) => entry.sid === undefined || !subagentIds.has(entry.sid))
      const merged = aggregateInputs(
        legacyEntries.concat(fresh),
        { limit: HISTORY_INPUT_LIMIT, maxChars: HISTORY_INPUT_MAX_CHARS },
      )
      await writeWorkspaceCache(cacheDir, cwd, { entries: merged, extracts: prunedExtracts })
    })
  }

  // 焦点对齐执行体:只解目标会话并写回(实时追加路径),走独立焦点车道,
  // 不被批量车道的分钟级解压堵死。不裁剪 extracts(裁剪由批量对齐负责),
  // 只新增/更新目标会话指纹
  function alignSessionFocus(cwd, header) {
    return enqueueFocusAlign(async () => {
      // 与批量窗口同一不变式:缓存只收主会话输入(正常 UI 不可达,防直调路由)
      if (header.origin === 'subagent') return
      const sessionId = header.id
      const persistence = ctx.get('sessionPersistence')
      const located = persistence ? persistence.locate(header) : undefined
      const fingerprint = located ? await safeStat(located.path) : null
      if (fingerprint === null || fingerprint.size > maxArtifactBytes) return
      const isRunning = isSessionRunning({ agents: ctx.get('agents'), sessionId })
      const cached = await readWorkspaceCache(cacheDir, cwd)
      const extracts = cached && cached.extracts ? { ...cached.extracts } : {}
      const entries = await extractSession({ header }, fingerprint, extracts, isRunning)
      const merged = aggregateInputs(
        (cached ? cached.entries : []).concat(entries.map((entry) => ({ ...entry, sid: sessionId }))),
        { limit: HISTORY_INPUT_LIMIT, maxChars: HISTORY_INPUT_MAX_CHARS },
      )
      await writeWorkspaceCache(cacheDir, cwd, { entries: merged, extracts })
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
          .filter((item) => item.header.origin !== 'subagent')
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

  // 按范围读取历史:全部直接读持久缓存(毫秒级)立即返回,对齐由后台进行;
  // aligned=false 表示数据未就绪(首次无缓存,或请求会话产物已变而缓存未跟上),
  // client 据此提示等待并静默重拉
  async function collectInputs(scope, sessionId, header) {
    const aggregateOptions = { limit: HISTORY_INPUT_LIMIT, maxChars: HISTORY_INPUT_MAX_CHARS }
    const cwd = header.cwd
    if (scope === 'prompts') {
      const items = await readPrompts(cacheDir)
      return { inputs: aggregateInputs(items, aggregateOptions), aligned: true }
    }
    if (scope === 'session') {
      if (cwd === undefined) return { inputs: [], aligned: true }
      alignWorkspace(cwd)
      const read = async () => {
        const cached = await readWorkspaceCache(cacheDir, cwd)
        return {
          cached,
          mine: aggregateInputs(cached ? cached.entries.filter((entry) => entry.sid === sessionId) : [], aggregateOptions),
        }
      }
      // 实时追加:产物 stat 与已知指纹不一致 = 会话有新输入未入缓存——聚焦对齐
      // 只解该会话并写回。提取器版本不符同判 stale(升级后旧格式条目在首请求
      // 内经聚焦对齐补齐,不等后台批量)。路由有界等待本次对齐(首条 <3s 预算):
      // 正常会话单次请求内直接拿到新数据;超时(巨产物等)返回既有数据 aligned=false,
      // 后续轮询流式补齐。巨产物跳过聚焦(解压耗时与内存峰值失控),维持 aligned=true
      const check = async (cached) => {
        const agents = ctx.get('agents')
        const running = isSessionRunning({ agents, sessionId })
        const known = running ? runtimeExtracts.get(sessionId) : cached && cached.extracts ? cached.extracts[sessionId] : undefined
        const located = ctx.get('sessionPersistence') ? ctx.get('sessionPersistence').locate(header) : undefined
        const fingerprint = located ? await safeStat(located.path) : null
        return {
          stale: fingerprint !== null && !(known && known.v === HISTORY_EXTRACT_VERSION && known.mtimeMs === fingerprint.mtimeMs && known.size === fingerprint.size),
          oversize: fingerprint !== null && fingerprint.size > maxArtifactBytes,
        }
      }
      let { cached, mine } = await read()
      let { stale, oversize } = await check(cached)
      if (stale && !oversize) {
        let focus = pendingFocus.get(sessionId)
        if (!focus) {
          focus = alignSessionFocus(cwd, header).finally(() => pendingFocus.delete(sessionId))
          pendingFocus.set(sessionId, focus)
        }
        const done = await Promise.race([focus.then(() => true), sleep(HISTORY_FOCUS_WAIT_MS).then(() => false)])
        ;({ cached, mine } = await read())
        ;({ stale } = await check(cached))
        if (!done || stale) return { inputs: mine, aligned: false }
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
      path: '/api/context/inputs',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'GET')) return
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = (url.searchParams.get('sessionId') || '').trim()
          if (sessionId === '') throw new Error('sessionId 不能为空')
          const scopeRaw = url.searchParams.get('scope') || 'session'
          const scope = HISTORY_SCOPES.includes(scopeRaw) ? scopeRaw : 'session'
          const header = await findHeader(ctx, sessionId, headerCache)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
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
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const text = typeof body.text === 'string' ? body.text.trim().slice(0, HISTORY_INPUT_MAX_CHARS) : ''
          if (text === '') throw new Error('text 不能为空')
          const items = await readPrompts(cacheDir)
          const at = items.findIndex((item) => item.text === text)
          let collected
          if (at >= 0) {
            items.splice(at, 1)
            collected = false
          } else {
            items.unshift({ text, at: Date.now() })
            if (items.length > HISTORY_PROMPTS_MAX) items.length = HISTORY_PROMPTS_MAX
            collected = true
          }
          await writePrompts(cacheDir, items)
          sendJson(res, 200, { collected })
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
            sendJson(res, 200, { enabled: readSettings(ctx).historyEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const settings = ctx.get('settings')
          if (!settings) throw new Error('宿主设置服务不可用')
          // update 异步落盘后才提交新值:await 保证持久化完成后再读回
          await settings.update(NAMESPACE, { historyEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx).historyEnabled })
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
            sendJson(res, 200, { enabled: readSettings(ctx).historyButtonEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const settings = ctx.get('settings')
          if (!settings) throw new Error('宿主设置服务不可用')
          // update 异步落盘后才提交新值:await 保证持久化完成后再读回
          await settings.update(NAMESPACE, { historyButtonEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx).historyButtonEnabled })
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
            sendJson(res, 200, { enabled: readSettings(ctx).steerRecallEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const settings = ctx.get('settings')
          if (!settings) throw new Error('宿主设置服务不可用')
          // update 异步落盘后才提交新值:await 保证持久化完成后再读回
          await settings.update(NAMESPACE, { steerRecallEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx).steerRecallEnabled })
        } catch (error) {
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
            sendJson(res, 200, { enabled: readSettings(ctx).forkEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const settings = ctx.get('settings')
          if (!settings) throw new Error('宿主设置服务不可用')
          // update 异步落盘后才提交新值:await 保证持久化完成后再读回
          await settings.update(NAMESPACE, { forkEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx).forkEnabled })
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
            sendJson(res, 200, { enabled: readSettings(ctx).forkAutoResendEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const settings = ctx.get('settings')
          if (!settings) throw new Error('宿主设置服务不可用')
          await settings.update(NAMESPACE, { forkAutoResendEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx).forkAutoResendEnabled })
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
            sendJson(res, 200, { enabled: readSettings(ctx).copySidEnabled })
            return
          }
          if (!rejectMethod(req, res, 'POST')) return
          let body
          try {
            body = JSON.parse(await readBody(req))
          } catch {
            throw new Error(MESSAGES.badJsonBody)
          }
          const settings = ctx.get('settings')
          if (!settings) throw new Error('宿主设置服务不可用')
          await settings.update(NAMESPACE, { copySidEnabled: Boolean(body && body.enabled) })
          sendJson(res, 200, { enabled: readSettings(ctx).copySidEnabled })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-context-manager ' + route.path)
  }

  ctx.inject(['settings'], (settingsCtx) => {
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

// win32 路径大小写不敏感:realpath 已规范大小写,但比对侧可能存在大小写漂移
function samePath(left, right) {
  if (left === right) return true
  return process.platform === 'win32' && String(left).toLowerCase() === String(right).toLowerCase()
}
