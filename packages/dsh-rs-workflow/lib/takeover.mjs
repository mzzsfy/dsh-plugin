/**
 * takeover — 模式内引擎接管:pre-step 拦截 + workflowEngine 编程启动 + 事件落看板。
 *
 * 释放的每个流程模式(collab 或 flow.json5)都挂本角色行(delegation 组内,
 * 与 workflowEngine 同 isolate realm)。行激活即注册 agent/pre-step 拦截:
 *   - 用户消息进入 step 前,拦截并 reject(不产生主会话模型请求,零模型自驱),
 *     以消息原文为 request 经 workflowEngine.start 启动编排,脚本由插件自带;
 *   - 同一会话已有在飞编排时,后续消息同样 reject(不排队不合并),看板记录;
 *   - 编排落定(workflow/end)后写 report-store(看板权威态)。
 *
 * pre-step 是 async waterfall:资源解析(skills/文档读取)在拦截路径内 await 完成,
 * 拒绝决策本身同步返回,不阻塞消息面。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { validateFlow, collectLoadRefs } from "./flows.mjs";
import { reportStore } from "./report-store.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLLAB_SCRIPT_PATH = join(PKG_ROOT, "engine", "collab.js");
const FLOW_SCRIPT_PATH = join(PKG_ROOT, "engine", "flow.js");
const PRESET_ROOT_NAME = ".agent-presets";
const FLOW_PRESET_PREFIX = "rs-";
/** 单资源注入上限(与 flow.js RESOURCE_CHARS 对拍,parity 测试钉住) */
export const RESOURCE_MAX_CHARS = 16 * 1000;
/** 动态路由候选模式目录扫描上限(防异常目录拖慢拦截路径) */
const FLOW_DIR_SCAN_MAX = 64;

let cachedScripts = null;
function scripts() {
	if (!cachedScripts) {
		cachedScripts = {
			collab: readFileSync(COLLAB_SCRIPT_PATH, "utf8"),
			flow: readFileSync(FLOW_SCRIPT_PATH, "utf8"),
		};
	}
	return cachedScripts;
}

/** 释放模式集合:扫预设根下 rs- 前缀目录的 flow.json5(marker 归属校验),
 *  返回 { <flowId>: <流程定义> }。跨模板动态路由与资源收集都用这份目录。 */
export function discoverFlowRegistry(dshHome) {
	const root = join(dshHome, PRESET_ROOT_NAME);
	const registry = {};
	if (!existsSync(root)) return registry;
	for (const name of readdirSync(root).slice(0, FLOW_DIR_SCAN_MAX)) {
		if (!name.startsWith(FLOW_PRESET_PREFIX)) continue;
		const flowFile = join(root, name, "flow.json5");
		const markerFile = join(root, name, ".dsh-rs-workflow-source.json");
		if (!existsSync(flowFile) || !existsSync(markerFile)) continue;
		try {
			const marker = JSON.parse(readFileSync(markerFile, "utf8"));
			if (marker && marker.package === "@mzzsfy/dsh-rs-workflow" && marker.kind === "flow") {
				const flow = JSON5.parse(readFileSync(flowFile, "utf8"));
				if (flow && typeof flow.id === "string") registry[flow.id] = flow;
			}
		} catch {
			// 残缺模式目录跳过,不影响其余候选
		}
	}
	return registry;
}

/** 组装 workflowEngine.start 所需 args(slots/budgets 语义与 collab 引擎一致)。 */
function buildArgs({ kind, flow, flows, resources, request, settings }) {
	const value = settings || {};
	return {
		request,
		slots: value.slots || {},
		budgets: value.budgets || {},
		// collab 引擎参数
		contextNotes: "",
		defaultTemplate: value.workflow?.defaultTemplate || "auto",
		limits: value.workflow?.maxTasks > 0 ? { maxTasks: value.workflow.maxTasks } : {},
		// 流程解释器参数
		flow: kind === "flow" ? flow : undefined,
		flows,
		resources,
	};
}

function metaFor(kind, flow, request) {
	if (kind === "collab") {
		return {
			name: "rs-workflow-collab",
			description: String(request).slice(0, 200),
			phases: [
				{ title: "分诊与规划" },
				{ title: "执行与审批" },
				{ title: "升级重规划" },
				{ title: "汇总" },
			],
		};
	}
	return {
		name: "rs-flow-" + String(flow?.id || "unnamed"),
		description: String(request).slice(0, 200),
		phases: (flow?.steps || []).slice(0, 12).map((step) => ({
			title: (step.label || step.id).slice(0, 80),
		})),
	};
}

