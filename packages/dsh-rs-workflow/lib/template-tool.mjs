/**
 * template-tool — rs_workflow_template 模型工具:AI 友好的流程模板编辑入口。
 *
 * 用户一般不手写工作流:AI 在任意会话按用户口述逻辑产模板。工具即编辑规则载体:
 *   - action "spec":返回 DSL 规范全文(字段表 + 语义 + 完整示例),AI 据此写 JSON5;
 *   - action "list":列出设置中全部模板(id/label/描述/启用态);
 *   - action "save":校验 → 写入设置 templates 数组(幂等按 id 替换);
 *     release=true 时同步释放为模式(选择器立即可选);
 *   - action "remove":从设置移除模板并撤下已释放模式。
 *
 * 工具不直接落盘 preset:preset 释放统一走 preset-sync(单一释放权威)。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import JSON5 from "json5";
import { validateFlowSet } from "./flows.mjs";
import { SPEC_TEXT } from "./spec.mjs";

const ACTIONS = ["spec", "list", "save", "remove"];

/** 模板设置数组归一:防御性收敛(漏字段/错型不炸设置面) */
function normalizeTemplates(value) {
	if (!Array.isArray(value)) return [];
	return value
		.filter((t) => t && typeof t === "object")
		.map((t) => ({
			id: typeof t.id === "string" ? t.id : "",
			label: typeof t.label === "string" ? t.label : "",
			description: typeof t.description === "string" ? t.description : "",
			enabled: t.enabled !== false,
			json5: typeof t.json5 === "string" ? t.json5 : "",
		}))
		.filter((t) => t.id !== "");
}

export function createTemplateTool({ getTemplates, setTemplates, releaseTemplate, unreleaseTemplate, logger }) {
	return defineTool({
		name: "rs_workflow_template",
		description: [
			"若水工作流流程模板的 AI 编辑入口:用户口述流程逻辑,你据此生成/修改流程模板(JSON5)。",
			"先调 {action:\"spec\"} 获取模板 DSL 规范与完整示例,再按规范写模板并 {action:\"save\", template:{...}, release:true} 保存并释放为可选模式。",
			"list 列出现有模板;remove 按 id 移除模板并撤下其模式。",
			"模板是强流程定义:每步声明 AI 必须产出什么(<output> 契约),引擎强制校验后推进,禁止把'希望模型怎么做'写成口头约定。",
		].join(""),
		parameters: {
			action: { type: "string", required: true, enum: ACTIONS, description: "spec=获取 DSL 规范;list=列模板;save=保存模板(可同时释放);remove=移除模板" },
			template: {
				type: "object",
				additionalProperties: true,
				description: "save:模板对象 {id,label,description,enabled,json5};json5 为流程定义 JSON5 文本(先调 spec 按规范写)",
			},
			id: { type: "string", description: "remove:要移除的模板 id" },
			release: { type: "boolean", description: "save:true=保存后立即释放为可选模式(rs-<id>)" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					action: { type: "string" },
					spec: { type: "string" },
					templates: { type: "array", items: { type: "object", additionalProperties: true } },
					released: { type: "boolean" },
					presetId: { type: "string" },
					errors: { type: "array", items: { type: "string" } },
					error: { type: "string" },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: value.spec !== undefined
					? value.spec
					: JSON.stringify(value, null, 2),
			}],
		},
		async execute(args) {
			const action = args.action;
			if (action === "spec") {
				return { ok: true, action, spec: SPEC_TEXT };
			}
			if (action === "list") {
				const templates = normalizeTemplates(await getTemplates());
				return { ok: true, action, templates };
			}
			if (action === "save") {
				const t = args.template && typeof args.template === "object" ? args.template : null;
				if (!t) return { ok: false, action, error: "缺少 template 对象 {id,label,description,json5}" };
				const id = typeof t.id === "string" ? t.id.trim() : "";
				const json5 = typeof t.json5 === "string" ? t.json5 : "";
				if (id === "" || json5.trim() === "") return { ok: false, action, error: "template.id 与 template.json5 均为必填" };
				// 校验:先解析单模板,再与现有模板并集做跨流程校验(动态路由目标存在性)
				let parsed;
				try {
					parsed = JSON5.parse(json5);
				} catch (error) {
					return { ok: false, action, errors: ["JSON5 解析失败: " + String(error?.message ?? error)] };
				}
				if (parsed && typeof parsed.id === "string" && parsed.id !== id) {
					return { ok: false, action, errors: [`template.id("${id}") 与流程定义内 id("${parsed.id}") 不一致`] };
				}
				const others = normalizeTemplates(await getTemplates()).filter((item) => item.id !== id);
				const otherFlows = [];
				for (const item of others) {
					try {
						otherFlows.push(JSON5.parse(item.json5));
					} catch { /* 既有模板损坏不阻塞新模板保存 */ }
				}
				const errors = validateFlowSet([parsed, ...otherFlows].filter(Boolean));
				if (errors.length > 0) return { ok: false, action, errors };
				const entry = {
					id,
					label: typeof t.label === "string" && t.label.trim() !== "" ? t.label.trim() : (parsed && parsed.label) || id,
					description: typeof t.description === "string" && t.description.trim() !== "" ? t.description.trim() : (parsed && parsed.description) || "",
					enabled: t.enabled !== false,
					json5,
				};
				await setTemplates([...others, entry]);
				let released = false;
				let presetId = "";
				if (args.release === true) {
					const outcome = await releaseTemplate(entry);
					released = outcome === true;
					presetId = "rs-" + id;
				}
				logger?.info?.(`rs-workflow 模板已保存: ${id}${released ? `(已释放为模式 ${presetId})` : ""}`);
				return { ok: true, action, released, presetId, templates: normalizeTemplates([...others, entry]) };
			}
			if (action === "remove") {
				const id = typeof args.id === "string" ? args.id.trim() : "";
				if (id === "") return { ok: false, action, error: "缺少 id" };
				const templates = normalizeTemplates(await getTemplates());
				const next = templates.filter((item) => item.id !== id);
				if (next.length === templates.length) return { ok: false, action, error: "模板不存在: " + id };
				await setTemplates(next);
				await unreleaseTemplate(id);
				return { ok: true, action, presetId: "rs-" + id, templates: next };
			}
			return { ok: false, action, error: "未知 action: " + action };
		},
		presentCall: () => ({ card: "generic", title: "编辑若水工作流模板", kind: "other", rawInput: {} }),
	});
}
