// client.js 注册 id 与样式标记守卫:loader 按 graph row id(完整包名)匹配注册,短名即加载失败;
// 样式注入缺 data-plugin 会被宿主 claimStyles 误归属给后续材质化插件,其 HMR 重建即整批误删。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

test('client.js 注册 id 为完整包名', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'client.js 缺少 __ModuleLoader__.load 注册')
  assert.equal(match[1], name)
})

test('client.js 样式注入自带 data-plugin', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const injections = source.split("createElement('style')").length - 1
  assert.ok(injections > 0, 'client.js 无样式注入点')
  const marked = source.split(`setAttribute('data-plugin', '${name}')`).length - 1
  assert.equal(marked, injections, '每个样式注入点都必须自带 data-plugin(值=注册包名),防宿主 claimStyles 误归属后随他插件 HMR 整批误删')
})

// 样式注入行为:提取 STYLE-ENSURE 标记段在 DOM 桩上驱动两条路径
function ensureStyleImpl() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* STYLE-ENSURE-BEGIN */')
  const end = source.indexOf('/* STYLE-ENSURE-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少 STYLE-ENSURE 标记段')
  const section = source.slice(begin + '/* STYLE-ENSURE-BEGIN */'.length, end)
  return new Function(section + '; return { ensureStyle };')().ensureStyle
}

// DOM 桩:记录属性写入与挂载次数(规约:假元素须实现 setAttribute 并可断言)
function fakeDocument(existing) {
  const stats = { appended: 0, created: 0 }
  const appendTo = { appendChild(node) { stats.appended += 1; node.isConnected = true } }
  return {
    stats,
    getElementById: () => existing,
    createElement() {
      stats.created += 1
      const attrs = {}
      return {
        isConnected: false,
        attrs,
        setAttribute(key, value) { this.attrs[key] = value },
        head: appendTo,
      }
    },
    head: appendTo,
  }
}

test('样式注入:首次注入新建节点并带 data-plugin', () => {
  const document = fakeDocument(null)
  const node = ensureStyleImpl()(document, 'body{}')
  assert.equal(document.stats.created, 1)
  assert.equal(document.stats.appended, 1)
  assert.equal(node.attrs['data-plugin'], name)
  assert.equal(node.textContent, 'body{}')
})

test('样式注入:按 id 复用时无条件补 data-plugin(旧代缺标记节点不跨代延续)', () => {
  // Given 一个已在位的旧代样式节点:有 id 有内容但没有 data-plugin
  const attrs = {}
  const existing = { isConnected: true, textContent: '旧样式', setAttribute(key, value) { attrs[key] = value } }
  const document = fakeDocument(existing)
  // When 注入
  const node = ensureStyleImpl()(document, 'body{}')
  // Then 复用原节点、补写标记、刷新内容,且不重复挂载
  assert.equal(node, existing)
  assert.equal(attrs['data-plugin'], name, '复用路径不补标记会被宿主 claimStyles 归属给别的插件,其重建即删掉本包样式')
  assert.equal(existing.textContent, 'body{}')
  assert.equal(document.stats.created, 0, '在位节点不得新建第二个 style')
  assert.equal(document.stats.appended, 0, '在位节点不得重复挂载')
})
