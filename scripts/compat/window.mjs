// 兼容性测试版本窗口解析:dist-tag latest 锚定三槽(2026-09-18 改版)。
//   基线 = latest 版本线之前、含 rc 的最近版本线的线内最后 rc(稳定回归锚);
//   主测 = npm dist-tag latest 指向的版本(当前稳定);
//   前瞻 = registry versions 全量 semver 最大(全通道最新,非阻塞,升级预警)。
// 前瞻与已选槽相同则丢弃(窗口缩为 2);基线缺失抛错(latest 之前无含 rc 线)。
// 显式覆盖:环境变量 DSH_COMPAT_VERSIONS=逗号清单,条目尾缀 ~ 表示非阻塞。
// 用法:node scripts/compat/window.mjs [--self-test]
// 输出:JSON 数组 [{version, slot, blocking}](slot: baseline|current|preview)
import { DSH_PACKAGE, cmdName } from './lib.mjs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const WINDOW_SIZE = 3
// 槽位单一事实源:执行序(基线 → 主测 → 前瞻)与展示名
export const EXEC_SLOTS = ['baseline', 'current', 'preview']
export const SLOT_LABELS = { baseline: '基线', current: '主测', preview: '前瞻' }

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

export function resolveWindow(versions, latest) {
  // unpublish 后 dist-tag 可能残留:幽灵版本做主测会到安装期才失败,且前瞻语义反转
  if (!versions.includes(latest)) {
    throw new Error(`dist-tag latest ${latest} 不在 registry versions 列表中(疑似 unpublish 残留)`)
  }
  const latestCore = parseSemver(latest).core
  // 基线:latest 之前各线的最大 rc,纯 alpha 死线(线内无 rc)天然不入候选
  const lastRcByLine = new Map()
  for (const v of versions) {
    const s = parseSemver(v)
    if (compareSemver(s.core, latestCore) >= 0 || s.pre[0] !== 'rc') continue
    const cur = lastRcByLine.get(s.core)
    if (!cur || compareSemver(v, cur) > 0) lastRcByLine.set(s.core, v)
  }
  const baseline = [...lastRcByLine.entries()].sort((a, b) => compareSemver(b[0], a[0]))[0]
  if (!baseline) throw new Error(`基线缺失:latest ${latest} 之前无含 rc 的版本线`)
  const picked = [
    { version: baseline[1], slot: 'baseline', blocking: true },
    { version: latest, slot: 'current', blocking: true },
  ]
  // 前瞻:全通道最新,与已选槽相同即丢弃(窗口缩为 2)
  const preview = versions.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b))
  if (!picked.some((p) => p.version === preview)) {
    picked.push({ version: preview, slot: 'preview', blocking: false })
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
    return { version, slot: EXEC_SLOTS[idx], blocking }
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
  return { latest: distTags.latest, versions }
}

const FIXTURE_VERSIONS = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2',
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
  assertThrows(() => parseExplicit('a,b,c,d'), '显式清单超出槽位数抛错')
  assertThrows(() => parseExplicit('0.1.5-rc.2,非法'), '显式清单非法版本抛错')
  assertEq(resolveWindow(FIXTURE_VERSIONS, '0.1.5-rc.2'), [
    { version: '0.1.2-rc.1', slot: 'baseline', blocking: true },
    { version: '0.1.5-rc.2', slot: 'current', blocking: true },
    { version: '0.1.7-alpha.2', slot: 'preview', blocking: false },
  ], '当前 registry 窗口:主测取 latest 而非线内最大(0.1.5-rc.3),纯 alpha 死线 0.1.3 不作基线')
  assertEq(resolveWindow(FIXTURE_VERSIONS, '0.1.7-alpha.2'), [
    { version: '0.1.5-rc.3', slot: 'baseline', blocking: true },
    { version: '0.1.7-alpha.2', slot: 'current', blocking: true },
  ], 'latest 追平全通道最新时前瞻槽丢弃,基线取上一含 rc 线的最后 rc')
  assertEq(resolveWindow(['0.1.2-rc.1', '0.1.5'], '0.1.5'), [
    { version: '0.1.2-rc.1', slot: 'baseline', blocking: true },
    { version: '0.1.5', slot: 'current', blocking: true },
  ], 'latest 为正式版时入主测槽,前瞻与已选槽重复丢弃')
  assertThrows(() => resolveWindow(['0.1.5-rc.2'], '0.1.5-rc.2'), '无更早含 rc 线时基线缺失抛错')
  assertEq(parseExplicit('0.1.2-rc.1,0.1.5-rc.2~'), [
    { version: '0.1.2-rc.1', slot: 'baseline', blocking: true },
    { version: '0.1.5-rc.2', slot: 'current', blocking: false },
  ], '显式清单按执行序,~ 非阻塞')
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
      : await fromRegistry().then(({ latest, versions }) => resolveWindow(versions, latest))
    console.log(JSON.stringify(window_, null, 2))
  }
}
