// dsh-maintain 纯逻辑层:零宿主依赖,host 半区 import,单测直接覆盖。
// 版本比较内嵌 semver@7 的解析与比较语义(部署位置为 pnpm 布局,npm 依赖不可解析,
// 手写易错,故忠实照抄库规则:主次修订数值序,prerelease 标识符数值/字母双规则)。

import { posix, win32 } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

export const VERDICT_OUTDATED = 'outdated'
export const VERDICT_UP_TO_DATE = 'up-to-date'
export const VERDICT_UNKNOWN = 'unknown'

export const TARGET_PACKAGE = '@deepseek-ai/dsh'
export const TAG_PLACEHOLDER = '{tag}'
export const DIST_TAGS_PATH = '/-/package/' + encodeURIComponent(TARGET_PACKAGE) + '/dist-tags'

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const NUMERIC_PATTERN = /^\d+$/

// 解析失败一律 null,判定层据此给 unknown,不抛错。
export function parseSemver(version) {
  const text = typeof version === 'string' ? version.trim() : ''
  const match = SEMVER_PATTERN.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map((id) => (NUMERIC_PATTERN.test(id) ? Number(id) : id)) : [],
    build: match[5] || null,
  }
}

// semver 规则:数字标识符按数值,字母按 ASCII,数字恒小于字母;前缀全等时短者小;数字与字母比较时数字小。
function compareIdentifiers(a, b) {
  const aNumeric = NUMERIC_PATTERN.test(a)
  const bNumeric = NUMERIC_PATTERN.test(b)
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b))
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const order = compareIdentifiers(a[index], b[index])
    if (order !== 0) return order
  }
  return Math.sign(a.length - b.length)
}

// 任一版本非法返回 NaN 表示不可比较;gt 语义下按 false 处理。
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return NaN
  const main = Math.sign(left.major - right.major) || Math.sign(left.minor - right.minor) || Math.sign(left.patch - right.patch)
  return main !== 0 ? main : comparePrerelease(left.prerelease, right.prerelease)
}

export function gtSemver(a, b) {
  return compareSemver(a, b) === 1
}

// 判定当前版本相对追踪通道是否落后;信息不足一律 unknown 并给 reason,不抛错。
export function judgeVersion({ currentVersion, tags, channel }) {
  if (!currentVersion || !tags || typeof tags !== 'object') {
    return { channelLatest: null, verdict: VERDICT_UNKNOWN, reason: '版本信息尚未就绪' }
  }
  if (!Object.prototype.hasOwnProperty.call(tags, channel) || typeof tags[channel] !== 'string') {
    return { channelLatest: null, verdict: VERDICT_UNKNOWN, reason: '通道 ' + channel + ' 不在 dist-tags 中' }
  }
  const channelLatest = tags[channel]
  if (!parseSemver(currentVersion)) {
    return { channelLatest, verdict: VERDICT_UNKNOWN, reason: '当前版本不是合法 semver: ' + currentVersion }
  }
  if (!parseSemver(channelLatest)) {
    return { channelLatest, verdict: VERDICT_UNKNOWN, reason: '通道版本不是合法 semver: ' + channelLatest }
  }
  const verdict = gtSemver(channelLatest, currentVersion) ? VERDICT_OUTDATED : VERDICT_UP_TO_DATE
  return { channelLatest, verdict, reason: null }
}

// 运行/已装版本区分:磁盘版本严格领先运行版本即待重启生效;任一侧不可解析一律 false 不误报。
export function isVersionPendingRestart({ runningVersion, installedVersion }) {
  return Boolean(parseSemver(runningVersion) && parseSemver(installedVersion) && gtSemver(installedVersion, runningVersion))
}

// 升级后磁盘版本复读判定:stale=版本未前进(镜像滞后/静默未升)或未达通道目标。
// previous 未知或目标缺失时无法证明未达标,宽松判 fresh 不误报。
export function judgeUpgradeFreshness({ previousVersion, installedVersion, channelLatest }) {
  if (!parseSemver(installedVersion)) {
    return { stale: true, reason: '升级后磁盘版本解析失败' + (installedVersion ? ': ' + installedVersion : '(读取失败)') }
  }
  if (parseSemver(previousVersion) && !gtSemver(installedVersion, previousVersion)) {
    return { stale: true, reason: '磁盘版本未前进,升级可能静默失败或镜像滞后: ' + installedVersion }
  }
  if (parseSemver(previousVersion) && parseSemver(channelLatest) && gtSemver(channelLatest, installedVersion)) {
    return { stale: true, reason: '已升级但未达通道目标: ' + installedVersion + ' < ' + channelLatest }
  }
  return { stale: false, reason: null }
}

