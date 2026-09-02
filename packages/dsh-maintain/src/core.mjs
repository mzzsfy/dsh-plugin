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

// 模板占位符执行时替换;模板允许不含占位符(用户整体自改命令),空模板拒绝。
export function buildUpgradeCommand({ template, tag }) {
  const text = typeof template === 'string' ? template.trim() : ''
  if (text.length === 0) throw new Error('升级命令模板为空,拒绝执行')
  return text.split(TAG_PLACEHOLDER).join(tag)
}

// 重启后是否整页刷新:经历失联后恢复,或宿主实例标识(pid)变化(停机时长小于重启轮询间隔的快速重启零失联),两者都是宿主已重启的可靠信号。
export function shouldReloadAfterRestart({ lost, pidBefore, pidAfter }) {
  if (lost) return true
  return typeof pidBefore === 'number' && typeof pidAfter === 'number' && pidBefore !== pidAfter
}

// 拉取 dist-tags 轻量端点;fetchImpl 注入便于单测,错误一律抛出由调用方决定保留上次结果。
export async function fetchDistTags({ registryBase, fetchImpl = fetch, timeoutMs }) {
  const base = (typeof registryBase === 'string' ? registryBase : '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) throw new Error('registry 基地址无效: ' + registryBase)
  const response = await fetchImpl(base + DIST_TAGS_PATH, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('registry HTTP ' + response.status)
  const body = await response.json()
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
