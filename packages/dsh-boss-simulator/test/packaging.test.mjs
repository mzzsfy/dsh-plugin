// 打包契约:清单字段、入口存在、干净禁用形态
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { presetDefinitions } from '../lib/presets.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

test('公司管理只向 DSH 注册一个自定义入口预设', () => {
  const definitions = presetDefinitions()
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0].id, 'boss-simulator-admin')
  assert.deepEqual(definitions[0].plugins.map((plugin) => plugin.id), ['persona', 'boss-simulator-tools-row'])
})

test('预设模板只引用宿主注册的 prompt 变量', () => {
  // 渲染期严格校验,宿主仅注册 provider/model,引用其余变量使会话启动即失败
  const registered = ['provider', 'model']
  for (const plugin of presetDefinitions()[0].plugins) {
    for (const template of Object.values(plugin.config ?? {}).filter((v) => typeof v === 'string')) {
      for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
        assert.ok(registered.includes(m[1]), `${plugin.id} 模板引用未注册变量 ${m[1]}`)
      }
    }
  }
})

test('package.json 契约', () => {
  const dsh = pkg.dsh
  if (!dsh) return
  if (dsh.bundle?.patch) {
    if (!existsSync(join(pkgRoot, dsh.bundle.patch))) throw new Error(`patch 文件缺失: ${dsh.bundle.patch}`)
  }
  if (dsh.client && !existsSync(join(pkgRoot, 'src/client.js'))) throw new Error('声明 client 平台但缺 src/client.js')
  if (!pkg.exports['./client'] && !dsh.client) throw new Error('无 client 导出也无 client 声明')
})

test('宿主行 config role 覆盖 cordis.patch 全部插入行', () => {
  const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  const index = readFileSync(join(pkgRoot, 'lib/index.js'), 'utf8')
  for (const m of patch.matchAll(/role:\s*(\w+)/g)) {
    if (!index.includes(`'${m[1]}'`)) throw new Error(`patch 行 role ${m[1]} 未在 Config 枚举中`)
  }
})
