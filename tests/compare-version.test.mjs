import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersion, judgeHostMin } from '../scripts/compare-version.mjs'

// compareVersion 语义锁定(dev-link hostMin 与 compat 装载过滤双消费方同源)
test('compareVersion 核心段与宽度差异', () => {
  assert.equal(compareVersion('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersion('0.1.5', '0.1.7'), -1)
  assert.equal(compareVersion('0.10.0', '0.9.0'), 1)
  // 宿主出现过 4 位形态:缺位补 0 对齐
  assert.equal(compareVersion('1.2.3.4', '1.2.3'), 1)
  assert.equal(compareVersion('1.2.3', '1.2.3.0'), 0)
})

test('compareVersion prerelease 低于同位正式版且段间有序', () => {
  assert.equal(compareVersion('0.2.0-rc.1', '0.2.0'), -1)
  assert.equal(compareVersion('0.2.0-rc.1', '0.2.0-rc.2'), -1)
  assert.equal(compareVersion('0.2.0-alpha.1', '0.2.0-rc.1'), -1)
  assert.equal(compareVersion('0.1.7-rc.2', '0.1.7-rc.1'), 1)
  assert.equal(compareVersion('0.2.0-rc.1', '0.2.0-rc.1'), 0)
})

test('compareVersion 形态不合法返回 null', () => {
  assert.equal(compareVersion('abc', '0.2.0'), null)
  assert.equal(compareVersion('0.2', '0.2.0'), null)
  assert.equal(compareVersion('0.2.0', ''), null)
})

test('judgeHostMin 四态:缺失跳过/低版本拒绝/达线放行/形态跳过', () => {
  // 任一缺失 → skip(不阻塞主流程)
  assert.equal(judgeHostMin(undefined, '0.1.7-rc.1'), 'skip')
  assert.equal(judgeHostMin('0.2.0-rc.2', undefined), 'skip')
  assert.equal(judgeHostMin(undefined, undefined), 'skip')
  // 宿主低于 hostMin → fail(0.1.5 宿主 × shell-select hostMin 0.1.7-rc.1 实景)
  assert.equal(judgeHostMin('0.1.5-rc.3', '0.1.7-rc.1'), 'fail')
  assert.equal(judgeHostMin('0.1.7-rc.2', '0.2.0-rc.1'), 'fail')
  // 达线 → pass(等号边界:恰为 hostMin 即放行)
  assert.equal(judgeHostMin('0.1.7-rc.1', '0.1.7-rc.1'), 'pass')
  assert.equal(judgeHostMin('0.2.0-rc.2', '0.2.0-rc.1'), 'pass')
  assert.equal(judgeHostMin('0.2.0', '0.2.0-rc.2'), 'pass')
  // 形态无法比较 → skip
  assert.equal(judgeHostMin('not-a-version', '0.1.7-rc.1'), 'skip')
})
