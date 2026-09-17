// 纯逻辑层:历史输入提取/聚合、subagent 排除、fork 锚点与错误文案。
// 全部为无副作用纯函数,host 与测试共用。

// 历史输入回溯参数:host 聚合路由使用(client 单文件自包含不经此,展示侧另行内联)。
// 范围按 ←/→ 切换序排列:索引 0 为常用提示词(个人收藏),索引 1 为当前会话
// (浮层默认落点),→ 向更大范围,← 返回收藏
// 对齐 = 后台解压范围内会话产物与持久缓存合并;两次对齐最小间隔防持续解压。
// 解压是 CPU 操作:启动零解压(历史直接读磁盘缓存),全量对齐延迟 STARTUP_DELAY
// 再跑、只回溯最近 STARTUP_SCAN 个会话;超 MAX_ARTIFACT 的巨产物跳过——
// 上限防的是解压耗时与事件对象内存峰值失控,非阻塞主循环;跳过线按宿主版本
// 黑名单取值(见 isLegacyDecompressHost),对齐中连续解压占用超 SLICE 即让出 YIELD。
// 运行中会话(当前会话)提取结果只保留内存不落盘——产物持续变化,落盘指纹立即失效
// 扫描窗口按主会话计(subagent 已排除):放宽到与启动回溯一致——extracts 指纹
// 缓存使扩大窗口的持续成本仅限新会话的一次性解压,产物未变的会话零解压
export const HISTORY_SESSION_SCAN_LIMIT = 100
export const HISTORY_INPUT_LIMIT = 200
export const HISTORY_INPUT_MAX_CHARS = 20 * 1000
export const HISTORY_SCOPES = ['prompts', 'session', 'workspace', 'global']
export const HISTORY_PROMPTS_MAX = 100
export const HISTORY_ALIGN_THROTTLE_MS = 30 * 1000
export const HISTORY_STARTUP_DELAY_MS = 30 * 1000
export const HISTORY_STARTUP_SCAN_LIMIT = 100
export const HISTORY_ALIGN_SLICE_MS = 200
export const HISTORY_ALIGN_YIELD_MS = 100
// 巨产物跳过线(压缩字节数):现役最大产物约 3.5MiB。新解压线 16MiB 留 4 倍余量,
// 超线产物解压后可达数百 MB(压缩比约 1:3.4,事件对象再放大),内存峰值失控;
// 旧解压线 8MiB 面向 0.1.1/0.1.2 黑名单宿主——其解压实现尚无周期让出,从严
export const HISTORY_ALIGN_MODERN_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
// 与官方 semver 语义对齐的宽松校验:黑名单判定只取主/次/修订号,prerelease 无关
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/
// 旧解压实现黑名单:仅 0.1.1 与 0.1.2 系列(含各 prerelease);0.1.5 实测
// readZstdPrefix 逐帧解压 + 周期让出。版本非法/缺失按黑名单保守回退旧线
export function isLegacyDecompressHost(version) {
  const match = SEMVER_PATTERN.exec(typeof version === 'string' ? version.trim() : '')
  if (!match) return true
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major === 0 && minor === 1 && (patch === 1 || patch === 2)
}
export function maxArtifactBytesForHost(version) {
  return isLegacyDecompressHost(version) ? HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES : HISTORY_ALIGN_MODERN_MAX_ARTIFACT_BYTES
}
// 会话范围路由触发焦点对齐后就地等待的时限:首条数据可见预算(3s)内
// 留出解压+读盘份额,超时改走轮询流式补齐
export const HISTORY_FOCUS_WAIT_MS = 2 * 1000

/** 运行中判定:agent 注册表 status 为 running 即运行中。 */
export function isSessionRunning({ agents, sessionId }) {
  const entry = agents ? agents.get(sessionId) : undefined
  return Boolean(entry && entry.status === 'running')
}

/**
 * 从会话事件流提取人类输入:仅 user/message 且来源为用户本人,
 * 文本块按行拼接;工具结果回填、插件注入与空白输入(纯图/空/纯空白)均不产出。
 * @param events - readSession 返回的原始事件数组
 * @returns 条目 { text, at },时间取事件时间
 */
export function extractUserInputs(events) {
  const entries = []
  for (const event of events || []) {
    if (!event || event.type !== 'user/message') continue
    const message = event.data
    if (!message || !message.source || message.source.kind !== 'user') continue
    const text = (message.content || [])
      .filter((block) => block && block.type === 'text' && block.text !== '')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() === '') continue
    entries.push({ text, at: event.time })
  }
  return entries
}

/** 历史输入聚合:精确文本去重保留最新时间,时间倒序,截 limit 条,单条截 maxChars 字符。
 * 条目可携带 sid(来源会话)用于 session 范围过滤,聚合时原样保留。
 * 首条保护:被 limit 挤出时,每个来源会话在去重后集合中的最早条目仍保留——
 * 会话开场提示词是最有复用价值也最旧的一批,时间倒序截断总会先挤掉它们;
 * 保护在去重后集合上计算,文本已被更新的会话复用时不再按旧会话重复追加。 */
