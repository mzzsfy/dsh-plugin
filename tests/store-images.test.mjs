import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { parseMarketIndex, MAX_INLINE_ICON_BYTES } from '@deepseek-ai/dsh-plugin-market-index'
import { CATALOG_PACKAGES, ICON_MAP } from '../scripts/catalog-manifest.mjs'
import { buildIcons, buildIndex, fetchNpmMap, renderIndex } from '../scripts/build-catalog.mjs'
import { GLYPHS } from '../packages/dsh-settings-nav-icons/src/logic.mjs'

// 商店展示图片链 BDD,场景权威记录见 .work/feat-store-images/plan.md
// 主路径 1:索引条目携带图标;主路径 2:产物过官方校验器且图标保真;
// 主路径 3:图标体积在 data: 上限内;边界:清单全覆盖、构建确定性、落盘产物与构建一致。

const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const iconPath = (pkg) => `${repo}assets/icons/${pkg}.svg`

const indexUrl = 'https://example.invalid/catalog/index.json'

// 确定性场景用固定 registry 快照,不依赖网络
const fetchNpmMapCache = new Map(CATALOG_PACKAGES.map((pkg) => [pkg, { version: '0.0.0', publishTimestamp: 1700000000 }]))

test('场景1(主):每个目标插件包有图标资产且为合法 96 视图 SVG', () => {
  for (const pkg of CATALOG_PACKAGES) {
    const file = iconPath(pkg)
    assert.ok(existsSync(file), `缺图标资产: ${pkg}`)
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${pkg} 开标签属性须小写`)
    assert.ok(text.includes('viewBox="0 0 96 96"'), `${pkg} 必须 96 视图`)
    assert.ok(text.endsWith('</svg>\n'), `${pkg} 未闭合`)
  }
})

// 黄金对照:资产必须与"GLYPHS+ICON_MAP 内存重算的缩放输出"逐字节一致,
// glyph 源改动而未重跑生成脚本时此处必红(S2 形状锁定)
test('场景1b(边界):资产与 glyph 重算输出一致(防过期生成)', async () => {
  const { scaleGlyphToAsset } = await import('../scripts/generate-icons.mjs')
  for (const [pkg, glyph] of Object.entries(ICON_MAP)) {
    const expected = scaleGlyphToAsset(GLYPHS[glyph])
    const actual = readFileSync(iconPath(pkg), 'utf8')
    assert.equal(actual, expected, `${pkg} 资产与 glyph 重算不一致,重跑 scripts/generate-icons.mjs`)
  }
})

test('场景2(主):构建产物过官方校验器且图标与资产字节一致', () => {
  const { index } = buildIndex(fetchNpmMapCache)
  const validated = parseMarketIndex(index, indexUrl)
  assert.equal(validated.format, 1)
  assert.equal(validated.plugins.length, CATALOG_PACKAGES.length)
  for (const plugin of validated.plugins) {
    const pkg = plugin.name.replace('@mzzsfy/', '')
    assert.match(plugin.icon, /^data:image\/svg\+xml;base64,/, `${pkg} icon 非内联 SVG`)
    const decoded = Buffer.from(plugin.icon.slice('data:image/svg+xml;base64,'.length), 'base64')
    assert.equal(decoded.toString('utf8'), readFileSync(iconPath(pkg), 'utf8'), `${pkg} 索引图标与资产不一致`)
  }
})

test('场景3(边界):全部图标解码体积在校验器上限内且非空壳', () => {
  const icons = buildIcons()
  for (const [pkg, svg] of icons) {
    const bytes = Buffer.byteLength(svg, 'utf8')
    assert.ok(bytes >= 100, `${pkg} 图标疑似空壳`)
    assert.ok(bytes <= MAX_INLINE_ICON_BYTES, `${pkg} 图标超 data: 上限`)
  }
})

// registry 快照本轮拉取一次,场景 4/6 共享:减少公网串行放大,失败(网络)与
// 锁失效(内容不一致)在场景 6 有了独立区分路径
const npmMapShared = await fetchNpmMap()

test('场景4(边界):索引覆盖恰好全部目标包且版本与 registry 一致', () => {
  const { index } = buildIndex(npmMapShared)
  const names = index.plugins.map((p) => p.name).sort()
  assert.deepEqual(names, CATALOG_PACKAGES.map((p) => `@mzzsfy/${p}`).sort())
  for (const plugin of index.plugins) {
    assert.equal(plugin.versions[0].version, npmMapShared.get(plugin.name.replace('@mzzsfy/', '')).version)
    assert.equal(plugin.versions[0].source.type, 'npm')
    assert.ok(plugin.title, `${plugin.name} 缺 title`)
    assert.ok(plugin.description, `${plugin.name} 缺 description`)
  }
})

test('场景5(边界):构建确定性——两次构建字节一致', () => {
  const first = renderIndex(buildIndex(npmMapShared).index)
  const second = renderIndex(buildIndex(npmMapShared).index)
  assert.equal(first, second)
})

test('场景6(边界):落盘 catalog 产物与当前构建一致(防过期提交)', () => {
  const committed = readFileSync(`${repo}packages/dsh-plugin-catalog/index.json`, 'utf8')
  const built = renderIndex(buildIndex(npmMapShared).index)
  assert.equal(committed, built)
})

test('场景7(边界):构建函数不写盘——产物集合与内容在构建前后不变', () => {
  const artifact = `${repo}packages/dsh-plugin-catalog/index.json`
  const before = readFileSync(artifact, 'utf8')
  buildIndex(npmMapShared)
  buildIcons()
  assert.equal(readFileSync(artifact, 'utf8'), before, 'buildIndex/buildIcons 不应有写盘副作用')
})
