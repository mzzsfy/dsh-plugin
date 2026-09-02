/**
 * dsh-rs-workflow 独立冒烟测试：不启动 dsh，用最小 mock ctx 跑通三个行角色。
 *
 * 用法:
 *   node scripts/test-workflow-plugin.mjs [包目录]
 * 默认测已安装副本 (%USERPROFILE%\.dsh\profiles\web\node_modules\@mzzsfy\dsh-rs-workflow)，
 * 传参可测任意构建。注意：仓库 packages/ 副本解析不了 peer 依赖（@deepseek-ai/*
 * 从安装位置向上才找得到 profiles\node_modules），先安装再测，或自备 node_modules。
 *
 * 覆盖点：
 *   - 三个角色 + 非法 config 的 Config 校验（$.role required）
 *   - preset-sync 角色：syncPreset 被调用、mock ctx 日志路径
 *   - settings 角色：register 的命名空间/schema/base、schema 解析（默认值、base、user 层）、toJSON 可序列化
 *   - tool 角色：工具注册、execute 的 settings/fallback 两条路径、presentCall、output.render
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { homedir } from "node:os";

const argDir = process.argv[2];
const pkgDir = argDir
  ? resolve(argDir)
  : resolve(homedir(), ".dsh/profiles/web/node_modules/@mzzsfy/dsh-rs-workflow");
const mod = await import(pathToFileURL(resolve(pkgDir, "lib/index.js")).href);

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

/** 复刻 SettingsProvider.resolve 的分层：schema(mergeLayers(base, section))。 */
function mergeLayers(under, over) {
  if (over === undefined) return under;
  const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(under) || !isObj(over)) return over;
  const merged = { ...under };
  for (const [k, v] of Object.entries(over)) merged[k] = k in merged ? mergeLayers(merged[k], v) : v;
  return merged;
}

// ── 1. Config 校验 ──────────────────────────────────────────────────────────
console.log(`testing ${pkgDir}`);
const toolCfg = mod.Config({ role: "tool" });
check("Config({role:'tool'}) 通过", toolCfg.role === "tool");
check("Config 默认值：workflow.defaultTemplate=auto", toolCfg.workflow.defaultTemplate === "auto");
check("Config 默认值：workflow.maxTasks=8", toolCfg.workflow.maxTasks === 8);
check("Config 默认值：八个 slot 全空串", Object.values(toolCfg.slots).every((v) => v === ""));
let threw = false;
try { mod.Config({}); } catch { threw = true; }
check("Config 缺 role 抛错", threw);

// ── 2. settings 角色 ────────────────────────────────────────────────────────
let regArgs = null;
const settingsMock = {
  register(ns, schema, options) {
    regArgs = { ns, schema, base: options?.base };
    return {
      get: () => schema(mergeLayers(options?.base, undefined)),
    };
  },
};
const settingsCtx = {
  inject(deps, cb) {
    check("settings 角色 inject 依赖", JSON.stringify(deps) === JSON.stringify(["settings"]));
    cb({ settings: settingsMock });
  },
};
mod.apply(settingsCtx, { role: "settings", slots: { planner: "a/b" }, workflow: { defaultTemplate: "lite", maxTasks: 4 } });
check("register 命名空间 rs-workflow", regArgs?.ns === "rs-workflow");
check("base 层透传行 config", regArgs?.base?.slots?.planner === "a/b" && regArgs?.base?.workflow?.maxTasks === 4);
const resolved = regArgs.schema(mergeLayers(regArgs.base, { slots: { executor: "c/d" } }));
check("schema 解析：base + user 合并", resolved.slots.planner === "a/b" && resolved.slots.executor === "c/d");
check("schema 解析：未覆盖位仍取 base", resolved.slots.reviewer === "");
check("schema 解析：workflow 覆盖", resolved.workflow.defaultTemplate === "lite");
check("toJSON 可序列化（GUI describe 依赖）", typeof regArgs.schema.toJSON() === "object");

// ── 3. preset-sync 角色 ─────────────────────────────────────────────────────
// 用隔离的临时 DSH_HOME 走真实 syncPreset（写盘），验证幂等、created/updated 区分与外来目录防线。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const simHome = mkdtempSync(resolve(tmpdir(), "rs-workflow-smoke-"));
const savedDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = simHome;
try {
  const dest = resolve(simHome, ".agent-presets/rs-workflow");
  mod.apply({}, { role: "preset-sync" });
  check("preset-sync：首跑释放（created 路径生效）", existsSync(resolve(dest, "agent.cordis.yml")) && existsSync(resolve(dest, "skills/rs-workflow/references/engine.js")));
  check("preset-sync：marker 写入", existsSync(resolve(dest, ".dsh-rs-workflow-source.json")));

  // 幂等(非自证):重跑前埋哨兵文件,rewrite 的 rmSync 会删掉它;unchanged 时哨兵必须仍在
  writeFileSync(resolve(dest, "__sentinel__"), "x");
  const markerBefore = readFileSync(resolve(dest, ".dsh-rs-workflow-source.json"));
  mod.apply({}, { role: "preset-sync" });
  check("preset-sync：二次同步幂等（unchanged,哨兵存活）", readFileSync(resolve(dest, ".dsh-rs-workflow-source.json")).equals(markerBefore) && existsSync(resolve(dest, "__sentinel__")));

  // 快路径完整性：删掉释放物核心文件后应自动修复（updated 路径）
  rmSync(resolve(dest, "agent.cordis.yml"));
  mod.apply({}, { role: "preset-sync" });
  check("preset-sync：残缺自愈（updated）", existsSync(resolve(dest, "agent.cordis.yml")));

  // 所有权防线：无 marker 的外来目录必须原样保留
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(resolve(dest, "agent.cordis.yml"), "# user custom\n");
  const warns = [];
  const foreignCtx = { logger: { warn(msg) { warns.push(msg); } } };
  mod.apply(foreignCtx, { role: "preset-sync" });
  check("preset-sync：外来目录拒绝覆盖", readFileSync(resolve(dest, "agent.cordis.yml"), "utf8") === "# user custom\n");
  check("preset-sync：外来目录有告警", warns.length === 1);
} finally {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  rmSync(simHome, { recursive: true, force: true });
}

// ── 4. tool 角色 ────────────────────────────────────────────────────────────
let registered = null;
const resolvedValue = {
  slots: { planner: "x/y", executor: "", reviewer: "", "planner-triage": "", "reviewer-final": "", "executor-retry": "" },
  workflow: { defaultTemplate: "auto", maxTasks: 8 },
};
const toolCtx = {
  tools: { register(t) { registered = t; } },
  get(name) { return name === "settings" ? { get: () => resolvedValue } : undefined; },
};
mod.apply(toolCtx, { role: "tool" });
check("工具已注册", registered?.name === "rs_workflow_config");
check("presentCall 形状", registered.presentCall({}).card === "generic" && registered.presentCall({}).kind === "other");
const viaSettings = await registered.execute({});
check("execute：settings 路径", viaSettings.source === "settings" && viaSettings.slots.planner === "x/y");
check("output.render（settings）", JSON.stringify(registered.output.render({}, viaSettings)).includes("planner"));

const fallbackCtx = { tools: { register(t) { registered = t; } }, get: () => undefined };
mod.apply(fallbackCtx, { role: "tool" });
const viaFallback = await registered.execute({});
check("execute：fallback 路径", viaFallback.source === "fallback" && viaFallback.workflow.defaultTemplate === "auto");
check("output.render（fallback 附提示）", registered.output.render({}, viaFallback)[0].text.includes("设置服务不可用"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
