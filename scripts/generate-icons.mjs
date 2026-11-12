// 商店图标资产生成:16 viewBox 源图放大为 96 视图资产。
// 源图两类:nav-icons 内置 glyph(插件同时有导航入口时与导航图标同形),或本文件内
// 声明、仅服务商店卡片的专属图形(插件没有导航入口、内置表也没有合适寓意时)。
// 坐标缩放系数由目标视图与源视图之比计算;产物幂等,改动映射或图形后重跑再提交资产。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLYPHS, pathOf, svgOf } from '../packages/dsh-settings-nav-icons/src/logic.mjs'

// 商店专属图形:与 nav-icons glyph 同一坐标系与描边规格
export const STORE_GLYPHS = {
  // 循环续跑:一圈缺口的圆弧加回收箭头
  loop: svgOf(pathOf('M12.69 9.8a5.4 5.4 0 1 1-1.27-5.62L14.2 6.8') + pathOf('M14.2 3.2v3.6h-3.6')),
  // 心跳线:性能曲线
  pulse: svgOf(pathOf('M1.8 8h3l2.1-4.4 2.7 8.8 2-4.4h2.4')),
}

// 图标映射:glyph 名取自 nav-icons 内置表或上面的商店专属图形;tunnel 商店面取 zap 避免与 llm-pi-gateway 撞形
export const ICON_MAP = {
  'dsh-auto-trust-all': 'shield',
  'dsh-boss-simulator': 'plan',
  'dsh-bug-perf': 'pulse',
  'dsh-common-tools': 'cube',
  'dsh-context-manager': 'git',
  'dsh-cron-board': 'plan',
  'dsh-keep-working': 'loop',
  'dsh-llm-pi-gateway': 'globe',
  'dsh-maintain': 'wrench',
  'dsh-rs-workflow': 'flow',
  'dsh-session-manager': 'archive',
  'dsh-settings-nav-icons': 'tune',
  'dsh-shared-terminal': 'cards',
  'dsh-shell-select': 'term',
  'dsh-stock-assistant': 'chart',
  'dsh-think-expand': 'spark',
  'dsh-tool-gate': 'layers',
  'dsh-tunnel': 'zap',
  'dsh-turn-notify': 'bell',
  'dsh-usage-dash': 'gauge',
  'dsh-usage-panel': 'wallet',
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repo, 'assets/icons')
const SOURCE_VIEW = 16
const TARGET_VIEW = 96
const SCALE = TARGET_VIEW / SOURCE_VIEW
// 16 系 1.5 描边等比放大,48px 消费框内观感与 nav-icons 头像槽一致
const SOURCE_STROKE = 1.5

const round = (value) => String(Math.round(parseFloat(value) * SCALE * 100) / 100)

// path 数据按命令分段:arc(a/A)7 参数组中第 3/4/5 位是 x-axis-rotation 与
// large-arc/sweep 布尔旗标——角度与旗标是等比变换不变量(缩放角度会改弧朝向,
// 旗标按 SVG 规范只允许 0|1),均不参与缩放;其余命令数值全部等比缩放
const scalePathData = (d) =>
  d.replace(/([a-zA-Z])([^a-zA-Z]*)/g, (_, cmd, params) => {
    const nums = params.match(/-?\d*\.?\d+/g)
    if (!nums) return cmd + params
    const isArc = cmd === 'a' || cmd === 'A'
    const scaled = nums.map((n, i) => {
      const slot = i % 7
      if (isArc && (slot === 2 || slot === 3 || slot === 4)) return n
      return round(n)
    })
    return cmd + ' ' + scaled.join(' ')
  })

const scaleInner = (inner) =>
  inner
    // 成对几何属性按名缩放,stroke 类属性不动
    .replace(/(\s(?:x|y|cx|cy|r|rx|ry|x1|y1|x2|y2|width|height))="(-?[\d.]+)"/g, (_, attr, v) => `${attr}="${round(v)}"`)
    .replace(/\sd="([^"]+)"/g, (_, d) => ` d="${scalePathData(d)}"`)
    .replaceAll(`stroke-width="${SOURCE_STROKE}"`, `stroke-width="${SOURCE_STROKE * SCALE}"`)

// 单 glyph 完整转换:测试以此做黄金对照,脚本入口与导出共用同一实现
export const scaleGlyphToAsset = (glyphSvg) => {
  const inner = scaleInner(glyphSvg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, ''))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TARGET_VIEW} ${TARGET_VIEW}" fill="none">${inner}</svg>\n`
}

// 写盘只在 CLI 直跑时执行:测试 import 本模块做黄金对照,不得携带写盘副作用。
// 双侧 resolve 归一:argv 形态(相对/正反斜杠)不影响直跑判定
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  mkdirSync(outDir, { recursive: true })
  for (const [pkg, glyph] of Object.entries(ICON_MAP)) {
    const source = GLYPHS[glyph] ?? STORE_GLYPHS[glyph]
    if (!source) throw new Error(`${pkg}: 未知 glyph ${glyph}`)
    writeFileSync(join(outDir, `${pkg}.svg`), scaleGlyphToAsset(source))
    console.log(`${pkg} <- ${glyph}`)
  }
}
