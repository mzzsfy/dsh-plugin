/**
 * dsh-rs-workflow — 若水工作流 (rs-workflow) 一体化插件。
 *
 * 一个包，三种行角色（由组合行的 config.role 决定，加载前经 Config 校验）：
 *   - "settings"：注册 settings 命名空间 "rs-workflow"，GUI 设置页出现配置表单
 *     （3 基础工作位 + 13 细分工作位 + 工作流默认项 + 预算，语义对齐 rs-tui 原始配置）。
 *     放在 profile 的 cordis.patch.yml（host 平面，常驻；裸包名从 profile
 *     node_modules 解析）。
 *   - "preset-sync"：把包内 preset/rs-workflow（preset.yml + agent.cordis.yml +
 *     skills 协议技能与编排引擎）幂等同步到 <dsh-home>/.agent-presets/rs-workflow，
 *     模式选择器即出现"若水工作流"。同为 host 平面行；升级包后重启即更新 preset。
 *     卸载时 pnpm 不执行依赖的 preuninstall（实验证实），残留 preset 因 tool 行
 *     import 失败在选择器显示 broken，手动清理命令见 README。
 *   - "tool"：注册模型工具 rs_workflow_config，主代理启动工作流编排前读取当前
 *     配置。放在释放出的 preset 组合（agent 平面，仅该模式可见；预设行的
 *     裸包名经 PresetTree.import 以组合 baseUrl 锚定 profile 目录、上溯
 *     node_modules 解析，直接命中 dsh plugin add 安装的本包）。
 *
 * 三个角色读写同一 settings 命名空间：settings 行负责注册与默认值（组合 config 即
 * base 层），tool 行只在执行时经 ctx.get("settings") 读取宿主进程里的同一
 * 实例，不注册、不产生第二个实例。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { presetDest, removePreset, syncPreset } from "./preset-sync.mjs";
import { reportStore } from "./report-store.mjs";

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

// 预算字段与默认值对齐 rs-tui budgets(config.ts:290-299),clamp 边界同 node-tree BUDGET_MIN/MAX
const BUDGET_DEFAULTS = {
	reviewRejectBeforeEscalate: 2,
	planRejectBeforeBlocked: 2,
	emptyOutputRetryLimit: 3,
	reportNudgeLimit: 3,
};
const BUDGET_MIN = 1;
const BUDGET_MAX = 10;

/** 预算数值子 schema;clamp 在引擎侧执行,schema 只声明合法域。 */
function buildBudgets() {
	const budget = (def, description) => z.number().default(def).min(BUDGET_MIN).max(BUDGET_MAX).description(description);
	return z.object({
		reviewRejectBeforeEscalate: budget(BUDGET_DEFAULTS.reviewRejectBeforeEscalate, "任务连续被拒/失败达此值触发升级重规划(含自报失败与调用失败)"),
		planRejectBeforeBlocked: budget(BUDGET_DEFAULTS.planRejectBeforeBlocked, "计划/子计划连续被拒达此值触发升级重规划"),
		emptyOutputRetryLimit: budget(BUDGET_DEFAULTS.emptyOutputRetryLimit, "审批缺验证证据时重问上限,超限视为拒绝"),
		reportNudgeLimit: budget(BUDGET_DEFAULTS.reportNudgeLimit, "执行完成但未给出交接摘要时追问上限"),
	});
}

