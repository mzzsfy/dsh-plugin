/**
 * dsh-rs-workflow 独立冒烟测试：不启动 dsh，用最小 mock ctx 跑通全部行角色。
 *
 * 用法:
 *   node scripts/test-workflow-plugin.mjs [包目录]
 * 默认测已安装副本 (%USERPROFILE%\.dsh\profiles\web\node_modules\@mzzsfy\dsh-rs-workflow)，
 * 传参可测任意构建。注意：仓库 packages/ 副本解析不了 peer 依赖（@deepseek-ai/*
 * 从安装位置向上才找得到 profiles\node_modules），先安装再测，或自备 node_modules。
 *
 * 覆盖点：
 *   - 六个角色 + 非法 config 的 Config 校验（$.role required、maxTasks/budgets 边界、非法 role）
 *   - settings 角色：register 命名空间/schema/base、schema 解析、toJSON
 *   - preset-sync 角色：collab 释放幂等/自愈/外来防线；流程模板释放产物与所有权防线
 *   - board 角色：runs/templates/spec 路由注册
 *   - template-tool 角色：spec/list/save(+release)/remove 全链
 *   - report 角色：工具注册与 node 软上报
 *   - takeover 角色：pre-step 拦截注册（workflowEngine 注入依赖声明）
 */
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
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
const cfg = mod.Config({ role: "settings" });
check("Config 默认值：workflow.defaultTemplate=auto", cfg.workflow.defaultTemplate === "auto");
check("Config 默认值：workflow.maxTasks=8", cfg.workflow.maxTasks === 8);
check("Config 默认值：16 个 slot 全空串", Object.values(cfg.slots).every((v) => v === "") && Object.keys(cfg.slots).length === 16);
check("Config 默认值：budgets 四阈值 2/2/3/3", cfg.budgets.reviewRejectBeforeEscalate === 2 && cfg.budgets.planRejectBeforeBlocked === 2 && cfg.budgets.emptyOutputRetryLimit === 3 && cfg.budgets.reportNudgeLimit === 3);
check("Config 默认值：templates 空数组", Array.isArray(cfg.templates) && cfg.templates.length === 0);
let threw = false;
try { mod.Config({}); } catch { threw = true; }
check("Config 缺 role 抛错", threw);
threw = false;
try { mod.Config({ role: "tool-x" }); } catch { threw = true; }
check("Config 非法 role 抛错", threw);
threw = false;
try { mod.Config({ role: "settings", workflow: { maxTasks: 0 } }); } catch { threw = true; }
check("Config maxTasks=0 抛错(schema 边界)", threw);
threw = false;
try { mod.Config({ role: "settings", budgets: { reviewRejectBeforeEscalate: 11 } }); } catch { threw = true; }
check("Config budgets 越界抛错", threw);

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

// ── 3. preset-sync 角色(collab + 流程模板释放) ───────────────────────────────
// 用隔离的临时 DSH_HOME 走真实 syncPreset/releaseFlowTemplate(写盘)。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const simHome = mkdtempSync(resolve(tmpdir(), "rs-workflow-smoke-"));
const savedDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = simHome;
const NEWS_FLOW = `{
  id: "news", label: "新闻生产", description: "收集信息交叉核对后成稿",
  steps: [
    { id: "plan", prompt: "定计划", outputs: { keywords: "关键词" } },
    { id: "write", prompt: "成稿 {plan.keywords}", outputs: { article: "稿件" } },
  ],
}`;
try {
  const dest = resolve(simHome, ".agent-presets/rs-workflow");
  mod.apply({}, { role: "preset-sync" });
  check("preset-sync：首跑释放(产物=collab 组合,无技能目录)", existsSync(resolve(dest, "agent.cordis.yml")) && !existsSync(resolve(dest, "skills")));
  check("preset-sync：marker 写入", existsSync(resolve(dest, ".dsh-rs-workflow-source.json")));

  // 幂等(非自证):重跑前埋哨兵文件,rewrite 会删掉它;unchanged 时哨兵必须仍在
  writeFileSync(resolve(dest, "__sentinel__"), "x");
  const markerBefore = readFileSync(resolve(dest, ".dsh-rs-workflow-source.json"));
  mod.apply({}, { role: "preset-sync" });
  check("preset-sync：二次同步幂等（unchanged,哨兵存活）", readFileSync(resolve(dest, ".dsh-rs-workflow-source.json")).equals(markerBefore) && existsSync(resolve(dest, "__sentinel__")));

  // 残缺自愈:删掉任一受管文件后应自动修复(updated 路径)
  rmSync(resolve(dest, "__sentinel__"), { force: true });
  rmSync(resolve(dest, "agent.cordis.yml"));
  mod.apply({}, { role: "preset-sync" });
  check("preset-sync：残缺自愈（updated）", existsSync(resolve(dest, "agent.cordis.yml")));

  // 所有权防线:无 marker 的外来目录必须原样保留
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(resolve(dest, "agent.cordis.yml"), "# user custom\n");
  const warns = [];
  const foreignCtx = { logger: { warn(msg) { warns.push(msg); } } };
  mod.apply(foreignCtx, { role: "preset-sync" });
  check("preset-sync：外来目录拒绝覆盖", readFileSync(resolve(dest, "agent.cordis.yml"), "utf8") === "# user custom\n");
  check("preset-sync：外来目录有告警", warns.length === 1);

  // 流程模板释放:releaseFlowTemplate 产物 + takeover/report 行 + 所有权防线
  mod.releaseFlowTemplate({ id: "news", label: "新闻生产", description: "收集成稿", json5: NEWS_FLOW });
  const flowDest = resolve(simHome, ".agent-presets/rs-news");
  const flowYaml = readFileSync(resolve(flowDest, "agent.cordis.yml"), "utf8");
  check("release：产物齐全", existsSync(resolve(flowDest, "flow.json5")) && existsSync(resolve(flowDest, "preset.yml")));
  check("release：组合含 takeover+report 行", flowYaml.includes("role: takeover") && flowYaml.includes("role: report"));
  check("release：flow.json5 经 baseUrl 锚定", flowYaml.includes("flowFile:"));
  check("release：delegation 组 isolate workflowEngine", flowYaml.includes("workflowEngine: true"));
  let threwRelease = false;
  try { mod.releaseFlowTemplate({ id: "news", label: "n", json5: "{ not json5:" }); } catch { threwRelease = true; }
  check("release：非法定义拒绝", threwRelease);
  check("unrelease：撤下", mod.unreleaseFlowTemplate("news") === "removed");
} finally {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  rmSync(simHome, { recursive: true, force: true });
}

