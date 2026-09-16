// template-tool — rs_workflow_template 模型工具:AI 按用户口述逻辑生成/修改流程模板
// 激活于已创建组合行(template-tool 行);落盘走自有文件存储与 release 模块,不直接触碰预设目录(v5)
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseTemplate, validateTemplate, validateTemplateSet } from './template.mjs'
import { SPEC_TEXT } from './spec.mjs'
import { loadJson, saveJson } from './storage.mjs'
import { releaseFlowTemplate, unreleaseFlowTemplate } from './release.mjs'

const ACTIONS = ['spec', 'list', 'save', 'remove']

function normalizeTemplates(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      id: typeof t.id === 'string' ? t.id : '',
      label: typeof t.label === 'string' ? t.label : '',
      description: typeof t.description === 'string' ? t.description : '',
      enabled: t.enabled !== false,
      json: typeof t.json === 'string' ? t.json : '',
    }))
    .filter((t) => t.id !== '')
}

export function createTemplateTool({ getTemplates, setTemplates, removeTemplate, releaseTemplate, unreleaseTemplate, logger }) {
  return defineTool({
    name: 'rs_workflow_template',
    description: [
      '若水工作流流程模板的 AI 编辑入口:用户口述流程逻辑,你据此生成/修改流程模板(严格 JSON)。',
      '先调 {action:"spec"} 获取 DSL v5 规范与示例,再 {action:"save", template:{...}, release:true} 保存并创建为可选模式。',
      'list 列出现有模板;remove 按 id 移除并撤下其模式。',
      '每步以 outputs 声明结构化产出契约(子代理以结构化工具提交,引擎强制校验);人工审校用 type:"approve" 原语;',
      '流程入参用 inputs;禁止把「希望模型怎么做」写成口头约定。',
    ].join(''),
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS, description: 'spec=获取 DSL 规范;list=列模板;save=保存模板(可同时创建);remove=移除模板' },
      template: {
        type: 'object',
        additionalProperties: true,
        description: 'save:模板对象 {id,label,description,enabled,json};json 为流程定义严格 JSON 文本(先调 spec 按规范写)',
      },
      id: { type: 'string', description: 'remove:要移除的模板 id' },
      release: { type: 'boolean', description: 'save:true=保存后立即创建为可选模式(rs-<id>)' },
      dryRun: { type: 'boolean', description: 'save:true=仅校验不落盘(编辑器「校验」同源通道)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string' },
          spec: { type: 'string' },
          templates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          released: { type: 'boolean' },
          presetId: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.spec !== undefined ? value.spec : JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      const action = args.action
      if (action === 'spec') {
        return { ok: true, action, spec: SPEC_TEXT }
      }
      if (action === 'list') {
        const templates = normalizeTemplates(await getTemplates())
        return { ok: true, action, templates }
      }
      if (action === 'save') {
        const t = args.template && typeof args.template === 'object' ? args.template : null
        if (!t) return { ok: false, action, error: '缺少 template 对象 {id,label,description,json}' }
        const id = typeof t.id === 'string' ? t.id.trim() : ''
        const json = typeof t.json === 'string' ? t.json : ''
        if (id === '' || json.trim() === '') return { ok: false, action, error: 'template.id 与 template.json 均为必填' }
        let parsed
        try {
          parsed = parseTemplate(json)
        } catch (error) {
          return { ok: false, action, errors: ['JSON 解析失败: ' + String(error?.message ?? error)] }
        }
        if (parsed && typeof parsed.id === 'string' && parsed.id !== id) {
          return { ok: false, action, errors: [`template.id("${id}") 与流程定义内 id("${parsed.id}") 不一致`] }
        }
        // 单模板校验 + 与既有模板并集跨流程校验(动态路由目标存在性;损坏既有模板跳过)
        const single = validateTemplate(parsed)
        if (single.length > 0) return { ok: false, action, errors: single.map((e) => `${e.target}: ${e.message}`) }
        const others = normalizeTemplates(await getTemplates()).filter((item) => item.id !== id)
        const otherFlows = []
        for (const item of others) {
          try {
            otherFlows.push(parseTemplate(item.json))
          } catch { /* 既有模板损坏不阻塞新模板保存 */ }
        }
        const cross = validateTemplateSet([parsed, ...otherFlows].filter(Boolean))
        if (cross.length > 0) return { ok: false, action, errors: cross.map((e) => `${e.target}: ${e.message}`) }
        const entry = {
          id,
          label: typeof t.label === 'string' && t.label.trim() !== '' ? t.label.trim() : (parsed && parsed.label) || id,
          description: typeof t.description === 'string' && t.description.trim() !== '' ? t.description.trim() : (parsed && parsed.description) || '',
          enabled: t.enabled !== false,
          json,
        }
        if (args.dryRun === true) {
          return { ok: true, action, templates: normalizeTemplates([...others, entry]) }
        }
        await setTemplates([...others, entry])
        let released = false
        let presetId = ''
        if (args.release === true) {
          released = (await releaseTemplate(entry)) === true
          presetId = 'rs-' + id
        }
        logger?.info?.(`rs-workflow 模板已保存: ${id}${released ? `(已创建为模式 ${presetId})` : ''}`)
        return { ok: true, action, released, presetId, templates: normalizeTemplates([...others, entry]) }
      }
      if (action === 'remove') {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id === '') return { ok: false, action, error: '缺少 id' }
        const outcome = await removeTemplate(id)
        if (!outcome.ok) return { ok: false, action, error: outcome.error }
        return { ok: true, action, presetId: 'rs-' + id, templates: outcome.templates }
      }
      return { ok: false, action, error: '未知 action: ' + action }
    },
    presentCall: () => ({ card: 'generic', title: '编辑若水工作流模板', kind: 'other', rawInput: {} }),
  })
}

// 模式行激活入口:自有文件存储读写 + release 落盘(ctx = agent realm 组合行上下文)
export function registerTemplateTool(ctx) {
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => tctx.tools.register(createTemplateTool({
      getTemplates: () => loadJson('templates.json', []),
      setTemplates: (templates) => saveJson('templates.json', templates),
      removeTemplate: (id) => {
        const raw = loadJson('templates.json', [])
        const next = raw.filter((t) => t.id !== id)
        if (next.length === raw.length) return { ok: false, error: '模板不存在: ' + id }
        saveJson('templates.json', next)
        const outcome = unreleaseFlowTemplate(id)
        return { ok: true, templates: next, outcome }
      },
      releaseTemplate: (entry) => {
        try {
          return releaseFlowTemplate(entry) !== 'foreign'
        } catch (error) {
          ctx.logger?.warn?.(`rs-workflow 模板释放失败: ${error?.message ?? error}`)
          return false
        }
      },
      unreleaseTemplate: (id) => unreleaseFlowTemplate(id),
      logger: ctx.logger,
    })), 'rs-workflow template tool')
  })
}
