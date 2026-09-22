// preset 接管守卫:本包自带预设(standard 副本 − tool-pwsh 行)与 bundle patch
// 的 agent-presets 覆写形态。漂移守卫对照已安装 dsh 的内置 standard 预设——
// 上游增删行/改表达式即红,升级后按官方实文对表镜像;宿主缺失(无 dsh 本体的
// 最小环境)时 skip,不制造假红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { execPath } from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const presetText = readFileSync(join(pkgRoot, 'presets', 'shell-select', 'agent.cordis.yml'), 'utf8')
const metaText = readFileSync(join(pkgRoot, 'presets', 'shell-select', 'preset.yml'), 'utf8')
const patchText = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')

// ── 宿主侧 yaml 能力探测:js-yaml 与官方 entryListSchema 经 dsh 安装位解析 ──

function locateHarnessDir() {
  // 候选锚:运行中 node 的全局安装位(nvm/全局布局:execPath 目录/node_modules)→
  // 仓库 compat 隔离宿主(.dsh-versions/<v>/package)。缺失即返回 null(skip)。
  const candidates = [
    resolve(dirname(execPath), 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  const versionsDir = resolve(pkgRoot, '..', '..', '.dsh-versions')
  try {
    for (const version of readdirSync(versionsDir)) {
      candidates.push(join(versionsDir, version, 'package'))
    }
  } catch { /* 无 .dsh-versions,忽略 */ }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

// yaml 能力与宿主解耦:js-yaml 为 devDep(CI 无宿主也可解析本包文件)。
// !!js 标签本地同形 Type:tag 必须写完整 URI(tag:yaml.org,2002:js)——文档简写
// !!js 展开后按完整 URI 匹配,字面 '!!js' 永不命中(unknown tag,CI 假绿教训)。
// 形态场景恒走 LOCAL_SCHEMA(本机/CI 同路径);漂移守卫在场时改用官方
// entryListSchema 求同(对照面只在有宿主时跑)
import yamlStatic from 'js-yaml'

const LOCAL_SCHEMA = yamlStatic.JSON_SCHEMA.extend(new yamlStatic.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data['__jsExpr'],
}))

let harness = null
let entryListSchema = LOCAL_SCHEMA
try {
  harness = locateHarnessDir()
  if (harness !== null) {
    const req = createRequire(join(harness, 'package.json'))
    const toUrl = (specifier) => pathToFileURL(req.resolve(specifier)).href
    entryListSchema = (await import(toUrl('@deepseek-ai/cordis-plugin-include'))).entryListSchema
  }
} catch { /* 官方 schema 缺失按本地同形标签处理 */ }

const loadYaml = (text) => yamlStatic.load(text, { schema: entryListSchema })

// 镜像 loader 的表达式求值形态(new Function + with(ctx),全局可用)
const evalExpr = (expr, ctx) => new Function('ctx', `with (ctx) { return (${expr}) }`)(ctx)

// ── 结构对比:展平行树为 id → {name, disabled, config 键集} ──

function flattenRows(rows, out = new Map()) {
  for (const row of rows ?? []) {
    if (row.id !== undefined) {
      out.set(row.id, {
        name: row.name,
        disabled: row.disabled === undefined ? undefined : row.disabled.__jsExpr ?? row.disabled,
        configKeys: row.config && !Array.isArray(row.config) ? Object.keys(row.config).sort() : undefined,
      })
    }
    if (row.group && Array.isArray(row.config)) flattenRows(row.config, out)
  }
  return out
}

// ── 场景 ──

test('预设形态:preset.yml 元数据在场', () => {
  const meta = metaText.trim().split('\n').map((line) => line.split(/:(.*)/s)[0])
  assert.ok(meta.includes('name'), 'preset.yml 缺 name')
  assert.ok(metaText.includes('description:'), 'preset.yml 缺 description')
})

test('预设形态:agent.cordis.yml 可解析且无 tool-pwsh 行', () => {
  // 形态断言恒走本地同形 schema:本机与 CI 同一路径,官方 schema 在场与否不影响本场景
  const rows = yamlStatic.load(presetText, { schema: LOCAL_SCHEMA })
  assert.ok(Array.isArray(rows), '预设组合必须是行数组')
  const ids = new Set()
  const walk = (list) => {
    for (const row of list) {
      if (row.id !== undefined) ids.add(row.id)
      if (row.group && Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  assert.ok(ids.has('tool-bash'), 'POSIX bash 工具行必须保留')
  assert.ok(!ids.has('tool-pwsh'), 'tool-pwsh 行必须移除(win32 shell 面由本包接管)')
})

test('漂移守卫:与已安装 standard 逐行对表(缺失宿主则 skip)', (t) => {
  if (harness === null) return t.skip('未找到 dsh 本体安装,无对照源')
  const standardPath = join(harness, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  if (!existsSync(standardPath)) return t.skip('dsh 安装位无 standard 预设,无对照源')
  const standard = flattenRows(loadYaml(readFileSync(standardPath, 'utf8')))
  const ours = flattenRows(loadYaml(presetText))
  for (const [id, row] of standard) {
    if (id === 'tool-pwsh') {
      assert.ok(!ours.has(id), 'standard 有 tool-pwsh 而本包预设也出现了:镜像被污染')
      continue
    }
    assert.ok(ours.has(id), `standard 行 ${id} 在本包预设缺失,须对表镜像`)
    assert.deepEqual(ours.get(id), row, `行 ${id} 与 standard 漂移,升级后按官方实文对表`)
  }
  for (const id of ours.keys()) {
    assert.ok(standard.has(id), `本包预设多出 standard 没有的行 ${id}:镜像越界`)
  }
})

test('patch 形态:agent-presets 覆写带 name 防御且含 default 与 roots', () => {
  const patch = yamlStatic.load(patchText, { schema: LOCAL_SCHEMA })
  const row = patch.find((entry) => entry.id === 'agent-presets')
  assert.ok(row, 'patch 缺 agent-presets 覆写行')
  assert.equal(row.name, '@deepseek-ai/dsh-agent-presets', 'name 字段是官方行改名防御,必须钉住包名')
  assert.match(row.config.default.__jsExpr, /'shell-select'/)
  assert.match(row.config.default.__jsExpr, /'standard'/)
  assert.equal(row.config.roots.length, 1)
  assert.match(row.config.roots[0].path.__jsExpr, /ctx\.baseUrl/)
})

test('patch 表达式求值:default 按平台切换,roots 指向本包 presets 目录', () => {
  const patch = yamlStatic.load(patchText, { schema: LOCAL_SCHEMA })
  const config = patch.find((entry) => entry.id === 'agent-presets').config
  const expectedDefault = process.platform === 'win32' ? 'shell-select' : 'standard'
  assert.equal(evalExpr(config.default.__jsExpr, { baseUrl: 'file:///any/profile/dir/' }), expectedDefault)
  // 合成 profile 布局:baseUrl 锚 <profile>/profiles/web,其下 node_modules/@mzzsfy/dsh-shell-select
  // 为符号链接桥(自依赖桥同构;junction 穿透到真实包目录)
  const fakeProfile = join(tmpdir(), 'shell-select-preset-probe-' + process.pid)
  const linkDir = join(fakeProfile, 'profiles', 'web', 'node_modules', '@mzzsfy')
  mkdirSync(linkDir, { recursive: true })
  symlinkSync(pkgRoot, join(linkDir, 'dsh-shell-select'), 'junction')
  try {
    const evaluated = evalExpr(config.roots[0].path.__jsExpr, {
      baseUrl: pathToFileURL(join(fakeProfile, 'profiles', 'web') + '/').href,
    })
    assert.ok(/presets\/$/.test(evaluated), '求值路径必须锚在包内 presets 目录: ' + evaluated)
    assert.ok(existsSync(join(evaluated, 'shell-select', 'agent.cordis.yml')), '求值路径必须落在本包 presets 目录(符号链接桥穿透)')
  } finally {
    rmSync(fakeProfile, { recursive: true, force: true })
  }
})