// 升级失败分类 kind 常量;导出供重试循环与测试对拍
export const UPGRADE_FAIL_TRANSIENT_NETWORK = 'transient-network'
export const UPGRADE_FAIL_FILE_LOCKED = 'file-locked'
export const UPGRADE_FAIL_NPM_MISSING = 'npm-missing'
export const UPGRADE_FAIL_TIMEOUT = 'timeout'
export const UPGRADE_FAIL_UNKNOWN = 'unknown'

// 特征宽松:未命中一律归 unknown 不可重试,绝不误判重试不可重试类。
// 文件锁特征(npm error code EBUSY/EPERM 等 Windows 全局目录占用形态);
// ENOENT 与 rename/unlink 分行输出,故窗口跨行。
const FILE_LOCKED_PATTERN = /EBUSY|EPERM|ENOENT[\s\S]{0,200}(?:rename|unlink)|resource busy|being used by another process/i
const NPM_ERROR_MARKER = 'npm error'
// 命令未找到形态:cmd 与 sh 的报错文案 + spawn 失败裸 ENOENT(无 npm error 前缀)
const COMMAND_MISSING_PATTERN = /不是内部或外部命令|command not found|not found/i
const ENOENT_PATTERN = /\bENOENT\b/i
// 网络瞬断特征:常见 errno + socket/fetch 文案 + registry 5xx 形态(E503/HTTP 5xx)
const TRANSIENT_NETWORK_PATTERN = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network|\bE5\d{2}\b|HTTP 5\d{2}/i

// 升级单次尝试失败分类:超时强杀最优先(超时绝不重试),其余按输出特征匹配。
// 合并 stderr 与 stdout 尾流:npm 的 code/syscall 行在 stderr,部分形态在 stdout。
export function classifyUpgradeFailure({ code, timedOut, stdoutTail, stderrTail } = {}) {
  const text = String(stderrTail ?? '') + '\n' + String(stdoutTail ?? '')
  if (timedOut === true) {
    return { kind: UPGRADE_FAIL_TIMEOUT, retryable: false, reason: '升级命令超时被强制终止' }
  }
  if (FILE_LOCKED_PATTERN.test(text)) {
    return { kind: UPGRADE_FAIL_FILE_LOCKED, retryable: true, reason: '全局目录文件被占用(杀毒/索引服务或并行进程)' }
  }
  const hasNpmErrorPrefix = text.includes(NPM_ERROR_MARKER)
  if (COMMAND_MISSING_PATTERN.test(text) && !hasNpmErrorPrefix) {
    return { kind: UPGRADE_FAIL_NPM_MISSING, retryable: false, reason: '命令未找到,检查升级命令模板' }
  }
  if (ENOENT_PATTERN.test(text) && !hasNpmErrorPrefix) {
    return { kind: UPGRADE_FAIL_NPM_MISSING, retryable: false, reason: '命令未找到,检查升级命令模板' }
  }
  if (TRANSIENT_NETWORK_PATTERN.test(text)) {
    return { kind: UPGRADE_FAIL_TRANSIENT_NETWORK, retryable: true, reason: '网络瞬断或 registry 暂不可用' }
  }
  return { kind: UPGRADE_FAIL_UNKNOWN, retryable: false, reason: '未识别的失败形态' }
}

// 模板占位符执行时替换;模板允许不含占位符(用户整体自改命令),空模板拒绝。
// tag 经白名单校验:tag 名来自远端 registry 数据,拼入 shell 命令前单点拦截
// shell 元字符,封死"远端数据回流成命令"通路。
// 形态对齐 npm dist-tag 规则:仅 ASCII 字母数字-._,首尾为字母数字,长度上限 214。
const CHANNEL_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-_.]*[0-9A-Za-z]$|^[0-9A-Za-z]$/
const CHANNEL_NAME_MAX_LENGTH = 214

export function isValidChannelName(channel) {
  return typeof channel === 'string'
    && channel.length > 0
    && channel.length <= CHANNEL_NAME_MAX_LENGTH
    && CHANNEL_NAME_PATTERN.test(channel)
}

export function buildUpgradeCommand({ template, tag }) {
  const text = typeof template === 'string' ? template.trim() : ''
  if (text.length === 0) throw new Error('升级命令模板为空,拒绝执行')
  if (!isValidChannelName(tag)) throw new Error('通道名含非法字符,拒绝执行: ' + tag)
  return text.split(TAG_PLACEHOLDER).join(tag)
}

