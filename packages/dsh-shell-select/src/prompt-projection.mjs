// 只收敛模型投影，不改工具注册或执行策略；旧调用保持原 PowerShell 契约。
// tools/sections 特性检测：0.2.2 起 system-prompt 的 assemble 把 tools 移到
// waterfall 之后合并，链值不再携带该字段（0.2.1 内联 orderTools）——字段缺席时
// 原样透传，pwsh 过滤失效只告警，绝不抛错打断回合管线（宿主升级即崩形态）。
export function mountShellPromptProjection(ctx) {
  if (typeof ctx.on !== 'function') return
  let warned = false
  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    if (ctx.tools.get('shell', context.scope) === undefined) return result
    if (!Array.isArray(result.tools) || !Array.isArray(result.sections)) {
      if (!warned) {
        warned = true
        ctx.logger.warn(`shell-select: 宿主 assemble 链值缺 tools/sections 数组，pwsh 投影停用（宿主 ${'system-prompt'} 契约变更，登记 dsh-api-alignment）`)
      }
      return result
    }
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
