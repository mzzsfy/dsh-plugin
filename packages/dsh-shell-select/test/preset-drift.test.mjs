import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
}))
const patch = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema })
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const inserted = patch.flatMap((entry) => entry.insert ?? [])

// Given 插件补丁，When 应用插入行，Then 只增加宿主执行面，不声明会话预设。
test('补丁仅插入主行、guard 与 web，不增加会话预设', () => {
  assert.deepEqual(inserted.map(({ id, name }) => ({ id, name })), [
    { id: 'shell-select', name: '@mzzsfy/dsh-shell-select' },
    { id: 'shell-select/guard', name: '@mzzsfy/dsh-shell-select/guard' },
    { id: 'shell-select/web', name: '@mzzsfy/dsh-shell-select/web' },
  ])
})

// Given 任意宿主默认预设，When 应用插件补丁，Then 不覆写既有组合行。
test('补丁不覆写宿主行或默认预设', () => {
  assert.equal(patch.length, 1)
  assert.deepEqual(Object.keys(patch[0]), ['insert'])
})

// Given 不同宿主平台，When 求值禁用表达式，Then Windows 启用、POSIX 停用。
test('宿主行保持 Windows 平台门控', () => {
  assert.equal(inserted.length, 3)
  for (const row of inserted) {
    const evaluate = new Function('process', `return (${row.disabled.__jsExpr})`)
    assert.equal(evaluate({ platform: 'win32' }), false)
    assert.equal(evaluate({ platform: 'linux' }), true)
    assert.equal(evaluate({ platform: 'darwin' }), true)
  }
})

// Given 插件清单，When 对账宿主依赖，Then 删除预设依赖但保留最低宿主版本。
test('清单不再依赖预设模块，宿主门槛不变化', () => {
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-agent-preset'], undefined)
  assert.equal(manifest.dsh.hostMin, '0.1.7-rc.1')
})
