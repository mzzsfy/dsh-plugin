// patch 文件形态断言:v2 形态起 bundle patch 只插入本插件行,不覆盖官方
// webserver 行——0.2.1 线宿主拒通配绑定,bind 责任归部署层。此测试只读本包
// patch 文本与 manifest,锁定发布物形态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchText = readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')
const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

test('场景10 patch 形态: Given bundle patch Then 仅含插件插入 op,不覆盖 webserver 且无通配绑定字样', () => {
  assert.match(patchText, /- insert:\n    - id: auto-trust-all\n      name: '@mzzsfy\/dsh-auto-trust-all'/)
  assert.doesNotMatch(patchText, /id: webserver/)
  assert.doesNotMatch(patchText, /0\.0\.0\.0/)
})

test('场景10 版本底线: manifest 声明最低验证宿主代际为 0.2.0-rc.2(同包覆盖 0.2.0/0.2.1 双线)', () => {
  assert.equal(manifest.dsh.hostMin, '0.2.0-rc.2')
})

test('场景10 兼容登记: 双目标宿主代际均在 dshReleases', () => {
  assert.equal(manifest.dsh.compatibility.dshReleases['0.2.0-rc.2'], 'compatible')
  assert.ok(manifest.dsh.compatibility.dshReleases['0.2.1-alpha.2'])
})
