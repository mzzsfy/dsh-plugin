import { AsyncLocalStorage } from 'node:async_hooks'

export const PWSH_TAKEOVER_BLOCK = Object.freeze({ type: 'shell-select-takeover', tool: 'pwsh' })

// 模型可见的改道提示:直接 pwsh 调用被接管后补一条,引导后续改用 shell。
// 每调用一条,不做会话级去重——模型可能换会话或遗忘,提示成本远低于误用。
export const PWSH_REDIRECT_HINT = 'shell-select: pwsh 已由本插件接管执行,后续请改用 `shell` 工具(需要 PowerShell 语义时传 `shell="pwsh"`)。'

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
    return { ...decision, content: [...result.content, { type: 'text', text: PWSH_REDIRECT_HINT }, PWSH_TAKEOVER_BLOCK] }
  }, { prepend: true })
  return () => {
    const token = calls.getStore()
    if (token !== undefined) taken.add(token)
  }
}
