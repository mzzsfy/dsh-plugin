// client 半区 React hooks 解构静态断言:client.js 为经典 bundle,组件渲染路径
// 无运行时测试,hooks 未从 React 解构的缺陷(useRef is not a function)只能靠
// 源码静态比对拦截——组件体内使用的全部 hooks 必须出现在解构清单。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')

test('client.js 组件使用的全部 React hooks 均在解构清单中', () => {
  // Given 解构行(const { ... } = React)与全源码 hooks 调用
  const destructure = /const\s*\{([^}]+)\}\s*=\s*React\b/.exec(source)
  assert.notEqual(destructure, null, 'React 解构行必须存在')
  const declared = new Set(destructure[1].split(',').map((name) => name.trim()).filter(Boolean))
  const used = [...source.matchAll(/\b(use[A-Z]\w*)\s*\(/g)].map((match) => match[1])
  assert.ok(used.length > 0, '至少存在一个 hooks 调用,否则断言失效')
  // Then 每个使用的 hooks 都已声明
  const missing = [...new Set(used)].filter((name) => !declared.has(name))
  assert.deepEqual(missing, [], '未解构的 hooks(渲染即 ReferenceError)')
})

test('client.js 不存在 React.useXxx 直调形态(绕过解构清单)', () => {
  const direct = [...source.matchAll(/\bReact\.(use[A-Z]\w*)\s*\(/g)].map((match) => match[1])
  assert.deepEqual(direct, [], 'hooks 一律经解构清单使用,便于静态断言')
})
