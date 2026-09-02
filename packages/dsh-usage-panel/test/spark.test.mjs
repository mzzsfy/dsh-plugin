// SVG 点位计算纯逻辑 BDD:绝对值折线 / 差值柱状双视角。无 DOM 依赖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSparkPoints, computeDiffBars, SPARK_WIDTH, SPARK_HEIGHT, HOVER_WINDOW_POINTS } from '../src/spark.mjs'

test('场景: 绝对值视角产出归一化点位', () => {
  const points = [
    { t: 0, v: 100 },
    { t: 10, v: 50 },
    { t: 20, v: 75 },
  ]
  const result = computeSparkPoints({ points, mode: 'abs', width: 200, height: 60 })
  assert.equal(result.length, 3)
  assert.equal(result[0].x, 0)
  assert.equal(result[2].x, 200, '末点落在右边界')
  assert.equal(result.find((p) => p.y === 0).v, 100, '最大值在顶端')
  assert.equal(result.find((p) => p.y === 60).v, 50, '最小值在底端')
})

test('场景: 平直序列居中绘制', () => {
  const points = [
    { t: 0, v: 5 },
    { t: 10, v: 5 },
  ]
  const result = computeSparkPoints({ points, mode: 'abs', width: 200, height: 60 })
  assert.ok(result.every((p) => p.y === 30), '零跨度时取高度中点')
})

test('场景: 差值视角自第二点起', () => {
  const points = [
    { t: 0, v: 100 },
    { t: 10, v: 60 },
    { t: 20, v: 90 },
  ]
  const bars = computeDiffBars(points)
  assert.deepEqual(bars, [
    { t: 10, v: -40 },
    { t: 20, v: 30 },
  ])
})

test('场景: 差值柱状正负方向归一化', () => {
  const result = computeSparkPoints({
    points: [
      { t: 0, v: 100 },
      { t: 10, v: 60 },
      { t: 20, v: 90 },
    ],
    mode: 'diff',
    width: 200,
    height: 60,
  })
  assert.equal(result.length, 2, '首点无前值不绘制')
  const down = result.find((p) => p.v === -40)
  const up = result.find((p) => p.v === 30)
  assert.ok(down.y > 30, '消耗柱向下越过中线')
  assert.ok(up.y < 30, '充值柱向上越过中线')
  assert.ok(Math.abs(down.y - 30) <= 30 + 1e-9 && Math.abs(up.y - 30) <= 30 + 1e-9, '幅度不超过半高')
})

test('场景: 少于两点不产图', () => {
  assert.deepEqual(computeSparkPoints({ points: [{ t: 0, v: 1 }], mode: 'abs', width: 200, height: 60 }), [])
})

test('常量: 悬浮窗默认档点数与画布尺寸可导出', () => {
  assert.ok(SPARK_WIDTH > 0)
  assert.ok(SPARK_HEIGHT > 0)
  assert.equal(HOVER_WINDOW_POINTS, 24)
})
