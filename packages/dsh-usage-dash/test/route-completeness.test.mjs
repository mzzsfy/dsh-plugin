// 端点完整性测试:成本控制四模块的端点必须全部注册。
// 少一条会让对应客户端卡片静默空白,因此这里锁定完整路径集合。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { registerUsageRoutes } from '../src/routes.js'

const ROUTE_PREFIX = '/api/usage-dash'
const EXPECTED_PATHS = [
  `${ROUTE_PREFIX}/range`,
  `${ROUTE_PREFIX}/hours`,
  `${ROUTE_PREFIX}/minutes`,
  `${ROUTE_PREFIX}/status`,
  `${ROUTE_PREFIX}/reset`,
  `${ROUTE_PREFIX}/restore`,
  `${ROUTE_PREFIX}/pricing`,
  `${ROUTE_PREFIX}/summary`,
  `${ROUTE_PREFIX}/budget`,
  `${ROUTE_PREFIX}/cycle`,
  `${ROUTE_PREFIX}/sentinel`,
  `${ROUTE_PREFIX}/sentinel/ack`,
  `${ROUTE_PREFIX}/whatif`,
  `${ROUTE_PREFIX}/features`,
]

function makeCtx() {
  const paths = []
  return {
    paths,
    logger: { warn() {} },
    webServer: {
      register(route) {
        paths.push(route.path)
        return () => {}
      },
    },
    effect(setup) {
      setup()
    },
  }
}

function registeredPaths() {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, {
    store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
    collector: { running: false, rebuilding: false, status: () => ({}) },
    retentionDays: () => 7,
    pricing: { active: false, rules: () => [], revision: () => 0 },
  })
  return ctx.paths
}

test('Given 成本控制四模块全部启用 When 注册路由 Then 十四个端点齐全', () => {
  // When 注册
  const paths = registeredPaths()
  // Then 集合完全一致,多一条少一条都算缺陷
  assert.deepEqual([...paths].sort(), [...EXPECTED_PATHS].sort())
})

test('Given 注册参数 When 重建 deps Then 每个能力门面都不丢', () => {
  // 解构签名与重建对象必须同时带上,否则 handler 会静默落到 INACTIVE 替身
  const source = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8')
  const signature = source.match(/export function registerUsageRoutes\(\s*ctx,\s*\{([^}]+)\}/)
  assert.ok(signature, '缺少 registerUsageRoutes 签名')
  const declared = signature[1].split(',').map((item) => item.trim().split('=')[0].trim())
  const rebuild = source.match(/const deps = \{([^}]+)\}/)
  assert.ok(rebuild, '缺少 deps 重建')
  // 注释里也有逗号,先剥注释再切键
  const rebuilt = rebuild[1].replace(/\/\/[^\n]*/g, '').split(',').map((item) => item.trim().split(':')[0].trim())
  for (const key of ['pricing', 'budget', 'cycle', 'sentinel', 'features', 'guard']) {
    assert.ok(declared.includes(key), `解构签名缺 ${key}`)
    assert.ok(rebuilt.includes(key), `deps 重建缺 ${key}`)
  }
  // summary/预算读的是派生的只读面:漏了它照样 500,前面「有 cycle 对象」拦不住
  assert.ok(rebuilt.includes('cycleConfig'), 'deps 重建缺 cycleConfig')
  assert.match(source, /cycleConfig: \(\) => cycle\?\.config\?\.\(\)/, 'cycleConfig 派生缺失')
})