/** 工作位（slot）子 schema；细分位场景文案对齐 rs-tui SLOT_SCENES。string/array/{rotation} 三态：array 与 rotation 数组等价（候选依次轮换，被拒重做/重问换模型）。工厂函数保证 Config 与 SETTINGS_SCHEMA 各持独立实例。 */
function buildSlots() {
	const slot = (description) => z.union([z.string(), z.array(z.string()), z.object({ rotation: z.array(z.string()) })]).default("").description(description);
	return z.object({
		planner: slot("planner 基础位（规划域兜底）。格式 provider/model、候选数组或 {rotation:[...]}，留空 = 会话默认模型"),
		executor: slot("executor 基础位（执行域兜底）；候选依次轮换，被拒重做/重试换模型"),
		reviewer: slot("reviewer 基础位（审批域兜底）；候选依次轮换"),
		"planner-triage": slot("细分位：首次分诊，分析需求选模板拆任务；缺省降级 planner"),
		"planner-command": slot("细分位：总规划，计划重写与大纲修订；缺省降级 planner"),
		"planner-subplan": slot("细分位：子计划细化，子计划内任务拆解；缺省降级 planner"),
		"planner-escalate": slot("细分位：升级重规划，连续拒绝超阈后的尾段重拆；缺省降级 planner"),
		"reviewer-plan": slot("细分位：计划审批，审批计划文本与大纲；缺省降级 reviewer"),
		"reviewer-task": slot("细分位：任务审批，审批单个任务执行结果；缺省降级 reviewer"),
		"reviewer-subplan": slot("细分位：子计划交付审批，审批整个子计划交付；缺省降级 reviewer"),
		"reviewer-final": slot("细分位：单终审，末尾终审全部交付；缺省降级 reviewer，建议配更强的模型"),
		"reviewer-cross": slot("细分位：交叉终审，多视角交叉终审链；缺省降级 reviewer，建议配更强的模型"),
		"executor-task": slot("细分位：任务首次执行；缺省降级 executor"),
		"executor-enhance": slot("细分位：被拒重做，携带 REJECTED 理由修改重交；缺省降级 executor"),
		"executor-retry": slot("细分位：失败重试，自报失败/无产出后的重试；缺省降级 executor"),
		"executor-escalate": slot("细分位：升级后执行，升级重规划产出的新任务；缺省降级 executor"),
	});
}

/** 工作流默认项子 schema。maxTasks 为 DSH 原生任务预算（rs-tui 无数量上限），约束全部任务实例化；
 *  引擎侧对 <=0/非数值另有自保回落(见 engine.js),此处 schema 声明合法域挡住非法值。 */
const MAX_TASKS_DEFAULT = 8;
const MAX_TASKS_MIN = 1;
const MAX_TASKS_MAX = 64;
function buildWorkflow() {
	return z.object({
		defaultTemplate: z.union(TEMPLATES).default("auto").description("默认模板：auto = planner 分诊自动选型（无信号时兜底 multi-plan）；其余 = 无信号时兜底该模板，planner 声明与分诊矩阵仍优先生效"),
		maxTasks: z.number().default(MAX_TASKS_DEFAULT).min(MAX_TASKS_MIN).max(MAX_TASKS_MAX).description("单轮任务拆解数上限（含子计划运行时任务的全局预算）"),
	});
}

/** settings 命名空间 schema（GUI 表单渲染的就是它，不含行角色字段）。 */
const SETTINGS_SCHEMA = z.object({
	slots: buildSlots(),
	workflow: buildWorkflow(),
	budgets: buildBudgets(),
});

/** 组合行 config schema（在 settings 之上多一个行角色字段）。 */
const Config = z.object({
	role: z.union(["settings", "preset-sync", "tool", "report", "board"]).required().description("行角色：settings = 注册 GUI 设置命名空间（host 层常驻）；preset-sync = 同步释放 agent preset 到用户预设根（host 层常驻）；tool = 注册 rs_workflow_config 模型工具（预设层）；report = 注册 rs_workflow_report 运行上报工具（预设层）；board = 注册工作流看板 web 路由（host 层常驻）"),
	slots: buildSlots(),
	workflow: buildWorkflow(),
	budgets: buildBudgets(),
});

/** 从（已解析的）行 config 里摘出 settings base 层。 */
function baseOf(config) {
	return { slots: config.slots, workflow: config.workflow, budgets: config.budgets };
}

// ── 看板 web 路由(host 层 board 角色) ────────────────────────────────────────
// 读路由放行 GET(无 CSRF 面);写路由 POST 加跨源与 JSON 守卫(dsh-usage-panel 同构)。
// 路由只做薄分发,数据权威态在 report-store 单例(与 report 工具共享)。

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

