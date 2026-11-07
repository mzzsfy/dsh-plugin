import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 图表色是自定色, 不受语义槽位约束, 但必须保证每个主题下都看得清、线之间分得开。
// 这里直接解析 client.js 里的 token 声明, 改色若跌破阈值就会红。
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const TOKENS = ['ma-fast', 'ma-mid', 'ma-slow', 'ma-long', 'ema', 'boll-mid', 'boll-rail', 'bbi', 'cost']
// 一像素宽曲线的经验下限, 以及两条细线能被区分的大致色差
const CONTRAST_MIN = 2.5
const DELTA_E_MIN = 12
// 底色候选: 亮色白与近白, 暗色两级深底
const BACKGROUNDS = { light: [1, 0.98], dark: [0.1, 0.15] }

const parseHsl = text => {
  const m = text.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/)
  assert.ok(m, `无法解析的颜色: ${text}`)
  return { h: +m[1], s: +m[2] / 100, l: +m[3] / 100 }
}
const toRgb = ({ h, s, l }) => {
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}
const linear = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = hsl => {
  const [r, g, b] = toRgb(hsl).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const grayLuminance = lightness => luminance({ h: 0, s: 0, l: lightness })
const contrast = (a, b) => {
  const [hi, lo] = [a, b].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
// CIELAB 距离: 只看色相不够, 亮度差同样影响细线的可分性
const toLab = hsl => {
  const [r, g, b] = toRgb(hsl).map(linear)
  const [x, y, z] = [r * 0.4124 + g * 0.3576 + b * 0.1805, r * 0.2126 + g * 0.7152 + b * 0.0722, r * 0.0193 + g * 0.1192 + b * 0.9505]
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(x / 0.9505), f(y), f(z / 1.089)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
const deltaE = (a, b) => {
  const [la, aa, ba] = toLab(a), [lb, ab, bb] = toLab(b)
  return Math.hypot(la - lb, aa - ab, ba - bb)
}

// 把某一段 CSS 里的 --ssb-chart-* 取成 { key: 'hsl(...)' }
const paletteOf = (css, declaration) => {
  const block = css.match(declaration)
  assert.ok(block, `找不到声明: ${declaration}`)
  const found = {}
  for (const m of block[0].matchAll(/--ssb-chart-([a-z-]+):\s*(hsl\([^)]*\))/g)) found[m[1]] = m[2]
  return found
}

const load = async () => {
  const css = await read('src/client.js')
  return {
    light: paletteOf(css, /\.ssb-root,\.ssb-float-root \{[^}]*--ssb-chart-ma-fast[^}]*\}/),
    dark: paletteOf(css, /\[data-ds-dark-theme\] \.ssb-root,\[data-ds-dark-theme\] \.ssb-float-root \{[^}]*\}/),
  }
}

test('两套图表色都声明齐全, 且悬浮窗与面板共用同一组', async () => {
  const { light, dark } = await load()
  assert.deepEqual(Object.keys(light).sort(), [...TOKENS].sort())
  assert.deepEqual(Object.keys(dark).sort(), [...TOKENS].sort())
  // 选择器必须同时覆盖面板根与悬浮窗根, 否则 portal 到 body 的悬浮窗拿不到色
  const css = await read('src/client.js')
  assert.match(css, /\[data-ds-dark-theme\] \.ssb-root,\[data-ds-dark-theme\] \.ssb-float-root/)
})

test('两条轴边框也跟着主题走, 且 readChartTheme 引用的 token 都真的声明过', async () => {
  const css = await read('src/client.js')
  // 键名写错时变量查不到会静默回退成空串, 图上表现为"这条线不见了", 比报错更难发现
  const referenced = [...css.matchAll(/--ssb-chart-[a-z-]+/g)].map(m => m[0])
  const declared = new Set([...css.matchAll(/--ssb-chart-([a-z-]+):\s*hsl\(/g)].map(m => `--ssb-chart-${m[1]}`))
  const missing = [...new Set(referenced)].filter(token => !declared.has(token))
  assert.deepEqual(missing, [], `引用了未声明的图表色: ${missing.join(', ')}`)
})

test('每条线在自己主题的底色上都够清楚', async () => {
  const { light, dark } = await load()
  for (const [theme, palette] of Object.entries({ light, dark })) {
    for (const [key, text] of Object.entries(palette)) {
      const lum = luminance(parseHsl(text))
      const worst = Math.min(...BACKGROUNDS[theme].map(bg => contrast(lum, grayLuminance(bg))))
      assert.ok(worst >= CONTRAST_MIN, `${theme} 的 ${key} 与底色对比度只有 ${worst.toFixed(2)}, 低于 ${CONTRAST_MIN}`)
    }
  }
})

test('任意两条线之间都分得开', async () => {
  const { light, dark } = await load()
  for (const [theme, palette] of Object.entries({ light, dark })) {
    const keys = Object.keys(palette)
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const distance = deltaE(parseHsl(palette[keys[i]]), parseHsl(palette[keys[j]]))
        assert.ok(distance >= DELTA_E_MIN, `${theme} 的 ${keys[i]} 与 ${keys[j]} 色差只有 ${distance.toFixed(1)}, 低于 ${DELTA_E_MIN}`)
      }
    }
  }
})

test('暗色版本整体比亮色更亮, 否则深底上等于没换色', async () => {
  const { light, dark } = await load()
  for (const key of TOKENS) {
    const lightL = parseHsl(light[key]).l, darkL = parseHsl(dark[key]).l
    assert.ok(darkL > lightL, `${key} 暗色明度 ${darkL} 未高于亮色 ${lightL}`)
  }
})
