/**
 * 流程模板 DSL 解析与严格校验(纯逻辑,无宿主依赖)。
 *
 * 模板形态(JSON5):
 * {
 *   id: "novel",            // ^[a-z][a-z0-9-]*$;释放模式 id = rs-<id>
 *   label: "小说写作",       // 模式显示名
 *   description: "...",     // 适用场景(分诊目录与模式描述)
 *   steps: [
 *     {
 *       id: "outline",      // 流程内唯一,^[a-zA-Z][a-zA-Z0-9_-]*$
 *       label: "生成大纲",   // 可选,看板显示
 *       slot: "planner",    // 可选,工作位键(默认 executor,集合同 16 工作位)
 *       prompt: "...",      // 指令模板:{request} {item} {item.index} {input.x} {stepId.outputName}
 *       load: ["skill:x", "doc:./x.md"], // 可选,强制加载资源
 *       outputs: { name: "产出说明" },    // 可选,产出契约(<output name> 块)
 *       listOutputs: ["name"],           // 可选,按列表解析的产出(for_each 数据源)
 *       after: ["a","b"],   // 可选,缺省依赖文档序前一步;显式声明即并行 DAG
 *       maxFail: 3,         // 可选,步骤失败重试上限(缺省取预算 reviewRejectBeforeEscalate)
 *       for_each: "outline.items", // 可选,循环:按 list 产出逐项实例化本步
 *       mode: "sequential", // 循环推进:sequential(默认,实例链式,上一实例产出可见)| parallel
 *       type: "ai",         // ai(默认)| flow(嵌套子流程)
 *       flow: "{triage.route}", // type=flow 必填;支持 {step.output} 动态路由
 *       input: { brief: "{triage.brief}" }, // type=flow 可选,子流程以 {input.brief} 引用
 *     },
 *   ],
 * }
 *
 * 校验为强流程第一环:未知字段、拼写错误、非法引用一律拒绝,不静默降级。
 */
import JSON5 from "json5";

/** 工作位键集合(与 lib/index.js SLOT_KEYS 互为镜像,tests/workflow-parity.test.mjs 对拍) */
export const SLOT_KEYS = [
	"planner", "executor", "reviewer",
	"planner-triage", "planner-command", "planner-subplan", "planner-escalate",
	"reviewer-plan", "reviewer-task", "reviewer-subplan", "reviewer-final", "reviewer-cross",
	"executor-task", "executor-enhance", "executor-retry", "executor-escalate",
];

/** 步骤 id 字符集(占位符引用与实例后缀拼接的前提) */
const STEP_ID_TEST = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const FLOW_ID_TEST = /^[a-z][a-z0-9-]*$/;
/** 嵌套深度上限(含首层);循环嵌套在此封顶 */
export const MAX_FLOW_DEPTH = 3;
/** load 资源 scheme 白名单 */
export const LOAD_SCHEMES = ["skill", "doc"];

const FLOW_FIELDS = ["id", "label", "description", "steps"];
const STEP_FIELDS = [
	"id", "label", "slot", "prompt", "load", "outputs", "listOutputs",
	"after", "maxFail", "for_each", "mode", "type", "flow", "input",
];

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFields(obj, allowed, where, errors) {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) errors.push(`${where}: 未知字段 "${key}"(字段拼写错误会被拒绝,防静默失效)`);
	}
}

/** 占位符引用解析:{a.b.c} → ["a","b","c"];非字符串或无占位符返回 [] */
export function placeholders(text) {
	if (typeof text !== "string") return [];
	const out = [];
	for (const m of text.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)) out.push(m[1]);
	return out;
}

/**
 * 校验流程定义。返回错误信息列表,空数组 = 合法。
 * 只做单流程结构校验(引用/依赖/循环/资源形态);跨流程校验
 * (子流程目标存在、循环引用)由 validateFlowSet 承担。
 */
