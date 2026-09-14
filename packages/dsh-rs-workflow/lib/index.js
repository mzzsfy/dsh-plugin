/**
 * dsh-rs-workflow — 若水工作流:通用强流程工作流编排工具。
 *
 * 一个包,多种行角色(由组合行 config.role 决定,加载前经 Config 校验):
 *   - "settings":注册 settings 命名空间 "rs-workflow"(host 层,profile patch 行)。
 *     16 工作位模型绑定 + collab 工作流默认项 + 预算 + 流程模板数组(templates)。
 *   - "preset-sync":启动时幂等释放 collab 内置模式到用户预设根(host 层)。
 *   - "board":注册 /api/rs-workflow/* 读路 + 模板管理/释放写路(host 层)。
 *   - "template-tool":注册 rs_workflow_template 模型工具(AI 编辑入口,预设层)。
 *   - "report":注册 rs_workflow_report 模型工具(运行上报,预设层)。
 *   - "takeover":pre-step 引擎接管 + workflowEngine 编程启动(预设层,delegation 组内)。
 *
 * 强流程语义:模式内用户消息被 pre-step 拦截(主模型零参与),编排由插件自带脚本
 * (engine/flow.js 通用解释器 | engine/collab.js 协作模板)驱动,每步产出契约强制校验。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import JSON5 from "json5";
import { presetDest, removePreset, syncPreset, releaseFlowTemplate, unreleaseFlowTemplate, flowPresetDest } from "./preset-sync.mjs";
import { reportStore } from "./report-store.mjs";
import { registerTakeover } from "./takeover.mjs";
import { createTemplateTool } from "./template-tool.mjs";
import { validateFlow } from "./flows.mjs";
import { SPEC_TEXT } from "./spec.mjs";

const name = "rs-workflow";
const NAMESPACE = "rs-workflow";
const TEMPLATES = ["auto", "lite", "plan-final", "step-review", "multi-plan"];

// tool 输出 schema 的工作位键集,与 buildSlots 互为镜像(非派生):
// tests/workflow-parity.test.mjs 对拍钉住,增删工作位须双侧同步
const SLOT_KEYS = [
	"planner", "executor", "reviewer",
	"planner-triage", "planner-command", "planner-subplan", "planner-escalate",
	"reviewer-plan", "reviewer-task", "reviewer-subplan", "reviewer-final", "reviewer-cross",
	"executor-task", "executor-enhance", "executor-retry", "executor-escalate",
];

// 预算字段与默认值对齐 rs-tui budgets(config.ts:290-299),clamp 边界同引擎 BUDGET_MIN/MAX
const BUDGET_DEFAULTS = {
	reviewRejectBeforeEscalate: 2,
	planRejectBeforeBlocked: 2,
	emptyOutputRetryLimit: 3,
	reportNudgeLimit: 3,
};
const BUDGET_MIN = 1;
const BUDGET_MAX = 10;
const MAX_TASKS_MIN = 1;
const MAX_TASKS_MAX = 64;
const MAX_TASKS_DEFAULT = 8;

/** 预算数值子 schema;clamp 在引擎侧执行,schema 只声明合法域。 */
function buildBudgets() {
	const budget = (def, description) => z.number().default(def).min(BUDGET_MIN).max(BUDGET_MAX).description(description);
	return z.object({
		reviewRejectBeforeEscalate: budget(BUDGET_DEFAULTS.reviewRejectBeforeEscalate, "步骤/审批对象连续被拒或失败达此值触发升级(流程步为失败重试上限)"),
		planRejectBeforeBlocked: budget(BUDGET_DEFAULTS.planRejectBeforeBlocked, "计划/子计划连续被拒达此值触发升级重规划(collab)"),
		emptyOutputRetryLimit: budget(BUDGET_DEFAULTS.emptyOutputRetryLimit, "产出块/裁决块缺失时的教学重问上限,超限折算失败"),
		reportNudgeLimit: budget(BUDGET_DEFAULTS.reportNudgeLimit, "执行完成但未给出交接摘要时追问上限(collab)"),
	});
}

