import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 范围 pill 组契约:顶栏范围标签可点击直达切换(替代旧只读胶囊),←/→ 键盘切换走同一落点
test('源码契约:范围标签以 pill 组渲染且点击直达切换', () => {
  assert.ok(CLIENT_SRC.includes('cx-hist__scopebar'), '应有范围 pill 组容器样式锚点')
  assert.ok(CLIENT_SRC.includes('cx-hist__pill--on'), '选中范围应有高亮态')
  assert.ok(CLIENT_SRC.includes('HISTORY_SCOPE_LABELS.map('), '范围标签应循环渲染为 pill 组')
  assert.ok(CLIENT_SRC.includes('onClick: () => selectScope(idx)'), 'pill 点击应直达对应范围')
})

test('源码契约:selectScope 为键盘与点击共用的唯一切换落点', () => {
  assert.ok(CLIENT_SRC.includes('function selectScope('), '应有 selectScope 直达切换函数')
  // 键盘相对切换委托 selectScope,消除重复切换链
  assert.ok(/function switchScope\(\s*delta\s*\)\s*\{[\s\S]{0,200}selectScope\(next\)/.test(CLIENT_SRC),
    'switchScope 应委托 selectScope')
  // 同范围重复点击不重拉
  const body = CLIENT_SRC.match(/function selectScope\([^)]*\)\s*\{[\s\S]*?\n  \}/)
  assert.ok(body && body[0].includes('viewRef.current.scopeIndex'), 'selectScope 应以当前范围守卫幂等')
})

test('源码契约:设置悬停说明同步点击切换语义', () => {
  assert.ok(CLIENT_SRC.includes('点击顶栏范围标签直达'), '历史说明缺范围标签点击切换语义')
  assert.ok(CLIENT_SRC.includes('←/→ 切换范围'), '历史说明应保留键盘切换语义')
})
