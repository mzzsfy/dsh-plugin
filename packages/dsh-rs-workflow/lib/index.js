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
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { syncPreset } from "./preset-sync.mjs";

const name = "rs-workflow";
const inject = ["tools"];

const NAMESPACE = settingsNamespace("rs-workflow");

const TEMPLATES = ["auto", "lite", "plan-final", "step-review", "multi-plan"];

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

/** 工作流默认项子 schema。maxTasks 为 DSH 原生任务预算（rs-tui 无数量上限），约束全部任务实例化。 */
function buildWorkflow() {
	return z.object({
		defaultTemplate: z.union(TEMPLATES).default("auto").description("默认模板：auto = planner 分诊自动选型（无信号时兜底 multi-plan）；其余 = 无信号时兜底该模板，planner 声明与分诊矩阵仍优先生效"),
		maxTasks: z.number().default(8).description("单轮任务拆解数上限（含子计划运行时任务的全局预算）"),
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
	role: z.union(["settings", "preset-sync", "tool"]).required().description("行角色：settings = 注册 GUI 设置命名空间（host 层常驻）；preset-sync = 同步释放 agent preset 到用户预设根（host 层常驻）；tool = 注册 rs_workflow_config 模型工具（预设层）"),
	slots: buildSlots(),
	workflow: buildWorkflow(),
	budgets: buildBudgets(),
});

/** 从（已解析的）行 config 里摘出 settings base 层。 */
function baseOf(config) {
	return { slots: config.slots, workflow: config.workflow, budgets: config.budgets };
}

function apply(ctx, config) {
	const cfg = Config(config || {});
	if (cfg.role === "preset-sync") {
		try {
			const outcome = syncPreset();
			if (outcome === "skipped-foreign") {
				ctx.logger?.warn?.("rs-workflow preset 目录无有效来源标记或归属他人,已保留不覆盖;确认后手动删除,下次启动即由本包接管");
			} else if (outcome === "created") {
				ctx.logger?.info?.("rs-workflow preset 已首次释放到用户预设根");
			} else if (outcome === "updated") {
				ctx.logger?.info?.("rs-workflow preset 已同步更新");
			}
		} catch (error) {
			ctx.logger?.warn?.(`rs-workflow preset 同步失败(不影响本插件其余角色): ${error?.message ?? error}`);
		}
		return;
	}
	if (cfg.role === "settings") {
		ctx.inject(["settings"], (sctx) => {
			sctx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: baseOf(cfg) });
		});
		return;
	}
	ctx.tools.register(defineTool({
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
						properties: Object.fromEntries([
							"planner", "executor", "reviewer",
							"planner-triage", "planner-command", "planner-subplan", "planner-escalate",
							"reviewer-plan", "reviewer-task", "reviewer-subplan", "reviewer-final", "reviewer-cross",
							"executor-task", "executor-enhance", "executor-retry", "executor-escalate",
						].map((k) => [k, {
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
			const settings = ctx.get("settings");
			const value = settings ? settings.get(NAMESPACE) : undefined;
			if (value) {
				return Promise.resolve({ slots: value.slots, workflow: value.workflow, budgets: value.budgets, source: "settings" });
			}
			return Promise.resolve({ slots: cfg.slots, workflow: cfg.workflow, budgets: cfg.budgets, source: "fallback" });
		},
		presentCall: () => ({ card: "generic", title: "读取若水工作流配置", kind: "other", rawInput: {} }),
	}));
}

export { Config, NAMESPACE, SETTINGS_SCHEMA, apply, inject, name };
