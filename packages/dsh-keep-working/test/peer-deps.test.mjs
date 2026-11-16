// 打包契约:动态 import 的宿主包必须声明 peer,否则安装副本缺依赖时插件静默停用
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('dsh-llm 动态 import 声明为 peerDependency', () => {
  const range = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
  assert.equal(typeof range, 'string', '缺少 @deepseek-ai/dsh-llm peer 声明')
  assert.match(range, /^>=0\.1\.5-rc\.2$/)
})