/** 资源解析:load 引用 → 全文。skill 经 skills 服务,doc 经工作区相对路径读盘。 */
export async function resolveResources(refs, { getSkill, readDoc }) {
	const resources = {};
	for (const ref of refs || []) {
		const idx = ref.indexOf(":");
		const scheme = idx > 0 ? ref.slice(0, idx) : "";
		const target = ref.slice(idx + 1);
		try {
			if (scheme === "skill" && getSkill) {
				const body = await getSkill(target);
				if (typeof body === "string" && body.trim() !== "") resources[ref] = body.slice(0, RESOURCE_MAX_CHARS * 2);
			} else if (scheme === "doc" && readDoc) {
				const body = await readDoc(target);
				if (typeof body === "string" && body.trim() !== "") resources[ref] = body.slice(0, RESOURCE_MAX_CHARS * 2);
			}
		} catch {
			// 单资源缺失不阻断编排,指令内该节缺省
		}
	}
	return resources;
}

/** 模式行激活入口(index.js takeover 角色调用)。
 *  config: { kind: "collab" } 或 { kind: "flow", flowFile: <绝对路径> };
 *  传 dshHome 仅供测试注入。 */
export function registerTakeover(ctx, config, { dshHome } = {}) {
	const kind = config.kind === "flow" ? "flow" : "collab";
	const store = reportStore();
	const home = dshHome || resolveHome();
	let flow = null;
	if (kind === "flow") {
		const text = readFileSync(config.flowFile, "utf8");
		flow = JSON5.parse(text);
		const errors = validateFlow(flow);
		if (errors.length > 0) throw new Error("flow.json5 校验失败:\n- " + errors.join("\n- "));
	}
	// 在飞编排账本:同一会话同一时刻至多一个 run(pre-step 串行化依赖单线程语义)
	const active = new Map(); // agent.id → { runId, turn }

	/** 向会话流写一条用户可见的编排提示。pre-step reject 不产生任何模型记录,
	 *  没有它被拦截会话在 GUI 对话区完全空白(用户不知道后台发生了什么)。
	 *  形态必须是 user/message 的 data 扁平原生形状(id/role/source/content 在顶层):
	 *  - system/message 被模型侧 SystemPromptProjection 强占为系统提示词投影,
	 *    非提示词内容会在下一次请求被 replace 清洗,且 GUI 渲染为提示词卡(错位);
	 *  - user/message 带 turn/step 或嵌套 message 包装会使会话标题投影
	 *    (sessionTitleUserMessageOf 读 data.source)读到 undefined 崩溃,
	 *    连带 collab 子代理 spawn 与 auto-continue 全链失败(实测)。
	 *  kind:'plugin'+form:'notice' 即官方合成上下文注入形态(GUI 渲染 context 行),
	 *  会进入模型历史:接管后主模型零参与,失败回退时模型可借此知晓编排经过。
	 *  失败只降级不影响拦截。 */
	function note(agent, text) {
		try {
			agent.session.append("user/message", {
				id: randomUUID(),
				role: "user",
				source: {
					kind: "plugin",
					plugin: "@mzzsfy/dsh-rs-workflow",
					form: "notice",
					summary: text.split("\n")[0].slice(0, 120),
				},
				content: [{ type: "text", text }],
			}, { surfaceOp: "append" });
		} catch (error) {
			ctx.logger?.warn?.(`rs-workflow 会话提示写入失败: ${error?.message ?? error}`);
		}
	}

	// pre-step 拦截:行激活于 agent realm,事件自动 scoped 到本会话 agent。
	// 只拦截主会话 agent(会话头无 parentSession);子代理(planner/executor/reviewer)
	// 的请求必须放行进模型,编排才能推进。reject 同步返回,消息不进主模型。
	// workflowEngine 声明在嵌套插件上,只有回调 ctx 可访问,捕获后供 startRun 使用。
	let engine;
	ctx.inject(["workflowEngine"], (engineCtx) => {
		engine = engineCtx.workflowEngine;
		ctx.effect(() => ctx.on("agent/pre-step", (payload, next) => {
			const agent = payload.agent;
			if (agent?.session?.header?.parentSession !== undefined) return next();
			// 消息正文兼容双形态:纯字符串 content 与分段数组 content([{type:"text",text}])
			const text = (payload.messages || [])
				.map((m) => {
					if (!m) return "";
					if (typeof m.content === "string") return m.content.trim();
					if (Array.isArray(m.content)) {
						return m.content
							.map((part) => (part && typeof part.text === "string" ? part.text : ""))
							.filter(Boolean)
							.join("\n")
							.trim();
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
			if (text === "") return next();
			if (active.has(agent.id)) {
				const entry = active.get(agent.id);
				store.appendNode({ runId: entry.runId, nodeId: "inbox", status: "ignored", summary: "运行期间追加消息已忽略: " + text.slice(0, 80) }).catch(() => {});
				note(agent, "若水编排进行中,该消息已忽略(完成后可继续提交)。");
				return { kind: "reject" };
			}
			// 记录形态的 request 剔除系统注入段(system-reminder 等标签块):
			// payload.messages 是拼装后的模型请求,看板/页签展示用户原始输入
			const userText = text.split(/<\/?system-reminder>/i)[0].trim();
			startRun(agent, userText === "" ? text : userText).catch((error) => {
				ctx.logger?.error?.(`rs-workflow 编排启动失败: ${error?.stack ?? error?.message ?? error}`);
				note(agent, "若水编排启动失败: " + String(error?.message ?? error).slice(0, 200));
			});
			note(agent, "若水编排已接管本请求(模式: " + (kind === "flow" ? flow?.id || "flow" : "协作编码") + "),进度见工作流看板。");
			return { kind: "reject" };
		}), "rs-workflow takeover pre-step");
	});

	async function startRun(agent, request) {
		const settings = readSettings(ctx);
		const flows = kind === "flow" ? discoverFlowRegistry(home) : {};
		if (kind === "flow" && flow) flows[flow.id] = flow;
		const refs = [];
		for (const target of Object.values(flows)) {
			for (const ref of collectLoadRefs(target)) refs.push(ref);
		}
		const workspace = await resolveCwd(ctx, agent);
		const resources = await resolveResources([...new Set(refs)], {
			getSkill: (name) => readSkill(ctx, name),
			readDoc: (path) => readDocFile(workspace, path),
		});
		const script = kind === "collab" ? scripts().collab : scripts().flow;
		const runArgs = buildArgs({ kind, flow, flows, resources, request, settings });
		const run = engine.start({
			script,
			meta: metaFor(kind, flow, request),
			args: runArgs,
			parent: agent,
			subagentProvider: "spawn",
		});
		const runId = String(run.id);
		active.set(agent.id, { runId });
		const sessionId = agent && agent.session ? String(agent.session.id || agent.id || "") : "";
		const storeRun = await store.start({ runId, workspace, request, templateId: kind === "flow" ? "flow:" + flow.id : "collab", sessionId });
		run.result.then((result) => {
			active.delete(agent.id);
			const ok = !!(result && result.stopReason === "completed");
			const summary = ok && result.value && typeof result.value === "object"
				? summarizeFlowResult(result.value)
				: String((result && result.error) || "编排异常结束").slice(0, 300);
			store.finish({ runId, ok, result: (result && result.value) || null, summary, blocked: ok ? null : { reason: summary } }).catch(() => {});
			note(agent, ok ? "若水编排完成: " + summary : "若水编排未完成: " + summary);
		}).catch((error) => {
			active.delete(agent.id);
			const reason = "编排异常: " + String(error?.message ?? error).slice(0, 300);
			store.finish({ runId, ok: false, summary: reason, blocked: { reason } }).catch(() => {});
			note(agent, "若水编排失败: " + reason);
		});
		return storeRun;
	}
}

function summarizeFlowResult(value) {
	const steps = Array.isArray(value.steps) ? value.steps : [];
	const done = steps.filter((s) => s && s.status === "done").length;
	return `流程 ${value.flowId || ""} 完成: ${done}/${steps.length} 步骤 done`;
}

function readSettings(ctx) {
	try {
		const settings = ctx.get("settings");
		return settings ? settings.get("rs-workflow") : undefined;
	} catch {
		return undefined;
	}
}

async function readSkill(ctx, name) {
	const skills = ctx.get("skills");
	if (!skills || typeof skills.get !== "function") return null;
	const skill = await skills.get(name);
	if (!skill) return null;
	// skills 服务返回形态:全文或 {content};两者皆容
	if (typeof skill === "string") return skill;
	if (typeof skill.content === "string") return skill.content;
	return null;
}

function readDocFile(workspace, path) {
	const full = resolve(workspace || process.cwd(), path);
	if (!existsSync(full)) return null;
	return readFileSync(full, "utf8");
}

async function resolveCwd(ctx, agent) {
	try {
		const sessionId = agent && agent.session ? String(agent.session.id || agent.id || "") : "";
		const sessionQuery = ctx.get("sessionQuery");
		if (sessionId && sessionQuery && typeof sessionQuery.listSessions === "function") {
			const records = await sessionQuery.listSessions();
			const hit = (records || []).find((item) => item && item.header && String(item.header.id) === sessionId);
			if (hit && hit.header && typeof hit.header.cwd === "string" && hit.header.cwd !== "") return hit.header.cwd;
		}
	} catch {
		// 会话服务缺失:回退进程目录
	}
	return process.cwd();
}

function resolveHome() {
	const fromEnv = process.env.DSH_HOME;
	return fromEnv && fromEnv.trim() !== "" ? resolve(fromEnv.trim()) : join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh");
}