/** 工作位(slot)子 schema;细分位场景文案对齐 rs-tui SLOT_SCENES。string/array/{rotation} 三态。 */
function buildSlots() {
	const slot = (description) => z.union([z.string(), z.array(z.string()), z.object({ rotation: z.array(z.string()) })]).default("").description(description);
	return z.object({
		planner: slot("planner 基础位(规划域兜底)。格式 provider/model、候选数组或 {rotation:[...]},留空 = 会话默认模型"),
		executor: slot("executor 基础位(执行域兜底);候选依次轮换,失败重试换模型"),
		reviewer: slot("reviewer 基础位(审批域兜底);候选依次轮换"),
		"planner-triage": slot("细分位:分诊(需求分析/模板选择/流程路由);缺省降级 planner"),
		"planner-command": slot("细分位:总规划与计划重写(collab);缺省降级 planner"),
		"planner-subplan": slot("细分位:子计划细化(collab);缺省降级 planner"),
		"planner-escalate": slot("细分位:升级重规划(collab);缺省降级 planner"),
		"reviewer-plan": slot("细分位:计划审批(collab);缺省降级 reviewer"),
		"reviewer-task": slot("细分位:任务审批(collab/流程步骤审);缺省降级 reviewer"),
		"reviewer-subplan": slot("细分位:子计划审批(collab);缺省降级 reviewer"),
		"reviewer-final": slot("细分位:终审(collab/流程末审);缺省降级 reviewer"),
		"reviewer-cross": slot("细分位:交叉终审(collab multi-plan);缺省降级 reviewer"),
		"executor-task": slot("细分位:常规执行步;缺省降级 executor"),
		"executor-enhance": slot("细分位:被拒返工步;缺省降级 executor"),
		"executor-retry": slot("细分位:失败重试步;缺省降级 executor"),
		"executor-escalate": slot("细分位:升级重做步;缺省降级 executor"),
	});
}

function buildWorkflow() {
	return z.object({
		defaultTemplate: z.union(TEMPLATES).default("auto").description("collab 无信号兜底模板(auto=multi-plan)"),
		maxTasks: z.number().default(MAX_TASKS_DEFAULT).min(MAX_TASKS_MIN).max(MAX_TASKS_MAX).description("collab 全局任务预算"),
	});
}

/** 流程模板数组子 schema:GUI/工具共同读写;释放动作在看板按钮或工具 release 参数。 */
function buildTemplates() {
	const item = () => z.object({
		id: z.string().required().description("流程 id(^[a-z][a-z0-9-]*$);释放模式 = rs-<id>"),
		label: z.string().default("").description("显示名"),
		description: z.string().default("").description("适用场景(分诊目录展示)"),
		enabled: z.boolean().default(true).description("禁用后不再释放/分诊不可见"),
		json5: z.string().default("").description("流程定义 JSON5 全文(规范见 rs_workflow_template 工具 spec)"),
	});
	return z.array(item()).default([]).description("流程模板集:每项可经看板「释放为模式」或工具 save(release:true) 释放为独立模式");
}

/** 设置 schema(GUI 表单)。模板数组在 GUI 为高级字段,日常经工具/看板编辑。 */
const SETTINGS_SCHEMA = z.object({
	slots: buildSlots(),
	workflow: buildWorkflow(),
	budgets: buildBudgets(),
	templates: buildTemplates(),
});

/** 组合行 config schema(在 settings 之上多一个行角色字段)。 */
const Config = z.object({
	role: z.union(["settings", "preset-sync", "board", "template-tool", "report", "takeover"]).required(),
	slots: buildSlots(),
	workflow: buildWorkflow(),
	budgets: buildBudgets(),
	templates: buildTemplates(),
	kind: z.string().description("takeover:collab | flow"),
	flowFile: z.string().description("takeover(kind=flow):flow.json5 绝对路径(组合 baseUrl 锚定)"),
});

/** 从(已解析的)行 config 里摘出 settings base 层。 */
function baseOf(config) {
	return { slots: config.slots, workflow: config.workflow, budgets: config.budgets, templates: config.templates };
}

// ── 看板 web 路由(host 层 board 角色) ────────────────────────────────────────
// 读路由放行 GET(无 CSRF 面);写路由 POST 加跨源与 JSON 守卫(dsh-usage-panel 同构)。
// 路由只做薄分发,数据权威态在 report-store 单例与 settings 命名空间。

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

