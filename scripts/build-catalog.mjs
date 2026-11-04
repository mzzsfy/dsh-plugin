// 自建商店索引构建器:已发布插件包 + data: 内联 SVG 图标,输出 format 1 索引。
// 纯函数构建 + 落盘入口两段;npm 源为唯一源形态,发布时间取 registry 元数据。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CATALOG_PACKAGES, CATEGORY_MAP, CATEGORY_TITLES } from './catalog-manifest.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICON_PREFIX = 'data:image/svg+xml;base64,'
const HOMEPAGE_TEMPLATE = 'https://awesome-dsh-plugin.com/p/mzzsfy__dsh-plugin--packages-<pkg>/'
const REPO_URL = 'https://github.com/mzzsfy/dsh-plugin'
const AUTHOR = 'mzzsfy'
const REGISTRY_TIMEOUT = 30 * 1000
const SEC_PER_MS = 1000

export const buildIcons = () => {
  const icons = new Map()
  for (const pkg of CATALOG_PACKAGES) {
    const svg = readFileSync(join(repo, 'assets/icons', `${pkg}.svg`), 'utf8')
    icons.set(pkg, svg)
  }
  return icons
}

// npm publishTimestamp 用 registry 元数据而非本地时钟:构建确定性场景要求
// 同输入恒同输出,本地时钟两次构建必不同。
export async function fetchNpmMap() {
  const map = new Map()
  for (const pkg of CATALOG_PACKAGES) {
    const res = await fetch(`https://registry.npmjs.org/@mzzsfy/${pkg}`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT) })
    if (!res.ok) throw new Error(`registry 查询失败 @mzzsfy/${pkg}: HTTP ${res.status}`)
    const doc = await res.json()
    const manifest = JSON.parse(readFileSync(join(repo, 'packages', pkg, 'package.json'), 'utf8'))
    const version = manifest.version
    const published = doc.time?.[version]
    if (typeof published !== 'string') {
      throw new Error(`registry 无 @mzzsfy/${pkg}@${version} 发布时间:本地清单领先线上时先发布包再更新 catalog`)
    }
    map.set(pkg, { version, publishTimestamp: Math.floor(new Date(published).getTime() / SEC_PER_MS) })
  }
  return map
}

export function buildIndex(npmMap) {
  const categories = {}
  for (const id of [...new Set(Object.values(CATEGORY_MAP))]) {
    if (!CATEGORY_TITLES[id]) throw new Error(`分类 ${id} 缺声明标题`)
    categories[id] = { title: { ...CATEGORY_TITLES[id] } }
  }
  const plugins = CATALOG_PACKAGES.map((pkg) => {
    const record = npmMap.get(pkg)
    const manifest = JSON.parse(readFileSync(join(repo, 'packages', pkg, 'package.json'), 'utf8'))
    const iconSvg = readFileSync(join(repo, 'assets/icons', `${pkg}.svg`), 'utf8')
    return {
      name: `@mzzsfy/${pkg}`,
      title: pkg,
      description: manifest.description,
      icon: ICON_PREFIX + Buffer.from(iconSvg, 'utf8').toString('base64'),
      author: AUTHOR,
      homepage: HOMEPAGE_TEMPLATE.replace('<pkg>', pkg),
      repository: { url: REPO_URL, directory: `packages/${pkg}` },
      metadata: { category: CATEGORY_MAP[pkg] },
      versions: [{
        version: record.version,
        publishTimestamp: record.publishTimestamp,
        source: { type: 'npm' },
      }],
    }
  })
  return {
    index: {
      format: 1,
      title: { en: 'mzzsfy dsh plugins', zh: 'mzzsfy 的 dsh 插件' },
      description: {
        en: 'All published dsh plugins from mzzsfy/dsh-plugin, with icons.',
        zh: 'mzzsfy/dsh-plugin 全部已发布插件,含商店图标。',
      },
      metadata: { categories },
      plugins,
    },
  }
}

export const renderIndex = (index) => JSON.stringify(index, null, 2) + '\n'

// 落盘入口:产物即包发布体,发布流程(publish.mjs)只打包已跟踪文件
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const npmMap = await fetchNpmMap()
  const { index } = buildIndex(npmMap)
  const outDir = join(repo, 'packages/dsh-plugin-catalog')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.json'), renderIndex(index))
  console.log(`packages/dsh-plugin-catalog/index.json: ${index.plugins.length} plugins`)
}
