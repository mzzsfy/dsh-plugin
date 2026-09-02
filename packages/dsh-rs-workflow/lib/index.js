/**
 * dsh-rs-workflow — 若水工作流 (rs-workflow) 一体化插件。
 *
 * 一个包，三种行角色（由组合行的 config.role 决定，加载前经 Config 校验）：
 *   - "settings"：注册 settings 命名空间 "rs-workflow"，GUI 设置页出现配置表单。
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

/** 工作位（slot）子 schema；string = 单绑定，array = 候选数组（依次故障转移）。工厂函数保证 Config 与 SETTINGS_SCHEMA 各持独立实例。 */
function buildSlots() {
	const slot = (description) => z.union([z.string(), z.array(z.string())]).default("").description(description);
	return z.object({
		planner: slot("planner 基础位（规划/分诊/重规划）。格式 provider/model 或候选数组，留空 = 会话默认模型"),
		executor: slot("executor 基础位（任务执行）；数组 = 依次故障转移，被拒重做换模型"),
		reviewer: slot("reviewer 基础位（逐步审/子计划审/交叉终审 B 位）；数组 = 候选故障转移"),
		"planner-triage": slot("细分位：工作流启动时的分诊+拆解；缺省降级 planner"),
		"planner-escalate": slot("细分位：升级重规划/返工/计划重规划；缺省降级 planner"),
		"reviewer-final": slot("细分位：终审/交叉终审 A 位；缺省降级 reviewer，建议配更强的模型"),
		"reviewer-plan": slot("细分位：计划审批 pr 节点；缺省降级 reviewer，中等推理即可"),
		"executor-retry": slot("细分位：被驳回后的返工执行；缺省降级 executor"),
	});
}

/** 工作流默认项子 schema。 */
function buildWorkflow() {
	return z.object({
		defaultTemplate: z.union(TEMPLATES).default("auto").description("默认模板：auto = 由 planner 按难度分诊；其余 = 锁定该模板"),
		maxTasks: z.number().default(8).description("单轮任务拆解数上限"),
	});
}

/** settings 命名空间 schema（GUI 表单渲染的就是它，不含行角色字段）。 */
const SETTINGS_SCHEMA = z.object({
	slots: buildSlots(),
	workflow: buildWorkflow(),
});

/** 组合行 config schema（在 settings 之上多一个行角色字段）。 */
const Config = z.object({
	role: z.union(["settings", "preset-sync", "tool"]).required().description("行角色：settings = 注册 GUI 设置命名空间（host 层常驻）；preset-sync = 同步释放 agent preset 到用户预设根（host 层常驻）；tool = 注册 rs_workflow_config 模型工具（预设层）"),
	slots: buildSlots(),
	workflow: buildWorkflow(),
});

/** 从（已解析的）行 config 里摘出 settings base 层。 */
function baseOf(config) {
	return { slots: config.slots, workflow: config.workflow };
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
		description: "读取若水工作流 (rs-workflow) 的当前配置：各角色的模型工作位 (slots) 与工作流默认项 (workflow)。启动 workflow 编排前必须先调用本工具：slots 原样作为 workflow 调用 args.slots；workflow.defaultTemplate 非 auto 且用户未点名模板时作为 lockedTemplate；workflow.maxTasks 作为 args.limits.maxTasks。",
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
						properties: {
							planner: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							executor: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							reviewer: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							"planner-triage": { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							"planner-escalate": { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							"reviewer-final": { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							"reviewer-plan": { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
							"executor-retry": { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
						},
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
					source: { type: "string", required: true, enum: ["settings", "fallback"] },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify({ slots: value.slots, workflow: value.workflow }, null, 2)
					+ (value.source === "fallback" ? "\n(设置服务不可用：返回的是组合默认值，GUI 修改不在此生效)" : ""),
			}],
		},
		execute() {
			const settings = ctx.get("settings");
			const value = settings ? settings.get(NAMESPACE) : undefined;
			if (value) {
				return Promise.resolve({ slots: value.slots, workflow: value.workflow, source: "settings" });
			}
			return Promise.resolve({ slots: cfg.slots, workflow: cfg.workflow, source: "fallback" });
		},
		presentCall: () => ({ card: "generic", title: "读取若水工作流配置", kind: "other", rawInput: {} }),
	}));
}

export { Config, NAMESPACE, SETTINGS_SCHEMA, apply, inject, name };
