import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchKeys } from '../scripts/compat/patch-keys.mjs'

/**
 * patch 键集契约对表(纯静态,零宿主启动)。
 * BDD 场景:官方行键集 ⊆ 插件覆写键集且仅预期键翻转 = PASS;缺失/多余/目标行不存在 = DRIFT;
 * 纯 insert = INSERT_ONLY;无 patch 文件 = NO_PATCH;覆写缺 name 防御 = WARN。
 * 夹具 = 迷你闭包树(tmp),官方侧结构与真实 .compat/<v>/dsh-host/node_modules/@deepseek-ai 同形。
 */

function buildClosure(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'patch-keys-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return root
}

const OFFICIAL = (config) => `- insert: true
  id: webserver
  name: WebServer
  config:
${Object.entries(config).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
`

test('对表_覆写镜像官方全键仅host翻转_PASS', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1', port: 3080, compression: true, 'compressionLevel': 6, compressionThresholdBytes: 1024 }),
    'pkgs/dsh-auto-trust-all/cordis.patch.yml': `- id: webserver
  name: WebServer
  config:
    host: 0.0.0.0
    port: 3080
    compression: true
    compressionLevel: 6
    compressionThresholdBytes: 1024
`,
  })
  const { verdicts, drift } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  assert.equal(drift, 0)
  const v = verdicts.find(x => x.pkg === 'dsh-auto-trust-all')
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.valueChanged, ['host'])
})

test('对表_覆写缺官方键_DRIFT', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1', port: 3080, compression: true }),
    'pkgs/dsh-x/cordis.patch.yml': `- id: webserver
  name: WebServer
  config:
    host: 0.0.0.0
    port: 3080
`,
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-x')
  assert.equal(v.verdict, 'DRIFT')
  assert.deepEqual(v.missing, ['compression'])
})

test('对表_覆写多出官方没有的键_DRIFT', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-x/cordis.patch.yml': `- id: webserver
  name: WebServer
  config:
    host: 0.0.0.0
    extraKey: 1
`,
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-x')
  assert.equal(v.verdict, 'DRIFT')
  assert.deepEqual(v.extra, ['extraKey'])
})

test('对表_覆写目标行官方不存在_DRIFT', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-shell-select/cordis.patch.yml': `- id: agent-preset-registry
  name: AgentPresetRegistry
  config:
    default: standard
`,
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-shell-select')
  assert.equal(v.verdict, 'DRIFT')
  assert.match(v.reason, /不存在|not found/)
})

test('对表_纯insert自有行_INSERT_ONLY', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-think-expand/cordis.patch.yml': `- insert: true
  id: dsh-think-expand
  config:
    listen: true
`,
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-think-expand')
  assert.equal(v.verdict, 'INSERT_ONLY')
})

test('对表_insert引用包_refCheck信息字段不计入DRIFT', t => {
  // 现症实锤(0.1.5-rc.3 boot.log):insert 行 name = loader entry 导入目标,彼时注册表
  // 缺包 → 宿主硬崩。但运行期解析根是引用方包自身依赖树,静态脚本无法复现注册表历史
  // (0.1.7/0.2.0 closure 均无该包却运行正常)→ 引用存在性只作 refCheck 信息,不计 DRIFT
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-shell-select/cordis.patch.yml': `- insert: true
  id: preset-shell-select
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: shell-select
`,
  })
  const { verdicts, drift } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-shell-select')
  assert.equal(v.verdict, 'INSERT_ONLY')
  assert.deepEqual(v.refCheck, { ref: '@deepseek-ai/dsh-agent-preset', resolvableIn: 'none' })
  assert.equal(drift, 0)
})

test('对表_insert引用本仓mzzsfy包_refCheck命中packages', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-tunnel/cordis.patch.yml': `- insert:
    - id: dsh-tunnel
      name: '@mzzsfy/dsh-tunnel'
`,
    'pkgs/dsh-tunnel/src/index.js': 'export function apply() {}\n',
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-tunnel')
  assert.equal(v.verdict, 'INSERT_ONLY')
  assert.equal(v.refCheck.resolvableIn, 'packages')
})

test('对表_无patch文件_NO_PATCH', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-toast/README.md': 'x\n',
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-toast')
  assert.equal(v.verdict, 'NO_PATCH')
})

test('对表_覆写缺name防御_WARN', t => {
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1', port: 3080 }),
    'pkgs/dsh-y/cordis.patch.yml': `- id: webserver
  config:
    host: 0.0.0.0
    port: 3080
`,
  })
  const { verdicts } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-y')
  assert.equal(v.verdict, 'WARN')
  assert.match(v.note, /name/)
})

test('CLI_退出码_DRIFT非零_干净零', t => {
  const clean = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-z/cordis.patch.yml': `- insert: true
  id: dsh-z
`,
  })
  const okProc = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'compat', 'patch-keys.mjs'), clean, join(clean, 'pkgs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(okProc.status, 0, okProc.stderr)

  const dirty = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-w/cordis.patch.yml': `- id: webserver
  name: WebServer
  config:
    host: 0.0.0.0
    port: 3080
`,
  })
  const badProc = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'compat', 'patch-keys.mjs'), dirty, join(dirty, 'pkgs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(badProc.status, 1)
})

test('对表_官方行id重复_显式记账不静默覆盖', t => {
  // 官方两文件同 id:Map.set 顺序覆盖会让对表锚定错行(轮 2 组 D 实锤),显式记账
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'node_modules/@deepseek-ai/dsh-web-app/presets/dupe.patch.yml': OFFICIAL({ host: '0.0.0.0' }),
    'pkgs/dsh-z/cordis.patch.yml': `- id: webserver
  name: WebServer
  config:
    host: 127.0.0.1
`,
  })
  const { officialDuplicates } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  assert.equal(officialDuplicates.length, 1)
  assert.equal(officialDuplicates[0].id, 'webserver')
})

test('对表_insert行id撞车官方行_DRIFT', t => {
  // insert 目标要求 group 语义,撞既有条目 id 即未定义行为;0.1.5 实爆面即 insert 行
  const closure = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-z/cordis.patch.yml': `- insert: true
  id: webserver
  config:
    host: 0.0.0.0
`,
  })
  const { verdicts, drift } = patchKeys({ closureDir: closure, packagesDir: join(closure, 'pkgs') })
  const v = verdicts.find(x => x.pkg === 'dsh-z')
  assert.equal(v.verdict, 'DRIFT')
  assert.match(v.reason, /撞车/)
  assert.equal(drift, 1)
})

test('CLI_strict档_WARN与官方重复进退出码', t => {
  // 默认仅 drift 拦截(WARN 行保持既有绿轮稳定);--strict 把 WARN 一并拦截
  const warnOnly = buildClosure(t, {
    'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': OFFICIAL({ host: '127.0.0.1' }),
    'pkgs/dsh-w/cordis.patch.yml': `- id: webserver
  config:
    host: 0.0.0.0
`,
  })
  const script = join(import.meta.dirname, '..', 'scripts', 'compat', 'patch-keys.mjs')
  const defaultProc = spawnSync(process.execPath, [script, warnOnly, join(warnOnly, 'pkgs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(defaultProc.status, 0, '默认档 WARN 不拦')
  const strictProc = spawnSync(process.execPath, [script, warnOnly, join(warnOnly, 'pkgs'), '--strict'], { encoding: 'utf8', windowsHide: true })
  assert.equal(strictProc.status, 1, '--strict 档 WARN 拦截')
})