export function validateFlow(flow) {
	const errors = [];
	if (!isPlainObject(flow)) return ["流程定义必须是对象"];
	unknownFields(flow, FLOW_FIELDS, "流程", errors);
	if (typeof flow.id !== "string" || !FLOW_ID_TEST.test(flow.id)) {
		errors.push(`id 非法: ${JSON.stringify(flow.id)}(须匹配 ^[a-z][a-z0-9-]*$)`);
	}
	if (typeof flow.label !== "string" || flow.label.trim() === "") errors.push("label 不能为空");
	if (typeof flow.description !== "string" || flow.description.trim() === "") errors.push("description 不能为空");
	if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
		errors.push("steps 不能为空数组");
		return errors;
	}

	const byId = new Map();
	for (const step of flow.steps) {
		if (!isPlainObject(step)) {
			errors.push("步骤必须是对象");
			continue;
		}
		if (typeof step.id !== "string" || !STEP_ID_TEST.test(step.id)) {
			errors.push(`步骤 id 非法: ${JSON.stringify(step.id)}(须匹配 ^[a-zA-Z][a-zA-Z0-9_-]*$)`);
			continue;
		}
		if (byId.has(step.id)) {
			errors.push(`步骤 id 重复: ${step.id}`);
			continue;
		}
		byId.set(step.id, step);
	}
	if (byId.size !== flow.steps.length) return errors;

	for (const step of flow.steps) {
		const where = `步骤 ${step.id}`;
		unknownFields(step, STEP_FIELDS, where, errors);
		if (step.label !== undefined && (typeof step.label !== "string" || step.label.trim() === "")) {
			errors.push(`${where}: label 须为非空字符串`);
		}
		if (step.slot !== undefined && !SLOT_KEYS.includes(step.slot)) {
			errors.push(`${where}: slot "${step.slot}" 不在工作位集合中(合法值: ${SLOT_KEYS.join("/")})`);
		}
		if (typeof step.prompt !== "string" || step.prompt.trim() === "") errors.push(`${where}: prompt 不能为空`);
		// load: scheme:path 形态白名单
		if (step.load !== undefined) {
			if (!Array.isArray(step.load)) {
				errors.push(`${where}: load 须为字符串数组`);
			} else {
				for (const ref of step.load) {
					const idx = typeof ref === "string" ? ref.indexOf(":") : -1;
					const scheme = idx > 0 ? ref.slice(0, idx) : "";
					if (!LOAD_SCHEMES.includes(scheme)) {
						errors.push(`${where}: load 条目 "${ref}" 须为 ${LOAD_SCHEMES.map((s) => s + ":").join("|")}<引用> 形态`);
					}
				}
			}
		}
		// outputs: 名称 → 说明
		let listSet = new Set();
		if (step.outputs !== undefined) {
			if (!isPlainObject(step.outputs) || Object.keys(step.outputs).length === 0) {
				errors.push(`${where}: outputs 须为非空对象(产出名 → 产出说明)`);
			} else {
				for (const [name, desc] of Object.entries(step.outputs)) {
					if (!STEP_ID_TEST.test(name)) errors.push(`${where}: 产出名 "${name}" 须匹配 ^[a-zA-Z][a-zA-Z0-9_-]*$`);
					if (typeof desc !== "string" || desc.trim() === "") errors.push(`${where}: 产出 "${name}" 的说明不能为空`);
				}
			}
		}
		if (step.listOutputs !== undefined) {
			if (!Array.isArray(step.listOutputs) || step.listOutputs.length === 0) {
				errors.push(`${where}: listOutputs 须为非空字符串数组`);
			} else {
				for (const name of step.listOutputs) {
					if (typeof name !== "string" || !STEP_ID_TEST.test(name)) errors.push(`${where}: listOutputs 条目非法: ${JSON.stringify(name)}`);
					else listSet.add(name);
				}
				if (step.outputs === undefined || !Object.keys(step.outputs).length) {
					errors.push(`${where}: listOutputs 声明的产出必须同时出现在 outputs 契约中`);
				} else {
					for (const name of listSet) {
						if (!(name in step.outputs)) errors.push(`${where}: listOutputs 的 "${name}" 未在 outputs 契约中声明`);
					}
				}
			}
		}
		// after: 引用存在 + 无环(全图统一拓扑检查,此处只查存在性)
		if (step.after !== undefined) {
			if (!Array.isArray(step.after) || step.after.length === 0) {
				errors.push(`${where}: after 须为非空字符串数组(清除依赖请删除该字段,缺省链式)`);
			} else {
				for (const ref of step.after) {
					if (typeof ref !== "string" || !byId.has(ref)) errors.push(`${where}: after 引用不存在: ${ref}`);
					else if (ref === step.id) errors.push(`${where}: after 自引用`);
				}
			}
		}
		if (step.maxFail !== undefined && (!Number.isInteger(step.maxFail) || step.maxFail < 1 || step.maxFail > 10)) {
			errors.push(`${where}: maxFail 须为 1..10 整数`);
		}
		// for_each: 必须指向本流程某步骤的 list 产出,且该步骤拓扑在前(逐项检查见下)
		if (step.for_each !== undefined) {
			if (typeof step.for_each !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9_-]*$/.test(step.for_each)) {
				errors.push(`${where}: for_each 须为 "<步骤id>.<产出名>" 形态`);
			}
			if (step.mode !== undefined && !["sequential", "parallel"].includes(step.mode)) {
				errors.push(`${where}: mode 只支持 sequential / parallel`);
			}
			if (step.type !== undefined && step.type !== "ai") {
				errors.push(`${where}: for_each 仅支持 type: "ai" 步骤`);
			}
		}
		// type=flow: flow 必填,input 值须为占位符引用
		const type = step.type === undefined ? "ai" : step.type;
		if (!["ai", "flow"].includes(type)) errors.push(`${where}: type 只支持 ai / flow`);
		if (type === "flow") {
			if (step.for_each !== undefined) errors.push(`${where}: 嵌套子流程步骤不支持 for_each`);
			if (typeof step.flow !== "string" || step.flow.trim() === "") errors.push(`${where}: type=flow 须声明 flow(子流程 id,支持 {step.output} 动态路由)`);
			if (step.input !== undefined) {
				if (!isPlainObject(step.input)) errors.push(`${where}: input 须为对象(子流程占位名 → 引用)`);
				else {
					for (const [k, v] of Object.entries(step.input)) {
						if (!STEP_ID_TEST.test(k)) errors.push(`${where}: input 键 "${k}" 非法`);
						const refs = placeholders(typeof v === "string" ? v : "");
						if (refs.length !== 1 || !v.startsWith("{") || !v.endsWith("}")) {
							errors.push(`${where}: input["${k}"] 须为单一占位符引用形态 "{来源}"`);
						}
					}
				}
			}
			if (step.outputs !== undefined) errors.push(`${where}: 嵌套子流程步骤的产出即子流程产出,不声明 outputs`);
		} else {
			if (step.flow !== undefined || step.input !== undefined) {
				errors.push(`${where}: flow/input 仅 type=flow 步骤可用`);
			}
		}
	}

	// 依赖环检测(Kahn)
	const indegree = new Map(flow.steps.map((s) => [s.id, 0]));
	for (const step of flow.steps) {
		for (const ref of step.after || []) {
			if (indegree.has(ref)) indegree.set(step.id, indegree.get(step.id) + 1);
		}
	}
	const queue = flow.steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
	const seen = new Set();
	while (queue.length) {
		const id = queue.shift();
		seen.add(id);
		for (const step of flow.steps) {
			if ((step.after || []).includes(id)) {
				indegree.set(step.id, indegree.get(step.id) - 1);
				if (indegree.get(step.id) === 0) queue.push(step.id);
			}
		}
	}
	for (const step of flow.steps) {
		if (!seen.has(step.id)) errors.push(`步骤 ${step.id} 位于依赖环中`);
	}

	// 拓扑序(for_each 前向校验与并行循环自引用校验的基础)
	const order = topoOrder(flow.steps);
	const rankOf = new Map(order.map((id, i) => [id, i]));
	for (const step of flow.steps) {
		if (step.for_each === undefined || typeof step.for_each !== "string") continue;
		const [srcId, outName] = step.for_each.split(".");
		const src = byId.get(srcId);
		if (!src) {
			errors.push(`步骤 ${step.id}: for_each 引用步骤不存在: ${srcId}`);
			continue;
		}
		if (!(rankOf.get(srcId) < rankOf.get(step.id))) {
			errors.push(`步骤 ${step.id}: for_each 数据源 ${srcId} 必须拓扑在前`);
			continue;
		}
		const lists = Array.isArray(src.listOutputs) ? src.listOutputs : [];
		if (!lists.includes(outName)) {
			errors.push(`步骤 ${step.id}: for_each 数据源 "${step.for_each}" 不是 ${srcId} 的 listOutputs 产出`);
		}
		if (step.mode === "parallel") {
			const selfRefs = placeholders(step.prompt || "").filter((ref) => ref === step.id || ref.startsWith(step.id + "."));
			if (selfRefs.length > 0) {
				errors.push(`步骤 ${step.id}: parallel 循环实例相互独立,prompt 不得引用自身产出(${selfRefs.join(", ")});需要串行衔接请用缺省 sequential`);
			}
		}
	}
	return errors;
}

