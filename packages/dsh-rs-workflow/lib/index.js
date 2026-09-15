// dsh-rs-workflow — 若水工作流 v4:人可以在场的强规则编排。
// 单引擎 flow 驱动:接管会话、批次推进、结构化产出契约、审批原语、排队/注入、断点续跑、全量运行记录。
// 设计契约:docs/rsww-v4/。本文件只做行角色分发,业务在 lib/ 各模块。
import z from '@deepseek-ai/schemastery'
import { SETTINGS_SCHEMA, NAMESPACE, baseOf } from './settings-schema.mjs'
import { builtinTemplates } from './builtin-templates.mjs'
import { sweepLegacyReleases, ensureMainReleased, unreleaseFlowTemplate, releaseFlowTemplate } from './release.mjs'
import { registerBoardRoutes } from './board.mjs'
import { registerTakeover } from './takeover.mjs'
import { createTemplateTool } from './template-tool.mjs'
import { SPEC_TEXT } from './spec.mjs'

export const name = 'rs-workflow'
export { NAMESPACE, SETTINGS_SCHEMA, SPEC_TEXT }

// 组合行 config schema(行分发字段 role 必填;v3 Config 同构)
export const Config = z.object({
  role: z.union(['settings', 'release', 'board', 'takeover', 'template-tool']).required(),
  slots: z.object({}).description('settings base:六工作位绑定(透传 settings-schema)'),
  budgets: z.object({}).description('settings base:三预算'),
  kind: z.string().description('takeover:固定 flow'),
  flowFile: z.string().description('takeover:flow.json5 绝对路径(组合 baseUrl 锚定)'),
})

export function apply(ctx, config) {
  const cfg = Config(config || {})
  if (cfg.role === 'settings') {
    ctx.inject(['settings'], (sctx) => {
      sctx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: baseOf({ slots: cfg.slots, budgets: cfg.budgets }) })
    })
    return
  }
  if (cfg.role === 'release') {
    releaseRole(ctx)
    return
  }
  if (cfg.role === 'board') {
    registerBoardRoutes(ctx)
    return
  }
  if (cfg.role === 'takeover') {
    registerTakeover(ctx, { kind: 'flow', flowFile: cfg.flowFile })
    return
  }
  registerTemplateTool(ctx)
}

// release 行:无宿主服务依赖,恒可执行;失败仅告警不连坐
function releaseRole(ctx) {
  try {
    const sweep = sweepLegacyReleases()
    if (sweep.removed > 0) ctx.logger?.info?.(`rs-workflow 旧版释放物自清理: 移除 ${sweep.removed} 个目录`)
  } catch (error) {
    ctx.logger?.warn?.(`rs-workflow 旧版释放物清理失败: ${error?.message ?? error}`)
  }
  try {
    const entry = builtinTemplates().find((t) => t.id === 'default')
    if (entry) ensureMainReleased(entry)
  } catch (error) {
    ctx.logger?.warn?.(`rs-workflow 出厂模式释放失败: ${error?.message ?? error}`)
  }
}

export function registerTemplateTool(ctx) {
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => tctx.tools.register(createTemplateTool({
      getTemplates: () => readSettingTemplates(ctx),
      setTemplates: async (templates) => {
        const settings = ctx.get('settings')
        if (!settings) throw new Error('设置服务不可用,无法保存模板')
        await settings.update(NAMESPACE, { templates })
      },
      removeTemplate: async (id) => removeTemplateShared(ctx, id),
      releaseTemplate: async (entry) => releaseFlowTemplateFor(entry) !== 'foreign',
      unreleaseTemplate: async (id) => unreleaseFlowTemplate(id),
      logger: ctx.logger,
    })), 'rs-workflow template tool')
  })
}

function readSettingTemplates(ctx) {
  try {
    const settings = ctx.get('settings')
    const value = settings ? settings.get(NAMESPACE) : undefined
    return value && Array.isArray(value.templates) ? value.templates : []
  } catch {
    return []
  }
}

// 共享删除语义:用户项直接删;内置项落 enabled:false 用户记录防合并复活;撤下释放物
async function removeTemplateShared(ctx, id) {
  const raw = readSettingTemplates(ctx)
  const next = raw.filter((t) => t.id !== id)
  const builtin = builtinTemplates().find((t) => t.id === id)
  if (builtin) {
    next.push({ ...builtin, enabled: false })
  } else if (next.length === raw.length) {
    return { ok: false, error: '模板不存在: ' + id }
  }
  const settings = ctx.get('settings')
  if (!settings) throw new Error('设置服务不可用,无法保存模板')
  await settings.update(NAMESPACE, { templates: next })
  const outcome = unreleaseFlowTemplate(id)
  return { ok: true, templates: next, outcome }
}

function releaseFlowTemplateFor(entry) {
  try {
    return releaseFlowTemplate(entry)
  } catch (error) {
    return 'foreign:' + String(error?.message ?? error)
  }
}
