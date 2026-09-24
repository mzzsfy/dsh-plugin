import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 范围标签契约:默认单胶囊只显当前范围,点击展开 pill 组,选择后收起;←/→ 键盘切换走同一落点
test('源码契约:范围标签默认单胶囊,点击展开 pill 组选择', () => {
  assert.ok(CLIENT_SRC.includes('const [scopeOpen, setScopeOpen] = useState(false)'), '展开态应默认收起')
  assert.ok(CLIENT_SRC.includes('HISTORY_SCOPE_LABELS[scopeIndex]'), '默认应单胶囊显示当前范围')
  assert.ok(CLIENT_SRC.includes('HISTORY_SCOPE_LABELS.map('), '展开后应循环渲染 pill 组')
  assert.ok(CLIENT_SRC.includes('onClick: () => setScopeOpen(true)'), '单胶囊点击应展开')
  assert.ok(CLIENT_SRC.includes('onClick: () => (idx === scopeIndex ? setScopeOpen(false) : selectScope(idx))'), 'pill 点击应直达对应范围,当前项点击收起')
})

test('源码契约:selectScope 为键盘与点击共用的唯一切换落点,切换即收起', () => {
  assert.ok(CLIENT_SRC.includes('function selectScope('), '应有 selectScope 直达切换函数')
  // 键盘相对切换委托 selectScope,消除重复切换链
  assert.ok(/function switchScope\(\s*delta\s*\)\s*\{[\s\S]{0,200}selectScope\(next\)/.test(CLIENT_SRC),
    'switchScope 应委托 selectScope')
  // 同范围重复点击不重拉
  const body = CLIENT_SRC.match(/function selectScope\([^)]*\)\s*\{[\s\S]*?\n  \}/)
  assert.ok(body && body[0].includes('viewRef.current.scopeIndex'), 'selectScope 应以当前范围守卫幂等')
  assert.ok(body && body[0].includes('setScopeOpen(false)'), '切换后应收起展开态')
})

test('源码契约:重开浮层展开态复位,设置悬停说明同步展开语义', () => {
  // openPopup 内 setScopeOpen(false):浮层重开不残留展开态
  assert.ok(/function openPopup\(\)\s*\{[\s\S]{0,300}setScopeOpen\(false\)/.test(CLIENT_SRC),
    '浮层重开应复位展开态')
  assert.ok(CLIENT_SRC.includes('点击顶栏范围标签展开选择'), '历史说明缺范围标签展开选择语义')
  assert.ok(CLIENT_SRC.includes('←/→ 切换范围'), '历史说明应保留键盘切换语义')
})
