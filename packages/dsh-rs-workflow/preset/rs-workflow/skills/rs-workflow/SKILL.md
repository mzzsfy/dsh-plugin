---
name: rs-workflow
description: 若水多模型协作工作流。非平凡编码需求（多步骤/多文件/质量敏感/有回归风险）必须先加载本技能，按协议用 workflow 工具启动编排（planner 分诊规划 / executor 执行 / reviewer 审批，4 模板，审批循环，升级重规划）。琐碎问答或用户明说"直接做"时不要加载。
---

# 若水工作流 (rs-workflow)

迁移自 rs-tui 的多模型协作工作流引擎。三角色分工：**planner** 规划分诊、**executor** 执行、**reviewer** 审批；引擎按模板蓝图调度 DAG 节点，审批循环与升级重规划由脚本保证。

## 0. 职责边界（必读）

你是主代理（leader），**不亲自执行工作流内的任务**。你只负责四件事：

1. 判定是否进入工作流；
2. 调用 rs_workflow_config 工具读取工作位（slot）与工作流默认配置；
3. 用 workflow 工具启动编排脚本；
4. 向用户汇报结果。

执行、审批、规划全部由编排内的子代理完成。你不在工作流运行期间并行改动代码。

## 1. 进入判定

- **直接处理（off 态）**：纯问答/解释；用户明说"直接做/别走流程"；单文件、无风险的小改。
- **进入工作流**：其余编码需求——多文件、多步骤、质量敏感、有回归风险、需要先规划的任务。
- 用户点名模板（lite / plan-final / step-review / multi-plan）→ 作为 `lockedTemplate` 传入；未点名 → 由 planner 分诊选模板。
- 用户想改角色模型/默认模板 → 让用户在 GUI 设置页的 rs-workflow 段修改（改完即时生效）；GUI 不可用时才改 slots.json5。

## 2. 启动步骤（严格按序）

1. **读工作流配置**：调用 `rs_workflow_config` 工具，取回 `{ slots, workflow, source }`。它反映 GUI 设置页 rs-workflow 段的当前配置（各工作位模型绑定、默认模板、任务上限）。工具不可用或 `source=fallback`（设置服务不可用）时，回退读本技能目录下的 `slots.json5`：JSON5 解析后**取其 `slots` 属性**作为下面的 `slots`（空字符串 = 未配置）。
2. **勘察仓库（可选）**：把与需求相关的要点（目录结构、相关文件、构建/测试命令）写进 `contextNotes`，不超过 30 行；已经熟悉仓库可传空字符串。
3. **读引擎脚本**：读本技能 Base directory 下 `references/engine.js` 的**全文**，作为 workflow 的 `script` 参数原样传入——不要改写、不要截断、不要"优化"。
4. **调用 workflow 工具**，三个参数：
   - `meta`：`{ name: "rs-workflow", description: "<一句话需求>", phases: [{title: "分诊与规划"}, {title: "执行与审批"}, {title: "升级重规划"}, {title: "汇总"}] }`
   - `script`：engine.js 全文
   - `args`：`{ request: <用户需求原话>, contextNotes: <第2步要点或空串>, slots: <第1步 slots>, lockedTemplate: <见下> }`
     - `lockedTemplate`：用户点名了模板 → 用点名的；否则第 1 步 `workflow.defaultTemplate` 非 `auto` → 用它；`auto` → 省略，由引擎分诊矩阵定模板。
     - 第 1 步 `workflow.maxTasks` 存在时并入 args：`limits: { maxTasks: <值> }`。
     - 断点续跑（见 §4）：`prefix: <上轮已完成任务数组>`，元素取上轮返回 `tasks[]` 中 `status="done"` 且 `type="task"` 的 `{ id, description, output: <summary>, changedFiles }`（引擎返回的 tasks 字段名是 `summary`，映射为 prefix 元素的 `output`）；仅 lite / plan-final / step-review 生效，multi-plan 会忽略并记日志。
5. 工作流在前台运行到结束才返回，等待期间不做其他改动。

## 3. 汇报（工作流返回后，必做）

用中文向用户汇报，依次包含：

- 模板与难度分诊（complexity / risk / scope 三信号 + planner 理由；模板来源注明：引擎矩阵裁定，或用户/配置锁定）；
- 每个任务的结果与执行摘要；
- 审批结论（计划审 / 逐步审 / 子计划审 / 终审，含交叉终审两个结论），逐项附：审批证据要点（reviewer 实际执行的检查与结果）、范围核查结果（是否发现申报清单外且不属于其他任务申报范围的越界文件）、审批者故障披露（引用返回 `reviews[].reviewerFault: true` 的条目——含义是引擎在审批者不可用时已按拒绝处理并原样重交，leader 只披露，不自行重交）；blocked 时的返回中未运行到的审批 `verdict` 为 `UNREVIEWED`，如实报"未运行到"，不冒充通过或驳回；
- 变更文件清单；
- 升级重规划次数、换模型重做情况（slot 配了候选数组时）、本次是否以 prefix 续跑及续跑任务数；blocked 时原因与建议（锁定更重的模板重跑 / 缩小需求范围 / 补充信息）。