function registerBoardRoutes(ctx) {
	const store = reportStore();
	// webServer 以嵌套 inject 声明:服务缺失时仅 board 角色保持未激活(干净禁用),
	// 其余行角色不被模块级 inject 连坐(多角色包的模块级声明会整树 fatal)
	ctx.inject(["webServer"], (wctx) => {
		wctx.effect(
			() =>
				wctx.webServer.register({
					kind: "exact",
					path: "/api/rs-workflow/runs",
					handler: guardedRoute(async (req, res) => {
						sendJson(res, 200, { runs: await store.list() });
					}),
				}),
			"rs-workflow runs route",
		);
		wctx.effect(
			() =>
				wctx.webServer.register({
					kind: "exact",
					path: "/api/rs-workflow/run",
					handler: guardedRoute(async (req, res) => {
						const url = new URL(req.url, "http://localhost");
						const runId = url.searchParams.get("id") || "";
						const run = await store.get(runId);
						if (!run) throw new Error("运行记录不存在:" + runId);
						sendJson(res, 200, run);
					}),
				}),
			"rs-workflow run detail route",
		);
		wctx.effect(
			() =>
				wctx.webServer.register({
					kind: "exact",
					path: "/api/rs-workflow/remove",
					handler: guardedRoute.post(async (req, res) => {
						const body = JSON.parse(await readJsonBody(req));
						const runId = body && typeof body.runId === "string" ? body.runId : "";
						await store.remove(runId);
						sendJson(res, 200, { ok: true });
					}),
				}),
			"rs-workflow remove route",
		);
	});
}

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

// ── 运行上报工具(预设层 report 角色) ────────────────────────────────────────
// 实时通道 = leader 权威写(start/finish)+ 子代理节点级软上报(node, 失败即弃不影响编排)。
// 工作区解析 best-effort:会话 id 反查 cwd(新宿主)→ 会话默认目录;解析失败不硬失败。

const REPORT_ACTIONS = ["start", "node", "finish", "list", "get"];

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
	// tools 以嵌套 inject 声明:服务缺失时仅 tool/report 角色保持未激活(干净禁用),
	// settings/preset-sync/board 角色不再被模块级 inject 连坐(非 dsh-base 组合下旧形态
	// 会因启动审计整树 fatal)
	if (cfg.role === "report") {
		registerReportTool(ctx);
		return;
	}
	if (cfg.role !== "tool") return;
	ctx.inject(["tools"], (tctx) => {
		tctx.tools.register(defineTool({
		name: "rs_workflow_config",
		description: "读取若水工作流 (rs-workflow) 的当前配置：各角色的模型工作位 (slots)、工作流默认项 (workflow) 与预算 (budgets)。启动 workflow 编排前必须先调用本工具：slots 原样作为 workflow 调用 args.slots；workflow.defaultTemplate 作为 args.defaultTemplate（auto = 无信号时兜底 multi-plan，其余值 = 无信号时兜底该值；planner 声明与分诊矩阵始终优先）；workflow.maxTasks 作为 args.limits.maxTasks；budgets 原样作为 args.budgets。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					slots: {
						type: "object",
						required: true,
						additionalProperties: true,
						properties: Object.fromEntries(SLOT_KEYS.map((k) => [k, {
							oneOf: [
								{ type: "string" },
								{ type: "array", items: { type: "string" } },
								{ type: "object", additionalProperties: false, properties: { rotation: { type: "array", items: { type: "string" } } } },
							],
						}])),
					},
					workflow: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							defaultTemplate: { type: "string", enum: TEMPLATES },
							maxTasks: { type: "number" },
						},
					},
					budgets: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							reviewRejectBeforeEscalate: { type: "number" },
							planRejectBeforeBlocked: { type: "number" },
							emptyOutputRetryLimit: { type: "number" },
							reportNudgeLimit: { type: "number" },
						},
					},
					source: { type: "string", required: true, enum: ["settings", "fallback"] },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify({ slots: value.slots, workflow: value.workflow, budgets: value.budgets }, null, 2)
					+ (value.source === "fallback" ? "\n(设置服务不可用：返回的是组合默认值，GUI 修改不在此生效)" : ""),
			}],
		},
		execute() {
			const settings = tctx.get("settings");
			let value;
			try {
				value = settings ? settings.get(NAMESPACE) : undefined;
			} catch (error) {
				// settings 服务在但读取失败(命名空间被移除/配置损坏)时走组合默认值,工具永不硬失败
				ctx.logger?.warn?.(`rs-workflow settings 读取失败,回退组合默认值: ${error?.message ?? error}`);
			}
			if (value) {
				return Promise.resolve({ slots: value.slots, workflow: value.workflow, budgets: value.budgets, source: "settings" });
			}
			return Promise.resolve({ slots: cfg.slots, workflow: cfg.workflow, budgets: cfg.budgets, source: "fallback" });
		},
		presentCall: () => ({ card: "generic", title: "读取若水工作流配置", kind: "other", rawInput: {} }),
	}));
	});

}

