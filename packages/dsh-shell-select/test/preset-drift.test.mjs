// preset 接管守卫(0.1.7 预设架构):本包 patch insert 自带预设声明
// (preset-shell-select,standard 内联 roster − tool-pwsh 行)并覆写
// agent-preset-registry 的 default。漂移守卫对照已安装 dsh 的
// dsh-web-app/presets/standard.patch.yml——上游增删行/改表达式即红,升级后
// 按官方实文对表镜像;宿主缺失(无 dsh 本体的最小环境)时 skip,不制造假红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execPath } from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
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

// ── 结构对比:展平行树为 id → {name, disabled, isolate, config 全值} ──
// config 比全值而非键集:键集守不住文本漂移(plan-mode section 曾落后官方一句
// 而守卫全绿),镜像声明即「standard 全量 − tool-pwsh 逐项同构」,值必须对表

function flattenRows(rows, out = new Map()) {
  for (const row of rows ?? []) {
    if (row.id !== undefined) {
      out.set(row.id, {
        name: row.name,
        disabled: row.disabled === undefined ? undefined : row.disabled.__jsExpr ?? row.disabled,
        isolate: row.isolate === undefined ? undefined : JSON.parse(JSON.stringify(row.isolate)),
        config: row.config === undefined ? undefined : JSON.parse(JSON.stringify(row.config)),
      })
    }
    if (row.group && Array.isArray(row.config)) flattenRows(row.config, out)
  }
  return out
}

// 本包 patch 解析:insert 的预设声明行 + 各覆写行
const patchRows = yamlStatic.load(patchText, { schema: LOCAL_SCHEMA })
const insertRows = patchRows.filter((entry) => entry.insert !== undefined).flatMap((entry) => entry.insert)
const ourPresetRow = insertRows.find((row) => row.id === 'preset-shell-select')
const ourPlugins = ourPresetRow?.config?.plugins ?? []

test('patch 形态:自带预设声明行(preset-shell-select,0.1.7 内联架构)', () => {
  assert.ok(ourPresetRow, 'patch 缺 preset-shell-select 声明(insert 段)')
  assert.equal(ourPresetRow.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(ourPresetRow.config.id, 'shell-select')
  const ids = new Set()
  const walk = (list) => {
    for (const row of list) {
      if (row.id !== undefined) ids.add(row.id)
      if (row.group && Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(ourPlugins)
  assert.ok(ids.has('tool-bash'), 'POSIX bash 工具行必须保留')
  assert.ok(!ids.has('tool-pwsh'), 'tool-pwsh 行必须移除(win32 shell 面由本包接管)')
  assert.ok(!ids.has('persistent-pwsh'), 'persistent-pwsh 行不得进入本包预设')
})

test('patch 形态:agent-preset-registry 覆写含平台 default(patch 语义为整体替换 config)', () => {
  const row = patchRows.find((entry) => entry.id === 'agent-preset-registry')
  assert.ok(row, 'patch 缺 agent-preset-registry 覆写行')
  assert.equal(row.name, undefined, 'registry 行是本包上层已 insert 的行,覆写按 id 匹配即无须 name')
  assert.match(row.config.default.__jsExpr, /'shell-select'/)
  assert.match(row.config.default.__jsExpr, /'standard'/)
})

test('patch 表达式求值:default 按平台切换', () => {
  const row = patchRows.find((entry) => entry.id === 'agent-preset-registry')
  const expected = process.platform === 'win32' ? 'shell-select' : 'standard'
  assert.equal(evalExpr(row.config.default.__jsExpr, {}), expected)
})

test('漂移守卫:与已安装 standard 预设逐行对表(缺失宿主则 skip)', (t) => {
  if (harness === null) return t.skip('未找到 dsh 本体安装,无对照源')
  const standardPath = join(harness, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  if (!existsSync(standardPath)) return t.skip('dsh 安装位无 standard 预设声明,无对照源')
  const standardPatch = yamlStatic.load(readFileSync(standardPath, 'utf8'), { schema: LOCAL_SCHEMA })
  const declared = standardPatch.filter((entry) => entry.insert !== undefined).flatMap((entry) => entry.insert).find((row) => row.id === 'preset-standard')
  assert.ok(declared, 'standard.patch.yml 缺 preset-standard 声明')
  const standard = flattenRows(declared.config.plugins)
  const ours = flattenRows(ourPlugins)
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

test('schema 同构:本地 !!js Type 与官方 entryListSchema 产物 deepEqual(缺失宿主则 skip)', (t) => {
  if (harness === null) return t.skip('未找到 dsh 本体安装,无官方 schema 对照')
  // harness 命中时 entryListSchema 已是官方版:loadYaml=官方路径,与 LOCAL_SCHEMA 逐文本对照。
  // 本地同形标签的语义漂移曾以 unknown tag 形态炸穿 CI,此处固化为机器断言
  assert.deepEqual(
    yamlStatic.load(patchText, { schema: LOCAL_SCHEMA }),
    loadYaml(patchText),
    'bundle patch 双 schema 产物漂移,本地 !!js Type 须与官方 JsExpr 同构',
  )
})