汇报前运行一次仓库验证（构建/测试）确认工作区真实状态，再交用户验收。

## 4. 故障处置

- workflow 调用报错（脚本被杀 / caps 超限）：读错误信息；保存上一次返回的 `tasks` 与 `reviews`（必要时含 `blocked`），把 `tasks[]` 中 `status="done"` 且 `type="task"` 的条目按 §2 第 4 步的 prefix 契约整理为数组重新调用 workflow 续跑——不缩 maxTasks、不重做已完成工作；取不回上轮结果时降级为主代理直接实现，并向用户声明"工作流引擎故障，已降级直发"。
- 返回 `ok: false` 且 `blocked`：如实汇报，不粉饰；可按上一条以 prefix 续跑剩余工作，或缩小需求范围重跑。

## 5. 工作位（slot）降级链

细分位 → 基础位 → 会话默认模型：

| 细分位 | 降级到 | 用途 |
|---|---|---|
| `planner-triage` | `planner` | 启动时分诊 + 拆解（建议快而便宜的模型） |
| `planner-escalate` | `planner` | 升级重规划 / 返工 / 计划重规划 |
| `reviewer-final` | `reviewer` | 终审 / 交叉终审 A 位（建议最强推理的模型） |
| `reviewer-plan` | `reviewer` | 计划审批（plan-final 的 pr 节点，中等推理即可） |
| `executor-retry` | `executor` | 被驳回后的返工执行（可配数组实现换模型重做） |

值格式 `"provider/model"`、`{ provider, model }`（两者可只给其一）或候选数组 `["a/m1", "b/m2"]`：单候选失效时依次故障转移，被拒重做与审批重问从下一候选换模型（节点级轮换）。必须是当前部署模型路由里真实存在的目标。适配红线：reviewer 弱于 executor = 审批形同虚设。配置来源优先级：GUI 设置页 rs-workflow 段（`rs_workflow_config` 工具读取，即时生效）> 本技能目录 `slots.json5`（后备）> 会话默认模型。

## 6. 模板与阈值（细节见 references/templates.md）

| 模板 | 形态 |
|---|---|
| lite | 单任务直干，终审一次 |
| plan-final | 前置总计划 + 计划审批（pr 节点），通过后执行，末尾终审；计划被拒 → 计升级账并带意见重规划重建任务段 |
| step-review | 前置总计划，每任务执行完即审，审批通过才放行下一步 |
| multi-plan | 总规划拆子计划逐个动态生成，子计划内逐步审 + 子计划审，末尾双审交叉终审 |

阈值：被审对象连续 **2** 次被拒/失败 → 升级重规划（尾段重建 / 返工任务）；重规划累计 **2** 次 → blocked；非 overall 审批通过时升级账清零。审批 fail-closed：审批者不可用视为拒绝（可原样重交），APPROVED 必须附验证证据。模板由引擎分诊矩阵按三信号确定，planner 不自选。

## 7. 庞大需求分阶段编排

单次 workflow 有规模上限（任务数 / 子计划数 / 代理数 caps），超大需求不硬塞单次编排，改用分阶段协议：

- **触发**：分诊 `scope=high` 且子计划触顶、拆解触达 `maxTasks` 上限、上轮 blocked 且建议缩小范围，或用户明说"分阶段做"。
- **动作**：
  1. leader 先产出阶段大纲（把需求划分为若干可独立验收的 phase，每个 phase 一个明确目标与验收标准）；用 goal 工具（`create_goal`）把总目标固化为持久目标，由 goal 轮次自动续跑推进；
  2. 逐 phase 调用 workflow（§2 流程，`request` 写该 phase 的目标与验收标准，`contextNotes` 带上仓库要点与上一 phase 的产物摘要）；
  3. 每个 phase 返回后向用户简报该 phase 结果，goal 轮次自动续跑下一 phase；
  4. 某 phase blocked → 用 goal 工具如实标记 blocked（`update_goal`，附原因），带原因与建议，不缩小总目标范围。
- **注意**：多 phase 共享同一工作区，phase 划分必须文件域互斥或串行依赖明确；每 phase 用什么模板由该 phase 的分诊矩阵裁定，用户可点名。
