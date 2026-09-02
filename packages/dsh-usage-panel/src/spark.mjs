// SVG 点位计算纯逻辑层:绝对值折线 / 差值柱状双视角。无 DOM 依赖,client 半区引用。

export const SPARK_WIDTH = 220
export const SPARK_HEIGHT = 60
export const HOVER_WINDOW_POINTS = 24

// 差值序列:相邻采样变化量,首点无前值不产出。
export function computeDiffBars(points) {
  const bars = []
  for (let i = 1; i < points.length; i++) {
    bars.push({ t: points[i].t, v: points[i].v - points[i - 1].v })
  }
  return bars
}

function extent(values) {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

// 归一化映射:值域线性映射到画布,零跨度取中点。
function scaleY(value, min, max, height) {
  if (max === min) return height / 2
  return height - ((value - min) / (max - min)) * height
}

// 产出 [{x, y, v, t}]:绝对值整段折线;差值自第二点起,正负围绕中线。
export function computeSparkPoints({ points, mode, width, height }) {
  const series = mode === 'diff' ? computeDiffBars(points) : points
  if (series.length < 2) return []
  if (mode === 'diff') {
    const positives = series.map((bar) => Math.max(bar.v, 0))
    const negatives = series.map((bar) => Math.min(bar.v, 0))
    const posMax = extent(positives).max
    const negMin = extent(negatives).min
    const half = height / 2
    const spanUp = posMax > 0 ? posMax : 1
    const spanDown = negMin < 0 ? -negMin : 1
    const stepX = series.length > 1 ? width / (series.length - 1) : 0
    return series.map((bar, index) => ({
      x: index * stepX,
      y: bar.v >= 0 ? half - (bar.v / spanUp) * half : half + (-bar.v / spanDown) * half,
      v: bar.v,
      t: bar.t,
    }))
  }
  const values = series.map((point) => point.v)
  const { min, max } = extent(values)
  const stepX = series.length > 1 ? width / (series.length - 1) : 0
  return series.map((point, index) => ({
    x: index * stepX,
    y: scaleY(point.v, min, max, height),
    v: point.v,
    t: point.t,
  }))
}
