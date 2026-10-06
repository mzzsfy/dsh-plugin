// 兼容性测试版本窗口解析:dist-tag 双槽锚定(2026-09-27 改版,三版本完全兼容停测)。
//   主测 = 各渠道 dist-tag 指向版本中最新的 rc(渠道全无 rc 时取 dist-tag 值最大),完全适配判定;
//   基线 = npm dist-tag latest 指向版本,仅不崩溃判定(run.mjs --crash-only)。
// 基线与主测同版本则窗口缩为单主测;入选版本不在 registry versions 列表(疑似 unpublish 残留)抛错。
// 显式覆盖:环境变量 DSH_COMPAT_VERSIONS=逗号清单,条目尾缀 ~ 表示非阻塞。
// 用法:node scripts/compat/window.mjs [--self-test]
// 输出:JSON 数组 [{version, slot, blocking, mode}](slot: primary|baseline;mode: full|crash-only)
import { DSH_PACKAGE, cmdName } from './lib.mjs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// 槽位单一事实源:执行序(主测 → 基线)与展示名;窗口大小与槽位-口径映射由此派生
export const EXEC_SLOTS = ['primary', 'baseline']
export const WINDOW_SIZE = EXEC_SLOTS.length
export const SLOT_LABELS = { primary: '主测', baseline: '基线' }
// 槽位 → run.mjs 判定口径:主测完全适配,基线只判不崩溃
export const SLOT_MODES = { primary: 'full', baseline: 'crash-only' }

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export function isSemver(v) {
  return SEMVER_RE.test(v)
}

// 语义化版本解析:预发布以首个 - 截断;连字符标识符(如 alpha-1)整体作为一个预发布段
function parseSemver(v) {
  if (!isSemver(v)) throw new Error(`非语义化版本: ${v}`)
  const dash = v.indexOf('-')
  const core = dash < 0 ? v : v.slice(0, dash)
  const pre = dash < 0 ? '' : v.slice(dash + 1)
  const [major, minor, patch] = core.split('.').map(Number)
  return { core, major, minor, patch, pre: pre ? pre.split('.') : [] }
}

// 语义化版本比较:预发布版本 < 正式版;数值段按数值,标识符按 ASCII,数值段 < 字母段
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y) }
    else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function resolveWindow(versions, distTags) {
  if (!distTags?.latest) throw new Error('registry 缺 dist-tags.latest')
  // unpublish 后 dist-tag 可能残留:幽灵版本入选会拖到安装期才失败
  const guardGhost = (version) => {
    if (!versions.includes(version)) {
      throw new Error(`dist-tag 指向 ${version} 不在 registry versions 列表中(疑似 unpublish 残留)`)
    }
  }
  guardGhost(distTags.latest)
  const tagged = [...new Set(Object.values(distTags))]
  // 主测:渠道中最新的 rc;渠道全无 rc(如全线转正式的稳定期)时取渠道最大
  const latestOf = (list) => list.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b))
  const rcTags = tagged.filter((v) => parseSemver(v).pre[0] === 'rc')
  const primary = latestOf(rcTags.length > 0 ? rcTags : tagged)
  guardGhost(primary)
  const picked = [{ version: primary, slot: 'primary', blocking: true, mode: SLOT_MODES.primary }]
  if (distTags.latest !== primary) {
    picked.push({ version: distTags.latest, slot: 'baseline', blocking: true, mode: SLOT_MODES.baseline })
  }
  return picked
}

export function parseExplicit(spec) {
  const entries = spec.split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0 || entries.length > WINDOW_SIZE) {
    throw new Error(`DSH_COMPAT_VERSIONS 需 1~${WINDOW_SIZE} 个条目: ${spec}`)
  }
  return entries.map((raw, idx) => {
    const blocking = !raw.endsWith('~')
    const version = blocking ? raw : raw.slice(0, -1)
    if (!isSemver(version)) throw new Error(`非法版本号: ${version}`)
    const slot = EXEC_SLOTS[idx]
    return { version, slot, blocking, mode: SLOT_MODES[slot] }
  })
}

export async function fromRegistry() {
  // Windows 下 npm 是 .cmd 入口,Node 拒绝无 shell 的 .cmd spawn(CVE-2024-27980 防护)
  const res = spawnSync(cmdName('npm'), ['view', DSH_PACKAGE, 'dist-tags', 'versions', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 5 * 60 * 1000,
  })
  if (res.status !== 0 || res.error) {
    throw new Error(`npm view 失败: ${res.error ?? res.stderr}`)
  }
  const payload = JSON.parse(res.stdout)
  const { 'dist-tags': distTags, versions } = payload
  if (!distTags?.latest) throw new Error('registry 缺 dist-tags.latest')
  return { distTags, versions }
}

