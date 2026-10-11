import { AsyncLocalStorage } from 'node:async_hooks'

export const PWSH_TAKEOVER_BLOCK = Object.freeze({ type: 'shell-select-takeover', tool: 'pwsh' })

// 调用级事实独立于stdout，持久化扩展块不会进入模型文本。
export function mountPwshTakeover(ctx) {
  const calls = new AsyncLocalStorage()
  const taken = new Set()
  ctx.effect(() => () => { calls.disable(); taken.clear() })
  ctx.on('tools/execute', (exec, next) => exec.name === 'pwsh'
    ? calls.run(exec.token, next)
    : next())
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const intercepted = taken.delete(exec.token)
    const decision = await next()
    if (!intercepted || decision.kind !== 'accept' || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision
    return { ...decision, content: [...result.content, PWSH_TAKEOVER_BLOCK] }
  }, { prepend: true })
  return () => {
    const token = calls.getStore()
    if (token !== undefined) taken.add(token)
  }
}
