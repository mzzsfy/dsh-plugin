/**
 * rs-workflow 运行记录存储:host 半区(看板路由)与 tool 半区(rs_workflow_report)
 * 共用。两行角色位于同一宿主进程且经同一 junction realpath 解析到本模块,
 * Node 模块缓存按 realpath 去重,模块级单例即跨行共享的权威实例。
 *
 * 形态:内存数组为权威态,落盘为异步快照(临时文件 + rename 原子替换),
 * 写操作经 promise 链串行化,不产生并发交错。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const DATA_DIR_ENV = "DSH_RS_WORKFLOW_DATA_DIR";
const FILE_NAME = "runs.json";
const FORMAT_VERSION = 1;
// 单工作流规模上限:任务/审批/上报各几十条,64KB 足够并防异常调用撑爆文件
const RESULT_MAX_CHARS = 64 * 1024;
const UPDATES_MAX = 40;
const RUNS_MAX = 50;

export function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && override.trim() !== "") return override.trim();
  return join(homedir(), ".dsh", "dsh-rs-workflow");
}

function trimText(value, max) {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? text.slice(0, max) : text;
}

/** 运行记录归一:未知形态字段一律收敛到合法域,缺失置空(防御性归一化)。 */
function normalizeRun(input) {
  const body = input && typeof input === "object" ? input : {};
  return {
    runId: typeof body.runId === "string" && body.runId.trim() !== "" ? body.runId.trim() : "",
    workspace: typeof body.workspace === "string" ? body.workspace : "",
    request: typeof body.request === "string" ? body.request.slice(0, 2000) : "",
    templateId: typeof body.templateId === "string" ? body.templateId : "",
    status: body.status === "done" || body.status === "blocked" ? body.status : "running",
    startedAt: typeof body.startedAt === "number" ? body.startedAt : Date.now(),
    finishedAt: typeof body.finishedAt === "number" ? body.finishedAt : null,
    summary: typeof body.summary === "string" ? body.summary : "",
    blocked: body.blocked && typeof body.blocked === "object" ? body.blocked : null,
    stats: body.stats && typeof body.stats === "object" ? body.stats : null,
    result: body.result && typeof body.result === "object" ? body.result : null,
    updates: Array.isArray(body.updates) ? body.updates.slice(-UPDATES_MAX) : [],
  };
}

let singleton = null;

export function reportStore() {
  if (singleton) return singleton;
  singleton = createStore({ dir: resolveDataDir() });
  return singleton;
}

export function createStore({ dir }) {
  const file = join(dir, FILE_NAME);
  let runs = [];
  let loaded = false;
  // 落盘串行链:写操作排队执行,前序失败不断链
  let writeChain = Promise.resolve();

  function persist() {
    const task = writeChain.then(async () => {
      await mkdir(dir, { recursive: true });
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify({ version: FORMAT_VERSION, runs }), "utf8");
      await rename(tmp, file);
    });
    // 落盘失败不回滚内存态(内存为权威),只断尾防止未处理拒绝告警
    writeChain = task.catch(() => {});
    return task;
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.runs)) {
        runs = parsed.runs.map(normalizeRun).filter((run) => run.runId !== "");
      }
    } catch {
      // 首次启动无文件/损坏文件:从空表开始,不阻塞写入
      runs = [];
    }
  }

  function upsert(run) {
    const index = runs.findIndex((item) => item.runId === run.runId);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    // 容量收敛:超限时先淘汰最早的已完结运行,无已完结再淘汰最早运行
    while (runs.length > RUNS_MAX) {
      const finishedIndex = runs.findIndex((item) => item.status !== "running");
      runs.splice(finishedIndex >= 0 ? finishedIndex : 0, 1);
    }
  }

  function statsOf(result) {
    if (!result || typeof result !== "object") return null;
    const tasks = Array.isArray(result.tasks) ? result.tasks.length : 0;
    const reviews = Array.isArray(result.reviews) ? result.reviews.length : 0;
    const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles.length : 0;
    const escalations = typeof result.escalations === "number" ? result.escalations : 0;
    return { tasks, reviews, changedFiles, escalations };
  }

  return {
    async list({ withBody = false } = {}) {
      await ensureLoaded();
      return runs
        .map((run) => (withBody ? run : { ...run, updates: undefined, result: undefined }))
        .reverse();
    },
    async get(runId) {
      await ensureLoaded();
      return runs.find((run) => run.runId === runId) || null;
    },
    async start({ runId, workspace, request, templateId }) {
      await ensureLoaded();
      const id = typeof runId === "string" && runId.trim() !== "" ? runId.trim() : "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const run = normalizeRun({ runId: id, workspace, request, templateId, startedAt: Date.now(), status: "running" });
      upsert(run);
      await persist();
      return run;
    },
    async appendNode({ runId, nodeId, status, summary }) {
      await ensureLoaded();
      const run = runs.find((item) => item.runId === runId);
      if (!run) throw new Error("运行记录不存在:" + runId);
      run.updates.push({ at: Date.now(), nodeId: String(nodeId || "").slice(0, 64), status: String(status || "").slice(0, 24), summary: trimText(summary, 500) });
      if (run.updates.length > UPDATES_MAX) run.updates.splice(0, run.updates.length - UPDATES_MAX);
      await persist();
      return run;
    },
    async finish({ runId, ok, result, summary, blocked }) {
      await ensureLoaded();
      const run = runs.find((item) => item.runId === runId);
      if (!run) throw new Error("运行记录不存在:" + runId);
      run.status = ok === true ? "done" : "blocked";
      run.finishedAt = Date.now();
      run.summary = trimText(summary, 2000);
      run.blocked = blocked && typeof blocked === "object" ? blocked : run.blocked;
      if (result && typeof result === "object") {
        // result 原样留档但限长:序列化超限即整体弃为摘要,防异常产出撑爆文件
        const encoded = JSON.stringify(result);
        run.result = encoded.length <= RESULT_MAX_CHARS ? result : { truncated: true, templateId: result.templateId };
        run.templateId = typeof result.templateId === "string" ? result.templateId : run.templateId;
      }
      run.stats = statsOf(result);
      await persist();
      return run;
    },
    async remove(runId) {
      await ensureLoaded();
      const keep = runId ? runs.filter((run) => run.runId !== runId) : [];
      const changed = keep.length !== runs.length;
      runs = runId ? keep : [];
      if (changed || !runId) await persist();
      return changed || !runId;
    },
  };
}