export function aggregateInputs(entries, { limit, maxChars }) {
  const latestByText = new Map()
  for (const entry of entries || []) {
    const known = latestByText.get(entry.text)
    if (known === undefined || entry.at > known.at) latestByText.set(entry.text, entry)
  }
  const earliestBySid = new Map()
  for (const entry of latestByText.values()) {
    if (entry.sid === undefined) continue
    const known = earliestBySid.get(entry.sid)
    if (known === undefined || entry.at < known.at) earliestBySid.set(entry.sid, entry)
  }
  const kept = [...latestByText.values()].sort((left, right) => right.at - left.at).slice(0, limit)
  const keptTexts = new Set(kept.map((entry) => entry.text))
  for (const first of earliestBySid.values()) {
    if (!keptTexts.has(first.text)) kept.push(first)
  }
  return kept
    .sort((left, right) => right.at - left.at)
    .map((entry) => ({
      text: entry.text.slice(0, maxChars),
      at: entry.at,
      ...(entry.sid !== undefined ? { sid: entry.sid } : {}),
    }))
}

/**
 * 历史浮层搜索:查询词去首尾空白后按不区分大小写子串匹配条目文本,
 * 空查询原样返回全量。client.js 有镜像实现(单文件自包含无法跨文件 require),
 * 修改需两处同步。
 */
export function filterHistoryInputs(entries, query) {
  const list = Array.isArray(entries) ? entries : []
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return list
  return list.filter((entry) => String((entry && entry.text) ?? '').toLowerCase().includes(needle))
}

// ── 对话 fork:锚点解析与错误文案(client 注入层消费的纯函数) ──

/**
 * fork 错误文案映射:宿主 RemoteError code → 用户可读中文。
 * @param code - SessionForkError 携带的 rpcError code,未知 code 原样透出
 */
export function forkFailureText(code) {
  if (code === 'session/fork-unavailable') return '该轮尚未完成,不可分叉'
  if (code === 'session/workspace-attach-failed') return '分叉成功,但挂载到工作区失败'
  return '分叉失败: ' + String(code ?? '未知错误')
}

/**
 * 从一条 user/message 事件提取重试文本:仅来源为用户本人,文本块按行拼接;
 * 空白或无文本块(纯图片等)返回 null——无法回填重试的轮不提供分叉按钮。
 * client.js 有镜像实现(单文件自包含无法跨文件 require),修改需两处同步。
 * @param data - user/message 事件 data(UserMessage 形状)
 */
export function forkRetryText(data) {
  const message = data && typeof data === 'object' ? data : {}
  if (!message.source || message.source.kind !== 'user') return null
  const text = (Array.isArray(message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && block.text !== '')
    .map((block) => block.text)
    .join('\n')
  return text.trim() === '' ? null : text
}

/**
 * 家族谱系投影:按 parentSessionId 把会话行组装成「根 → 后代」链,
 * parentSessionId 断链(引用的父不在集合内)的行视为独立根。
 * 编排派生会话(origin === 'subagent')不是用户的 fork 版本,整行剔除,
 * 其后代随之断链成独立根——家族只统计用户可跳转的对话分支。
 * @param items - sessions.list 行数组(至少含 sessionId/parentSessionId)
 * @returns Map<sessionId, { root, chain: string[] }>——chain 为根到自身的 id 序列
 */
export function sessionFamilyMap(items) {
  const byId = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item && item.origin === 'subagent') continue
    const id = item && (item.sessionId ?? item.id)
    if (typeof id === 'string' && id !== '') byId.set(id, item)
  }
  const chains = new Map()
  for (const id of byId.keys()) {
    const chain = []
    let cursor = id
    let root = cursor
    while (cursor !== undefined) {
      chain.unshift(cursor)
      root = cursor
      const parent = byId.get(cursor)
      cursor = parent && typeof parent.parentSessionId === 'string' && byId.has(parent.parentSessionId)
        ? parent.parentSessionId
        : undefined
      if (chain.includes(cursor)) break
    }
    chains.set(id, { root, chain, item: byId.get(id) })
  }
  return chains
}

/**
 * 家族环计数:某会话在所属家族中的序位与成员数(按 updatedAt 升序,与分叉先后一致)。
 * 单成员家族返回 null(不渲染计数器)。
 * @param chains - sessionFamilyMap 的结果
 * @param sessionId - 目标会话
 */
export function familyRing(chains, sessionId) {
  const entry = chains instanceof Map ? chains.get(sessionId) : undefined
  if (!entry) return null
  const members = [...chains.entries()]
    .filter(([, value]) => value.root === entry.root)
    .sort((left, right) => {
      const at = (record) => (record && record.item && typeof record.item.updatedAt === 'number' ? record.item.updatedAt : 0)
      return at(left[1]) - at(right[1])
    })
    .map(([id]) => id)
  if (members.length < 2) return null
  return { index: members.indexOf(sessionId) + 1, total: members.length, members }
}