function rejectCrossOrigin(req, res) {
	const origin = req.headers ? req.headers.origin : undefined;
	if (!origin) return false;
	let sameOrigin = false;
	try {
		sameOrigin = new URL(origin).host === req.headers.host;
	} catch {
		sameOrigin = false;
	}
	if (sameOrigin) return false;
	sendJson(res, 403, { error: "跨源请求被拒绝" });
	return true;
}

function rejectNonJson(req, res) {
	const contentType = req.headers ? String(req.headers["content-type"] || "") : "";
	if (contentType.indexOf("application/json") >= 0) return false;
	sendJson(res, 400, { error: "content-type 须为 application/json" });
	return true;
}

const guardedRoute = (handler) => async (req, res) => {
	try {
		if (req.method !== "GET" && req.method !== "POST") {
			sendJson(res, 405, { error: "method not allowed" });
			return;
		}
		if (req.method === "POST") {
			if (rejectCrossOrigin(req, res)) return;
			if (rejectNonJson(req, res)) return;
		}
		await handler(req, res);
	} catch (error) {
		sendJson(res, 400, { error: error && error.message ? error.message : String(error) });
	}
};

// POST-only 变体供无读面的写路由使用:GET 放行会让跨站 <img src> 无守卫驱动改写
guardedRoute.post = (handler) => async (req, res) => {
	if (req.method !== "POST") {
		sendJson(res, 405, { error: "method not allowed" });
		return;
	}
	return guardedRoute(handler)(req, res);
};

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_MAX_BYTES) {
				reject(new Error("请求体超过上限"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

const BODY_MAX_BYTES = 256 * 1024;

function registerBoardRoutes(ctx) {
	const store = reportStore();
	// webServer 以嵌套 inject 声明:服务缺失时仅 board 角色保持未激活(干净禁用),
	// 其余行角色不被模块级 inject 连坐(多角色包的模块级声明会整树 fatal)
	ctx.inject(["webServer"], (wctx) => {
		const route = (path, handler, name) =>
			wctx.effect(() => wctx.webServer.register({ kind: "exact", path, handler }), name);
		route("/api/rs-workflow/runs", guardedRoute(async (req, res) => {
			sendJson(res, 200, { runs: await store.list() });
		}), "rs-workflow runs route");
		route("/api/rs-workflow/run", guardedRoute(async (req, res) => {
			const url = new URL(req.url, "http://localhost");
			const runId = url.searchParams.get("id") || "";
			const run = await store.get(runId);
			if (!run) throw new Error("运行记录不存在:" + runId);
			sendJson(res, 200, run);
		}), "rs-workflow run detail route");
		route("/api/rs-workflow/remove", guardedRoute.post(async (req, res) => {
			const body = JSON.parse(await readJsonBody(req));
			const runId = body && typeof body.runId === "string" ? body.runId : "";
			await store.remove(runId);
			sendJson(res, 200, { ok: true });
		}), "rs-workflow remove route");
		// 模板管理:列表/规范(读) + 释放/撤下/保存/删除(写)
		route("/api/rs-workflow/templates", guardedRoute(async (req, res) => {
			sendJson(res, 200, { templates: readTemplates(ctx) });
		}), "rs-workflow templates route");
		route("/api/rs-workflow/spec", guardedRoute(async (req, res) => {
			sendJson(res, 200, { spec: SPEC_TEXT });
		}), "rs-workflow spec route");
		route("/api/rs-workflow/release", guardedRoute.post(async (req, res) => {
			const body = JSON.parse(await readJsonBody(req));
			const id = body && typeof body.id === "string" ? body.id.trim() : "";
			const entry = readTemplates(ctx).find((t) => t.id === id);
			if (!entry) throw new Error("模板不存在: " + id);
			if (entry.enabled === false) throw new Error("模板已禁用,先在设置中启用: " + id);
			const outcome = releaseFlowTemplate(entry);
			sendJson(res, 200, { ok: true, outcome, presetId: "rs-" + id });
		}), "rs-workflow release route");
		route("/api/rs-workflow/unrelease", guardedRoute.post(async (req, res) => {
			const body = JSON.parse(await readJsonBody(req));
			const id = body && typeof body.id === "string" ? body.id.trim() : "";
			const outcome = unreleaseFlowTemplate(id);
			sendJson(res, 200, { ok: true, outcome });
		}), "rs-workflow unrelease route");
		route("/api/rs-workflow/template-save", guardedRoute.post(async (req, res) => {
			const body = JSON.parse(await readJsonBody(req));
			const id = body && typeof body.id === "string" ? body.id.trim() : "";
			const json5 = body && typeof body.json5 === "string" ? body.json5 : "";
			const parsed = JSON5.parse(json5);
			const errors = validateFlow(parsed);
			if (errors.length > 0) throw new Error("流程模板校验失败:\n- " + errors.join("\n- "));
			if (parsed && typeof parsed.id === "string" && parsed.id !== id) throw new Error(`id 不一致: 模板 "${id}" vs 定义 "${parsed.id}"`);
			const templates = readTemplates(ctx).filter((t) => t.id !== id);
			templates.push({
				id,
				label: typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : parsed.label || id,
				description: typeof body.description === "string" && body.description.trim() !== "" ? body.description.trim() : parsed.description || "",
				enabled: body.enabled !== false,
				json5,
			});
			await writeTemplates(ctx, templates);
			sendJson(res, 200, { ok: true, templates });
		}), "rs-workflow template save route");
		route("/api/rs-workflow/template-remove", guardedRoute.post(async (req, res) => {
			const body = JSON.parse(await readJsonBody(req));
			const id = body && typeof body.id === "string" ? body.id.trim() : "";
			const templates = readTemplates(ctx);
			const next = templates.filter((t) => t.id !== id);
			if (next.length === templates.length) throw new Error("模板不存在: " + id);
			await writeTemplates(ctx, next);
			unreleaseFlowTemplate(id);
			sendJson(res, 200, { ok: true, templates: next });
		}), "rs-workflow template remove route");
	});
}

function readTemplates(ctx) {
	try {
		const settings = ctx.get("settings");
		const value = settings ? settings.get(NAMESPACE) : undefined;
		if (value && Array.isArray(value.templates)) return value.templates;
	} catch { /* 设置服务缺失/损坏:空表 */ }
	return [];
}

async function writeTemplates(ctx, templates) {
	const settings = ctx.get("settings");
	if (!settings) throw new Error("设置服务不可用,无法保存模板");
	await settings.update(NAMESPACE, { templates });
}

// ── 运行上报工具(预设层 report 角色) ────────────────────────────────────────
// 权威落定 = takeover 行(编排 start/finish);本工具是子代理节点级软上报通道(可选)。

const REPORT_ACTIONS = ["node", "list", "get"];

async function resolveWorkspace(tctx, exec) {
	const sessionId = exec && exec.agent ? String(exec.agent.id || "") : "";
	try {
		const sessionQuery = tctx.get("sessionQuery");
		if (sessionId && sessionQuery && typeof sessionQuery.listSessions === "function") {
			const records = await sessionQuery.listSessions();
			const hit = (records || []).find((item) => item && item.header && String(item.header.id) === sessionId);
			if (hit && hit.header && typeof hit.header.cwd === "string" && hit.header.cwd !== "") return hit.header.cwd;
		}
	} catch {
		// 会话服务缺失(旧宿主)/查询失败:回退会话默认目录
	}
	return process.cwd();
}

function apply(ctx, config) {
	const cfg = Config(config || {});
	if (cfg.role === "preset-sync") {
		try {
			const outcome = syncPreset();
			if (outcome === "skipped-foreign") {
				ctx.logger?.warn?.("rs-workflow preset 目录无有效来源标记或归属他人,已保留不覆盖;确认后手动删除,下次启动即由本包接管");
			} else if (outcome === "created") {
				ctx.logger?.info?.(`rs-workflow preset 已首次释放到 ${presetDest()}`);
			} else if (outcome === "updated") {
				ctx.logger?.info?.(`rs-workflow preset 已同步更新: ${presetDest()}`);
			}
		} catch (error) {
			ctx.logger?.warn?.(`rs-workflow preset 同步失败(不影响本插件其余角色): ${error?.code ? `[${error.code}] ` : ""}${error?.message ?? error}; 目标: ${presetDest()}`);
		}
		return;
	}
	if (cfg.role === "settings") {
		ctx.inject(["settings"], (sctx) => {
			sctx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: baseOf(cfg) });
		});
		return;
	}
	if (cfg.role === "board") {
		registerBoardRoutes(ctx);
		return;
	}
	if (cfg.role === "takeover") {
		registerTakeover(ctx, { kind: cfg.kind, flowFile: cfg.flowFile });
		return;
	}
	// tools 以嵌套 inject 声明:服务缺失时仅 tool/report 角色保持未激活(干净禁用)
	if (cfg.role === "report") {
		registerReportTool(ctx);
		return;
	}
	if (cfg.role !== "template-tool") return;
	registerTemplateTool(ctx);
}

/** rs_workflow_template:AI 流程模板编辑入口(spec/list/save/remove)。 */
function registerTemplateTool(ctx) {
	ctx.inject(["tools"], (tctx) => {
		tctx.effect(() => tctx.tools.register(createTemplateTool({
			getTemplates: async () => readTemplates(ctx),
			setTemplates: (templates) => writeTemplates(ctx, templates),
			releaseTemplate: (entry) => releaseFlowTemplate(entry) !== "foreign",
			unreleaseTemplate: (id) => unreleaseFlowTemplate(id),
			logger: ctx.logger,
		})), "rs-workflow template tool");
	});
}

/** rs_workflow_report:子代理节点软上报(node)与运行查询(list/get)。 */
function registerReportTool(ctx) {
	const store = reportStore();
	ctx.inject(["tools"], (tctx) => {
		tctx.tools.register(defineTool({
			name: "rs_workflow_report",
			description: [
				"若水工作流运行看板的上报通道(可选软上报,失败即跳过,禁止重试):",
				"{action:\"node\", runId, nodeId, status, summary} 在节点完成时向看板报告进展;",
				"{action:\"list\"} 列出本工作区运行,{action:\"get\", runId} 取运行详情。",
			].join(""),
			parameters: {
				action: { type: "string", required: true, enum: REPORT_ACTIONS, description: "node=节点级软上报;list=列出运行;get=取运行详情" },
				runId: { type: "string", description: "node/get 必传:运行标识" },
				nodeId: { type: "string", description: "node:节点标识" },
				status: { type: "string", description: "node:节点状态(running/done/failed 等,自由文本)" },
				summary: { type: "string", description: "node:一句话进展" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						runId: { type: "string" },
						runs: { type: "array", items: { type: "object", additionalProperties: true } },
						run: { type: "object", additionalProperties: true },
						error: { type: "string" },
					},
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value.run !== undefined ? { ok: value.ok, runId: value.run.runId, status: value.run.status }
						: value.runs !== undefined ? { ok: value.ok, runs: value.runs.map((run) => ({ runId: run.runId, status: run.status, request: run.request, startedAt: run.startedAt })) }
						: value, null, 2),
				}],
			},
			async execute(args, exec) {
				const workspace = await resolveWorkspace(tctx, exec);
				if (args.action === "node") {
					const run = await store.appendNode({ runId: args.runId, nodeId: args.nodeId, status: args.status, summary: args.summary });
					return { ok: true, runId: run.runId };
				}
				if (args.action === "list") {
					const runs = (await store.list()).filter((run) => run.workspace === workspace);
					return { ok: true, runs };
				}
				const run = await store.get(args.runId || "");
				if (!run) return { ok: false, error: "运行记录不存在:" + (args.runId || "") };
				return { ok: true, run };
			},
			presentCall: () => ({ card: "generic", title: "上报工作流运行状态", kind: "other", rawInput: {} }),
		}));
	});
}

export { BUDGET_DEFAULTS, BUDGET_MAX, BUDGET_MIN, Config, MAX_TASKS_DEFAULT, MAX_TASKS_MAX, MAX_TASKS_MIN, NAMESPACE, SETTINGS_SCHEMA, TEMPLATES, apply, flowPresetDest, name, presetDest, readTemplates, releaseFlowTemplate, removePreset, reportStore, syncPreset, unreleaseFlowTemplate };