const FIXTURE_VERSIONS = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.1.7',
  '0.1.8-alpha.1',
]

function selfTest() {
  const assertEq = (actual, expected, name) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`self-test 失败 ${name}\n  实际 ${a}\n  期望 ${e}`)
  }
  const assertThrows = (fn, name) => {
    try {
      fn()
    } catch {
      return
    }
    throw new Error(`self-test 失败 ${name}:未抛错`)
  }
  const order = ['1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0-beta.1', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0']
  assertEq([...order].sort(compareSemver), order, '预发布排序')
  assertEq(compareSemver('1.0.0-alpha-1', '1.0.0-alpha.1'), 1, '连字符标识符按 ASCII 与段数比较')
  assertEq(compareSemver('1.0.0-1', '1.0.0-alpha'), -1, '数值标识符优先于字母标识符')
  assertEq(compareSemver('1.0.0-rc.9', '1.0.0-rc.10'), -1, '数值标识符按数值比较(进位)')
  assertThrows(() => parseExplicit('a,b,c'), '显式清单超出槽位数抛错')
  assertThrows(() => parseExplicit('0.1.5-rc.2,非法'), '显式清单非法版本抛错')
  assertEq(resolveWindow(FIXTURE_VERSIONS, { alpha: '0.1.7-alpha.2', latest: '0.1.5-rc.3', next: '0.1.7-rc.2' }), [
    { version: '0.1.7-rc.2', slot: 'primary', blocking: true, mode: 'full' },
    { version: '0.1.5-rc.3', slot: 'baseline', blocking: true, mode: 'crash-only' },
  ], '当前 registry 窗口:主测取渠道中最新的 rc(next),基线取 latest 渠道,alpha 渠道不入窗')
  assertEq(resolveWindow(FIXTURE_VERSIONS, { alpha: '0.1.7-alpha.2', latest: '0.1.7', next: '0.1.7' }), [
    { version: '0.1.7', slot: 'primary', blocking: true, mode: 'full' },
  ], '渠道全无 rc 时主测取渠道最大,与 latest 同版本则窗口缩为单主测')
  assertEq(resolveWindow(FIXTURE_VERSIONS, { alpha: '0.1.8-alpha.1', latest: '0.1.7' }), [
    { version: '0.1.8-alpha.1', slot: 'primary', blocking: true, mode: 'full' },
    { version: '0.1.7', slot: 'baseline', blocking: true, mode: 'crash-only' },
  ], '渠道全无 rc 且最大值为 alpha 时,alpha 以完全适配口径入主测,latest 为基线')
  assertEq(resolveWindow(FIXTURE_VERSIONS, { latest: '0.1.5-rc.3', next: '0.1.5-rc.3' }), [
    { version: '0.1.5-rc.3', slot: 'primary', blocking: true, mode: 'full' },
  ], '主测与基线同版本时窗口缩为单主测')
  assertThrows(() => resolveWindow(['0.1.5-rc.2'], { latest: '0.1.5-rc.2', next: '0.1.9-rc.1' }), '主测渠道幽灵版本抛错')
  assertThrows(() => resolveWindow(['0.1.5-rc.2'], { latest: '0.1.4-rc.9' }), '基线渠道幽灵版本抛错')
  assertThrows(() => resolveWindow(['0.1.5-rc.2'], { alpha: '0.1.5-rc.2' }), 'dist-tags.latest 缺失抛错')
  assertEq(parseExplicit('0.1.7-rc.2,0.1.5-rc.3~'), [
    { version: '0.1.7-rc.2', slot: 'primary', blocking: true, mode: 'full' },
    { version: '0.1.5-rc.3', slot: 'baseline', blocking: false, mode: 'crash-only' },
  ], '显式清单按执行序对应 主测/基线,~ 非阻塞')
  assertEq(parseExplicit('0.1.7-rc.2'), [
    { version: '0.1.7-rc.2', slot: 'primary', blocking: true, mode: 'full' },
  ], '显式单条目仅主测槽')
  console.log('window self-test OK')
}

// 仅直接执行时跑 CLI(self-test / 打印窗口),被 import 不触发
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) {
    selfTest()
  } else {
    // 显式覆盖不触 registry(离线可用),registry 拉取仅服务实算路径
    const window_ = process.env.DSH_COMPAT_VERSIONS
      ? parseExplicit(process.env.DSH_COMPAT_VERSIONS)
      : await fromRegistry().then(({ distTags, versions }) => resolveWindow(versions, distTags))
    console.log(JSON.stringify(window_, null, 2))
  }
}