// 重启后是否整页刷新:prev/next 为 {lost,pid,bootAt} 快照。
// lost=经历失联后恢复(强信号);bootAt=宿主进程启动时刻,变化即重启——容器内 pid 恒 1
// 且停机时长小于轮询间隔(零失联)时这是唯一可靠信号;pid 比对是 bootAt 缺失(旧宿主
// 未上报)时的退化路径。判定必须收敛在本函数,core 与 client LOGIC 段镜像,parity 对拍。
export function shouldReloadAfterRestart(prev, next) {
  if (prev.lost) return true
  if (typeof prev.bootAt === 'number' && typeof next.bootAt === 'number') return prev.bootAt !== next.bootAt
  return typeof prev.pid === 'number' && typeof next.pid === 'number' && prev.pid !== next.pid
}

// registry 基地址必须是 http(s) 地址(RFC 3986,scheme 大小写不敏感)且不带 query/hash:
// 带查询串的输入拼接 dist-tags API 路径时 search 会吞掉路径,检查恒败且错误难反推根因。
// 保存侧与请求侧共用同一判定。
export function isValidRegistryBase(base) {
  if (typeof base !== 'string') return false
  try {
    const parsed = new URL(base.trim())
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.search === '' && parsed.hash === ''
  } catch {
    return false
  }
}

// dist-tags 响应体上限:正常响应远小于此;流式累计读取,超限即断
const DIST_TAGS_MAX_BYTES = 64 * 1024

// 拉取 dist-tags 轻量端点;fetchImpl 注入便于单测,错误一律抛出由调用方决定保留上次结果。
// redirect 拒绝跟随:镜像 302 跳内网/他源属配置外行为,直接失败交调用方展示。
export async function fetchDistTags({ registryBase, fetchImpl = fetch, timeoutMs }) {
  if (!isValidRegistryBase(registryBase)) throw new Error('registry 基地址无效: ' + registryBase)
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error('timeoutMs 必须为正数')
  const base = registryBase.trim().replace(/\/+$/, '')
  const response = await fetchImpl(base + DIST_TAGS_PATH, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('registry HTTP ' + response.status)
  // 流式累计限量:恶意/异常源的超大响应体在传输中途即被断开,不整量入内存
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > DIST_TAGS_MAX_BYTES) throw new Error('dist-tags 响应超过上限')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  // json() 对 BOM 有容忍;text 路径显式剥除保持等价
  const text = new TextDecoder().decode(merged).replace(/^\uFEFF/, '')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('dist-tags 响应不是合法 JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('dist-tags 响应格式无效')
  const tags = {}
  for (const entry of Object.entries(body)) {
    if (typeof entry[1] === 'string') tags[entry[0]] = entry[1]
  }
  if (Object.keys(tags).length === 0) throw new Error('dist-tags 响应为空')
  return tags
}

// npm 全局布局下宿主包清单位置的候选序列;win 与 posix 目录结构不同,按声明平台选实现,与宿主 OS 解耦。
export function hostPackageCandidates({ execPath, platform }) {
  const pathImpl = platform === 'win32' ? win32 : posix
  const nodeDir = pathImpl.dirname(execPath)
  const globalDir = platform === 'win32'
    ? pathImpl.join(nodeDir, 'node_modules')
    : pathImpl.join(pathImpl.dirname(nodeDir), 'lib', 'node_modules')
  return [pathImpl.join(globalDir, '@deepseek-ai', 'dsh', 'package.json')]
}

// 宿主实际安装版本:先按全局布局候选读文件,再退 createRequire 解析(插件可能随宿主树部署)。
// 全部失败返回 null,面板显示未知,不影响宿主。
export async function resolveHostVersion({ execPath, platform, readFileImpl = readFile, resolveImpl }) {
  const candidates = hostPackageCandidates({ execPath, platform })
  let requireResolved = null
  try {
    requireResolved = resolveImpl ? resolveImpl(TARGET_PACKAGE + '/package.json') : createRequire(import.meta.url)(TARGET_PACKAGE + '/package.json')
  } catch {
    requireResolved = null
  }
  for (const candidate of requireResolved ? candidates.concat(requireResolved) : candidates) {
    try {
      const parsed = JSON.parse(await readFileImpl(candidate, 'utf8'))
      if (parsed && typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
    } catch {
      // 换下一候选
    }
  }
  return null
}
