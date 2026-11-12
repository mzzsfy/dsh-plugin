// 闸门实现一致性:17 份副本必须逐字节同源,避免各族语义漂移(异常路径放行/拒绝曾漂过一轮)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = new URL('../packages/', import.meta.url)

function copies() {
  const found = []
  for (const name of readdirSync(PACKAGES).sort()) {
    for (const dir of ['src', 'lib']) {
      const file = join(PACKAGES.pathname.slice(1), name, dir, 'route-gate.mjs')
      const path = new URL(`../packages/${name}/${dir}/route-gate.mjs`, import.meta.url)
      if (!existsSync(path)) continue
      found.push({ name, dir, text: readFileSync(path, 'utf8') })
    }
  }
  return found
}

test('每个有路由的包都带 route-gate.mjs,且副本逐字节一致', () => {
  const all = copies()
  assert.ok(all.length >= 15, `副本数量 ${all.length}`)
  const [first, ...rest] = all
  for (const item of rest) {
    assert.equal(item.text, first.text, `${item.name}/${item.dir}/route-gate.mjs 与 ${first.name} 不一致`)
  }
})

test('副本必须把闸门自身异常判为拒绝,不得 fail-open', () => {
  for (const item of copies()) {
    assert.match(item.text, /catch \{\s*\/\/[^]*?rejection = 403/, `${item.name} 的 catch 分支未按 403 拒绝`)
    assert.doesNotMatch(item.text, /rejection = undefined\s*\n\s*\}\s*\n\s*if \(rejection === undefined\) return false/)
  }
})

test('maintain 与 common-tools 的内联实现同样是 fail-closed', () => {
  const maintain = readFileSync(new URL('../packages/dsh-maintain/src/index.js', import.meta.url), 'utf8')
  assert.match(maintain, /function rejectUnadmitted[\s\S]*?catch \{[\s\S]*?rejection = 403/)
  const bus = readFileSync(new URL('../packages/dsh-common-tools/src/host.js', import.meta.url), 'utf8')
  assert.match(bus, /const admit = \(req\)[\s\S]*?catch \{\s*return 403/)
})
