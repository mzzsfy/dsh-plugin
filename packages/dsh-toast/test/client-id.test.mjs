// client.js 自注册格式守卫:ModuleLoader id 必须与 npm 包名一致,
// 宿主按包名解析 client bundle;factory 返回值必须呈插件形态(含空 apply),
// 缺 apply 即被浏览器 cordis loader 判 invalid plugin 拖垮整树。
// 宿主入口 index.js 同锁:仅空 apply 形态,不带 name/inject。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('client.js 以本包名注册 ModuleLoader 模块', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'client.js 缺少 __ModuleLoader__.load 注册')
  assert.equal(match[1], '@mzzsfy/dsh-toast')
})

test('factory 执行后返回值含空 apply 与公开 API', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) } }
  const reactStub = { useSyncExternalStore: () => [], createElement: () => null }
  const requireStub = (name) => (name === 'react-dom/client' ? { createRoot: () => ({ render() {} }) } : reactStub)
  const docStub = {
    getElementById: () => null,
    createElement: () => ({ id: '', style: {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  }
  const factory = new Function('window', 'require', 'document', source + '\n;return null')
  factory(windowStub, requireStub, docStub)
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)
  assert.equal(typeof mod.apply, 'function', '缺 apply 即 invalid plugin 拖垮整树')
  assert.equal(typeof mod.show, 'function')
  assert.equal(typeof mod.dismiss, 'function')
  assert.equal(typeof mod.mount, 'function')
})

test('宿主入口 index.js 仅空 apply 形态,不带 name/inject', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'index.js'), 'utf8')
  assert.match(source, /export function apply\(\) \{\}/)
  assert.doesNotMatch(source, /export const name/, '带 name 的命名空间形态经装载链被判 invalid plugin')
  assert.doesNotMatch(source, /export const inject/, '带 inject 的命名空间形态经装载链被判 invalid plugin')
})