/** rs_workflow_report:leader 权威写(start/finish)与子代理节点软上报(node)共用通道。 */
function registerReportTool(ctx) {
	const store = reportStore();
	ctx.inject(["tools"], (tctx) => {
		tctx.tools.register(defineTool({
			name: "rs_workflow_report",
			description: [
				"若水工作流运行看板的上报通道：把编排运行的状态写入工作流看板（GUI 设置页「若水工作流」分区可见）。",
				"启动 workflow 编排前调用 {action:\"start\", request} 记录本次运行并取得 runId；",
				"编排结束后调用 {action:\"finish\", runId, ok, summary, result}（result 原样传 workflow 工具的返回对象）；",
				"子代理可在节点完成时调用 {action:\"node\", runId, nodeId, status, summary} 做节点级软上报（可选，失败即跳过，禁止重试）；",
				"list 列出本工作区全部运行，get 按 runId 取单次运行详情。",
			].join(""),
			parameters: {
				action: { type: "string", required: true, enum: REPORT_ACTIONS, description: "start=登记运行并取得 runId;node=节点级软上报;finish=落定运行结果;list=列出运行;get=取运行详情" },
				runId: { type: "string", description: "运行标识（start 可省略自动生成;其余 action 必传）" },
				request: { type: "string", description: "start:本次编排的用户需求原文" },
				nodeId: { type: "string", description: "node:节点标识（如 t1/p1/xr1）" },
				status: { type: "string", description: "node:节点状态（running/done/failed/rejected 等,自由文本）" },
				summary: { type: "string", description: "node/finish:一句话进展或结论" },
				ok: { type: "boolean", description: "finish:true=正常完成,false=blocked" },
				blocked: { type: "object", additionalProperties: true, description: "finish:blocked 时的 {nodeId,reason} 对象" },
				result: { type: "object", additionalProperties: true, description: "finish:workflow 工具的返回对象原样" },
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
				if (args.action === "start") {
					const run = await store.start({ runId: args.runId, workspace, request: args.request, templateId: "" });
					return { ok: true, runId: run.runId, run };
				}
				if (args.action === "node") {
					const run = await store.appendNode({ runId: args.runId, nodeId: args.nodeId, status: args.status, summary: args.summary });
					return { ok: true, runId: run.runId, run };
				}
				if (args.action === "finish") {
					const run = await store.finish({ runId: args.runId, ok: args.ok === true, result: args.result, summary: args.summary, blocked: args.blocked });
					return { ok: true, runId: run.runId, run };
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

export { BUDGET_DEFAULTS, BUDGET_MAX, BUDGET_MIN, Config, MAX_TASKS_DEFAULT, MAX_TASKS_MAX, MAX_TASKS_MIN, NAMESPACE, SETTINGS_SCHEMA, TEMPLATES, apply, name, presetDest, removePreset, reportStore, syncPreset };