// ── 4. board 角色 ───────────────────────────────────────────────────────────
{
  const routes = new Set();
  mod.apply({ inject(deps, cb) { cb({ webServer: { register(r) { routes.add(r.path); } }, effect(fn) { fn(); } }); }, effect(fn) { fn(); } }, { role: "board" });
  check("board：runs/run/remove 路由", ["runs", "run", "remove"].every((p) => routes.has(`/api/rs-workflow/${p}`)));
  check("board：templates/spec/release/unrelease/template-save/template-remove 路由", ["templates", "spec", "release", "unrelease", "template-save", "template-remove"].every((p) => routes.has(`/api/rs-workflow/${p}`)));
}

// ── 5. template-tool 角色 ───────────────────────────────────────────────────
{
  const simHome2 = mkdtempSync(resolve(tmpdir(), "rs-workflow-smoke2-"));
  const savedHome2 = process.env.DSH_HOME;
  process.env.DSH_HOME = simHome2;
  try {
    const settingsValue = { templates: [] };
    let registeredTool = null;
    const toolCtx = {
      get(name) { return name === "settings" ? { get: () => settingsValue, update(ns, patch) { Object.assign(settingsValue, patch); return Promise.resolve(); } } : undefined; },
      inject(deps, cb) {
        check("template-tool 角色 inject 依赖", JSON.stringify(deps) === JSON.stringify(["tools"]));
        cb({
          effect(fn) { fn(); },
          tools: { register(t) { registeredTool = t; } },
        });
      },
    };
    mod.apply(toolCtx, { role: "template-tool" });
    check("template-tool：工具已注册", registeredTool?.name === "rs_workflow_template");
    check("presentCall 形状", registeredTool.presentCall({ action: "spec" }).card === "generic" && registeredTool.presentCall({ action: "spec" }).kind === "other");
    const spec = await registeredTool.execute({ action: "spec" });
    check("spec：返回规范全文", spec.ok === true && spec.spec.includes("产出契约"));
    const saved = await registeredTool.execute({ action: "save", release: true, template: { id: "news", label: "新闻", json5: NEWS_FLOW } });
    check("save：保存并释放", saved.ok === true && saved.released === true && settingsValue.templates.length === 1);
    check("save：释放目录落盘", existsSync(join(simHome2, ".agent-presets", "rs-news", "flow.json5")));
    const removed = await registeredTool.execute({ action: "remove", id: "news" });
    check("remove：删除并撤下", removed.ok === true && settingsValue.templates.length === 0 && !existsSync(join(simHome2, ".agent-presets", "rs-news")));
  } finally {
    if (savedHome2 === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome2;
    rmSync(simHome2, { recursive: true, force: true });
  }
}

// ── 6. report 角色 ──────────────────────────────────────────────────────────
{
  let registeredReport = null;
  const reportCtx = {
    inject(deps, cb) {
      cb({ tools: { register(t) { registeredReport = t; } }, get: () => undefined });
    },
  };
  mod.apply(reportCtx, { role: "report" });
  check("report：工具已注册", registeredReport?.name === "rs_workflow_report");
  const listed = await registeredReport.execute({ action: "list" }, {});
  check("report：list 可用", listed.ok === true && Array.isArray(listed.runs));
}

// ── 7. takeover 角色(pre-step 拦截注册) ──────────────────────────────────────
{
  let engineDepsDeclared = false;
  let preStepRegistered = false;
  const takeoverCtx = {
    get: () => undefined,
    effect(fn) { fn(); },
    on(name) { if (name === "agent/pre-step") preStepRegistered = true; return () => {}; },
    inject(deps, cb) {
      if (deps.includes("workflowEngine")) engineDepsDeclared = true;
      cb({ workflowEngine: { start() { throw new Error("注册期不应启动"); } } });
    },
  };
  mod.apply(takeoverCtx, { role: "takeover", kind: "collab" });
  check("takeover：workflowEngine inject 依赖声明", engineDepsDeclared);
  check("takeover：agent/pre-step 拦截已注册", preStepRegistered);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
