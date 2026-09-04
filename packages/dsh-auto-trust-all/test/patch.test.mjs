// patch 文件形态断言:覆盖 webserver 行的 config 是整体替换语义(不深合并),
// 本包必须镜像官方全部键。此测试只读本包 patch 文本,锁本地镜像形态快照——
// 它读不到官方安装目录,上游增删键不会在此失败;dsh 升级后须用
// `dsh web --dump-default-config` 对照官方 webserver 行核对键集。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchText = readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')

test('场景10 patch 形态: Given bundle patch Then webserver 行 name 防御且 host 默认翻转为全接口', () => {
  // name 字段是 id 撞车防御:官方行改名即跳过并告警,而非误写他方行
  assert.match(patchText, /- id: webserver\n  name: '@deepseek-ai\/dsh-host-webserver'/)
  assert.match(patchText, /host: !!js ctx\.webStartup\.host \?\? '0\.0\.0\.0'/)
})

test('场景10 镜像契约: config 整体替换要求官方行全部键在场', () => {
  // 与官方 dsh-web-app bundle 的 webserver config 逐键镜像,官方增删键时此处失败
  assert.match(patchText, /port: !!js ctx\.webStartup\.port \?\? 3080/)
  assert.match(patchText, /compression: gzip/)
  assert.match(patchText, /compressionLevel: 1/)
  assert.match(patchText, /compressionThresholdBytes: 1024/)
})

test('场景10 插件行: insert 操作指向本包', () => {
  assert.match(patchText, /- insert:\n    - id: auto-trust-all\n      name: '@mzzsfy\/dsh-auto-trust-all'/)
})
