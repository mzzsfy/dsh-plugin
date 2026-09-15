/**
 * builtin-templates — 包内内置流程模板(novel 小说 / news 新闻 / default 通用默认)。
 *
 * 唯一真相源是包内 flows/*.json5;本模块在包加载时读盘解析并缓存。
 * 消费:settings base 的 templates 数组默认值(开箱即得;用户改动后以用户态为准)。
 * 校验失败不让包整体加载失败:损坏文件跳过并保留其余(容错与 preset 同步一致)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { validateFlow } from "./flows.mjs";

const FLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "flows");

let cached = null;

/** 解析包内全部内置模板;解析/校验失败的文件跳过(启动日志可见性由调用方负责)。
 *  返回 settings templates 条目数组(id/label/description/enabled/json5)。 */
export function builtinTemplates() {
	if (cached) return cached;
	const items = [];
	if (existsSync(FLOWS_DIR)) {
		for (const name of readdirSync(FLOWS_DIR)) {
			if (!name.endsWith(".json5")) continue;
			try {
				const json5 = readFileSync(join(FLOWS_DIR, name), "utf8");
				const flow = JSON5.parse(json5);
				const errors = validateFlow(flow);
				if (errors.length > 0) throw new Error(errors.join("; "));
				items.push({
					id: flow.id,
					label: typeof flow.label === "string" ? flow.label : flow.id,
					description: typeof flow.description === "string" ? flow.description : "",
					enabled: true,
					json5,
				});
			} catch {
				// 残缺内置模板跳过,不影响其余与包加载
			}
		}
	}
	cached = items;
	return items;
}

/** id 是否命中内置模板(UI 分组「内置/自定义」的判定源)。 */
export function isBuiltinTemplate(id) {
	return builtinTemplates().some((t) => t.id === id);
}
