// 兼容性测试版本窗口解析:最近 3 个活跃小版本线各取组内最大预发布。
// 活跃线判定(对齐 docs/兼容性测试/测试与隔离方法.md 固定版本窗口策略):
//   线内最大预发布的标签为 beta/rc → 活跃(线仍在收敛);
//   纯 alpha 线仅当它是最新线时活跃(占前瞻槽,首发即入窗口);
//   最老的 3 条活跃线构成窗口,按执行序输出 基线 → 主测 → 前瞻,
//   前瞻槽失败只告警不阻塞(升级预警),基线/主测失败阻塞。
// 显式覆盖:环境变量 DSH_COMPAT_VERSIONS=逗号清单,条目尾缀 ~ 表示非阻塞。
// 用法:node scripts/compat/window.mjs [--self-test]
// 输出:JSON 数组 [{version, slot, blocking}](slot: baseline|current|preview)
import { DSH_PACKAGE, cmdName } from './lib.mjs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const WINDOW_SIZE = 3

// 语义化版本比较:预发布版本 < 正式版;数值段按数值,标识符按 ASCII,数值段 < 字母段
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-')
    const [major, minor, patch] = core.split('.').map(Number)
    return { major, minor, patch, pre: pre ? pre.split('.') : [] }
  }
  const pa = parse(a)
  const pb = parse(b)
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

// 活跃线判定:最大预发布标签 beta/rc,或最新线(纯 alpha 首发即占前瞻槽)
function activeLine(label, isNewest) {
  return isNewest || label === 'beta' || label === 'rc'
}

export function resolveWindow(versions) {
  const prereleases = versions.filter((v) => v.includes('-'))
  const groups = new Map()
  for (const v of prereleases) {
    const line = v.split('-')[0]
    const cur = groups.get(line)
    if (!cur || compareSemver(v, cur) > 0) groups.set(line, v)
  }
  const lines = [...groups.entries()].sort((a, b) => compareSemver(b[1], a[1]))
  const active = lines.filter(([line, max], idx) => {
    const label = max.split('-')[1].split('.')[0]
    return activeLine(label, idx === 0)
  })
  const picked = active.slice(0, WINDOW_SIZE).map(([, max]) => max)
  // 执行序:基线(最老)在前,前瞻(最新)在后
  const slots = ['preview', 'current', 'baseline']
  return picked
    .map((version, idx) => ({ version, slot: slots[idx], blocking: idx !== 0 }))
    .reverse()
}

export function parseExplicit(spec) {
  const entries = spec.split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0 || entries.length > WINDOW_SIZE) {
    throw new Error(`DSH_COMPAT_VERSIONS 需 1~${WINDOW_SIZE} 个条目: ${spec}`)
  }
  const slots = ['baseline', 'current', 'preview']
  return entries.map((raw, idx) => {
    const blocking = !raw.endsWith('~')
    return { version: blocking ? raw : raw.slice(0, -1), slot: slots[idx], blocking }
  })
}

export async function fromRegistry() {
  // Windows 下 npm 是 .cmd 入口,Node 拒绝无 shell 的 .cmd spawn(CVE-2024-27980 防护)
  const res = spawnSync(cmdName('npm'), ['view', DSH_PACKAGE, 'versions', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if (res.status !== 0) throw new Error(`npm view 失败: ${res.stderr}`)
  return JSON.parse(res.stdout)
}

const FIXTURE_VERSIONS = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2',
  '0.1.6-alpha.1',
]

function selfTest() {
  const assertEq = (actual, expected, name) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`self-test 失败 ${name}\n  实际 ${a}\n  期望 ${e}`)
  }
  const order = ['1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0-beta.1', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0']
  assertEq([...order].sort(compareSemver), order, '预发布排序')
  assertEq(resolveWindow(FIXTURE_VERSIONS), [
    { version: '0.1.2-rc.1', slot: 'baseline', blocking: true },
    { version: '0.1.5-rc.2', slot: 'current', blocking: true },
    { version: '0.1.6-alpha.1', slot: 'preview', blocking: false },
  ], '当前 registry 窗口(纯 alpha 死线 0.1.3 不入窗)')
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
    const window_ = process.env.DSH_COMPAT_VERSIONS
      ? parseExplicit(process.env.DSH_COMPAT_VERSIONS)
      : resolveWindow(await fromRegistry())
    console.log(JSON.stringify(window_, null, 2))
  }
}
