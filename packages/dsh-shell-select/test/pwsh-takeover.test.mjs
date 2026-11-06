import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PWSH_REDIRECT_HINT, mountPwshTakeover } from '../src/pwsh-takeover.mjs'

test('直接 pwsh 调用:结果追加改用 shell 的模型可见提示', async () => {
  // Given 一条进入接管执行器的 pwsh 调用;When post-execute 落定;
  // Then 除接管事实块外还有一条提示,告诉模型改用 shell。
  const listeners = new Map()
  const touch = mountPwshTakeover({ on: (name, fn) => listeners.set(name, fn), effect: (fn) => fn() })
  const exec = { name: 'pwsh', token: Symbol() }
  const result = { isError: false, content: [{ type: 'text', text: 'out' }] }
  await listeners.get('tools/execute')(exec, async () => { touch(); return result })
  const marked = await listeners.get('tools/post-execute')(exec, result, async () => ({ kind: 'accept' }))
  const hints = marked.content.filter((part) => part.type === 'text' && part.text === PWSH_REDIRECT_HINT)
  assert.equal(hints.length, 1, '缺少改道提示')
  assert.match(PWSH_REDIRECT_HINT, /shell/)
  assert.ok(marked.content.some((part) => part.type === 'shell-select-takeover'))
})

test('普通 shell 调用不追加改道提示', async () => {
  const listeners = new Map()
  const touch = mountPwshTakeover({ on: (name, fn) => listeners.set(name, fn), effect: (fn) => fn() })
  const exec = { name: 'shell', token: Symbol() }
  const result = { isError: false, content: [{ type: 'text', text: 'out' }] }
  await listeners.get('tools/execute')(exec, async () => { touch(); return result })
  const decision = await listeners.get('tools/post-execute')(exec, result, async () => ({ kind: 'accept' }))
  assert.deepEqual(decision, { kind: 'accept' })
})

test('pwsh 接管事实仅归属实际进入执行器的并行调用', async () => {
  // Given 两条 pwsh 调用；When 仅一条进入接管执行器；Then 仅该结果带标记，值与退出锚不变。
  const listeners = new Map()
  const touch = mountPwshTakeover({ on: (name, fn) => listeners.set(name, fn), effect: (fn) => fn() })
  const dispatch = listeners.get('tools/execute')
  const post = listeners.get('tools/post-execute')
  const makeExec = () => ({ name: 'pwsh', token: Symbol() })
  const taken = makeExec()
  const untouched = makeExec()
  const value = { exitCode: 2 }
  const result = { isError: false, value, content: [{ type: 'text', text: 'out\n[exit code: 2]' }] }
  await Promise.all([
    dispatch(taken, async () => { await Promise.resolve(); touch(); return result }),
    dispatch(untouched, async () => result),
  ])
  const marked = await post(taken, result, async () => ({ kind: 'accept' }))
  assert.equal(marked.kind, 'accept')
  assert.equal(marked.content[0].text, 'out\n[exit code: 2]')
  assert.ok(marked.content.some((part) => part.type === 'shell-select-takeover' && part.tool === 'pwsh'))
  assert.equal(result.value, value)
  assert.deepEqual(await post(untouched, result, async () => ({ kind: 'accept' })), { kind: 'accept' })
})

test('普通 shell 与下游替换内容保持不变，接管事实消费一次', async () => {
  // Given shell 与已接管 pwsh；When 下游策略替换内容；Then 不覆盖策略，调用事实无残留。
  const listeners = new Map()
  const touch = mountPwshTakeover({ on: (name, fn) => listeners.set(name, fn), effect: (fn) => fn() })
  const result = { content: [{ type: 'text', text: 'out' }], isError: false }
  const shell = { name: 'shell', token: Symbol() }
  await listeners.get('tools/execute')(shell, async () => { touch(); return result })
  assert.deepEqual(await listeners.get('tools/post-execute')(shell, result, async () => ({ kind: 'accept' })), { kind: 'accept' })
  const pwsh = { name: 'pwsh', token: Symbol() }
  await listeners.get('tools/execute')(pwsh, async () => { touch(); return result })
  const replacement = { kind: 'accept', content: [{ type: 'text', text: 'policy replacement' }] }
  assert.equal(await listeners.get('tools/post-execute')(pwsh, result, async () => replacement), replacement)
  assert.deepEqual(await listeners.get('tools/post-execute')(pwsh, result, async () => ({ kind: 'accept' })), { kind: 'accept' })
})
