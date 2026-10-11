// 只收敛模型投影，不改工具注册或执行策略；旧调用保持原 PowerShell 契约。
export function mountShellPromptProjection(ctx) {
  if (typeof ctx.on !== 'function') return
  let warned = false
  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    if (ctx.tools.get('shell', context.scope) === undefined) return result
    let sections = result.sections
    const sdk = sections.find((section) => section.name === 'tools:sdk' && section.text.trim() !== '')
    if (sdk !== undefined) {
      try {
        const { renderToolsSdk, renderToolsSdkPy } = await import('@deepseek-ai/dsh-tools')
        const render = { typescript: renderToolsSdk, python: renderToolsSdkPy }[ctx.get('ptcRuntime')?.language]
        if (typeof render !== 'function') throw new Error('PTC SDK renderer is unavailable')
        const schemas = ctx.tools.schemas(context.scope)
          .filter((schema) => schema.name !== 'pwsh' && schema.name !== 'run_code')
          .map((schema) => ({ ...schema, output: ctx.tools.get(schema.name, context.scope).output.schema }))
        const text = render(schemas)
        sections = sections.map((section) => section === sdk ? { ...section, text, interpolate: false } : section)
      } catch (error) {
        if (!warned) {
          warned = true
          ctx.logger.warn(`shell-select: 模型工具投影未启用，保留原始工具与SDK：${error.message}`)
        }
        return result
      }
    }
    return {
      ...result,
      tools: result.tools.filter((tool) => tool.name !== 'pwsh'),
      sections: sections.filter((section) => section.name !== 'tool:pwsh'),
    }
  }, { prepend: true })
}