/** 拓扑序(稳定:同层按文档序);含环时返回已排部分,调用方先跑 validateFlow */
export function topoOrder(steps) {
	const indegree = new Map(steps.map((s) => [s.id, 0]));
	for (const step of steps) {
		for (const ref of step.after || []) {
			if (indegree.has(ref)) indegree.set(step.id, indegree.get(step.id) + 1);
		}
	}
	const order = [];
	const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
	const emitted = new Set();
	while (queue.length) {
		const id = queue.shift();
		if (emitted.has(id)) continue;
		emitted.add(id);
		order.push(id);
		for (const step of steps) {
			if ((step.after || []).includes(id)) {
				indegree.set(step.id, indegree.get(step.id) - 1);
				if (indegree.get(step.id) === 0) queue.push(step.id);
			}
		}
	}
	return order;
}

/**
 * 跨流程校验:动态路由(flow 值含占位符)无法静态定位目标,只校验字面引用;
 * 全部流程 id 集合用于校验 input 引用不存在跨流程语义(占位符仅指本流程内来源)。
 */
export function validateFlowSet(flows) {
	const errors = [];
	const ids = new Set(flows.map((f) => f.id));
	for (const flow of flows) {
		for (const err of validateFlow(flow)) errors.push(`[${flow.id}] ${err}`);
		for (const step of flow.steps || []) {
			if (step.type !== "flow") continue;
			const refs = placeholders(step.flow || "");
			if (refs.length === 0 && typeof step.flow === "string" && !step.flow.startsWith("{")) {
				if (!ids.has(step.flow)) errors.push(`[${flow.id}] 步骤 ${step.id}: 子流程 "${step.flow}" 不在流程集中`);
			}
			const selfFlow = refs.length === 1 && step.flow === `{${step.id}}`;
			if (selfFlow) errors.push(`[${flow.id}] 步骤 ${step.id}: 子流程路由不得指向自身`);
		}
	}
	return errors;
}

/** 收集一个流程全部 load 引用(含嵌套子流程步骤的 load),去重保序 */
export function collectLoadRefs(flow) {
	const out = [];
	const seen = new Set();
	for (const step of flow.steps || []) {
		if (!Array.isArray(step.load)) continue;
		for (const ref of step.load) {
			if (!seen.has(ref)) {
				seen.add(ref);
				out.push(ref);
			}
		}
	}
	return out;
}

/** JSON5 解析流程模板文本;解析失败抛错(错误信息直接面向模板作者) */
export function parseFlowJson5(text) {
	const flow = JSON5.parse(text);
	const errors = validateFlow(flow);
	if (errors.length > 0) throw new Error("流程模板校验失败:\n- " + errors.join("\n- "));
	return flow;
}
