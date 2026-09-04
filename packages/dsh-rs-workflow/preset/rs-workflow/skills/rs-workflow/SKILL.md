---
name: rs-workflow
description: 若水多模型协作工作流。非平凡编码需求（多步骤/多文件/质量敏感/有回归风险）必须先加载本技能，按协议用 workflow 工具启动编排（planner 分诊规划 / executor 执行 / reviewer 审批，16 工作位，4 模板，预算化审批循环，升级重规划）。琐碎问答或用户明说"直接做"时不要加载。
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
- 用户想改角色模型/默认模板/预算 → 让用户在 GUI 设置页的 rs-workflow 段修改（改完即时生效）；GUI 不可用时才改 slots.json5。

## 2. 启动步骤（严格按序）

1. **读工作流配置**：调用 `rs_workflow_config` 工具，取回 `{ slots, workflow, budgets, source }`。它反映 GUI 设置页 rs-workflow 段的当前配置（3 基础+13 细分工作位模型绑定、默认模板、任务上限、预算）。工具不可用或 `source=fallback`（设置服务不可用）时，回退读本技能目录下的 `slots.json5`：JSON5 解析后**取其 `slots` 属性**作为下面的 `slots`（空字符串 = 未配置）；该后备文件只含 slots，此时 `defaultTemplate`/`limits`/`budgets` 一并省略，由引擎缺省值兜底。
2. **勘察仓库（可选）**：把与需求相关的要点（目录结构、相关文件、构建/测试命令）写进 `contextNotes`，不超过 30 行；已经熟悉仓库可传空字符串。
3. **读引擎脚本**：读本技能 Base directory 下 `references/engine.js` 的**全文**，作为 workflow 的 `script` 参数原样传入——不要改写、不要截断、不要"优化"。
4. **调用 workflow 工具**，三个参数：
   - `meta`：`{ name: "rs-workflow", description: "<一句话需求>", phases: [{title: "分诊与规划"}, {title: "执行与审批"}, {title: "升级重规划"}, {title: "汇总"}] }`
   - `script`：engine.js 全文
   - `args`：`{ request: <用户需求原话>, contextNotes: <第2步要点或空串>, slots: <第1步 slots，16 键>, lockedTemplate: <见下>, defaultTemplate: <见下>, limits: <见下>, budgets: <见下>, prefix: <见下> }`
     - `lockedTemplate`：仅用户点名了模板 → 传点名的；未点名省略，由引擎分诊定模板。
     - `defaultTemplate`：第 1 步 `workflow.defaultTemplate` 原值（`auto` 也照传，引擎自行兜底 multi-plan）。
     - `limits`：第 1 步 `workflow.maxTasks` 存在时传 `limits: { maxTasks: <值> }`。
     - `budgets`：第 1 步 `budgets` 原样透传（审批/重问预算，字段见 §6）。
     - 断点续跑（见 §4）：`prefix: <上轮已完成任务数组>`，元素取上轮返回 `tasks[]` 中 `status="done"` 且 `type="task"` 的 `{ id, description, output: <summary>, changedFiles }`（引擎返回的 tasks 字段名是 `summary`，映射为 prefix 元素的 `output`）；仅 lite / plan-final / step-review 生效，multi-plan 会忽略并记日志。
5. 工作流在前台运行到结束才返回，等待期间不做其他改动。

## 3. 汇报（工作流返回后，必做）

用中文向用户汇报，依次包含：

- 模板与难度分诊（complexity / risk / scope 三信号 + planner 理由；模板来源注明：引用返回 `templateSource` 字段——`locked`（用户/配置锁定）、`declared`（planner 声明采纳）、`matrix`（引擎矩阵裁定）、`default-fallback`（无信号兜底））；
- 每个任务的结果与执行摘要；
- 审批结论（计划审 / 逐步审 / 子计划审 / 终审 / 交叉终审链），逐项附：审批证据要点（reviewer 实际执行的检查与结果）、范围核查结果（是否发现申报清单外且不属于其他任务申报范围的越界文件）、审批者故障披露（引用返回 `reviews[].reviewerFault: true` 的条目——含义是引擎已把该审批按拒绝处理：审批者不可用或 APPROVED 缺证据预算耗尽折算，交付型可原样重交、计划型转计划重规划；leader 只披露，不自行重交）；multi-plan 模板按蓝图返回 `reviews`：大纲审（pr）→ 各子计划单元内逐步审（r-*）与子计划审（sr）→ 交叉终审串行链 xr1/xr2（均挂 `reviewer-cross` 位，xr1 审正确性、xr2 审边界与安全，xr2 依赖 xr1 通过，任一拒绝回跳最后一个已完成 task 重做后重挂）；blocked 时的返回中未运行到的审批 `verdict` 为 `UNREVIEWED`，如实报"未运行到"，不冒充通过或驳回；
- 变更文件清单；
- 升级重规划次数、换模型重做情况（slot 配了候选数组/rotation 时）、本次是否以 prefix 续跑及续跑任务数；blocked 时原因与建议（锁定更重的模板重跑 / 缩小需求范围 / 补充信息）。

汇报前运行一次仓库验证（构建/测试）确认工作区真实状态，再交用户验收。

## 4. 故障处置

- workflow 调用报错（脚本被杀 / caps 超限）：读错误信息；保存上一次返回的 `tasks` 与 `reviews`（必要时含 `blocked`），把 `tasks[]` 中 `status="done"` 且 `type="task"` 的条目按 §2 第 4 步的 prefix 契约整理为数组重新调用 workflow 续跑——不缩 maxTasks、不重做已完成工作；取不回上轮结果时降级为主代理直接实现，并向用户声明"工作流引擎故障，已降级直发"。
- 返回 `ok: false` 且 `blocked`：如实汇报，不粉饰；可按上一条以 prefix 续跑剩余工作，或缩小需求范围重跑。

## 5. 工作位（slot）降级链

3 基础位：`planner` / `executor` / `reviewer`。13 细分位未配置时降级到同域基础位，基础位未配置时降级到会话默认模型（细分位 → 基础位 → 会话默认模型）：

| 细分位 | 降级到 | 用途 |
|---|---|---|
| `planner-triage` | `planner` | 首次分诊：分析需求选模板拆任务（建议快而便宜的模型） |
| `planner-command` | `planner` | 总规划：制定整体方案 / 拆子计划大纲；计划被拒后的计划重写 |
| `planner-subplan` | `planner` | 子计划细化：子计划内的计划 |
| `planner-escalate` | `planner` | 升级重规划：连续拒绝超阈后的尾段重拆 / 返工重规划 |
| `reviewer-plan` | `reviewer` | 计划审批：审批计划文本（计划审 / 大纲审，中等推理即可） |
| `reviewer-task` | `reviewer` | 任务审批：审批单个任务执行结果 |
| `reviewer-subplan` | `reviewer` | 子计划交付审批：审批整个子计划交付 |
| `reviewer-final` | `reviewer` | 单终审：末尾终审全部交付（建议最强推理的模型） |
| `reviewer-cross` | `reviewer` | 交叉终审：多视角交叉终审链（建议最强推理的模型） |
| `executor-task` | `executor` | 任务首次执行 |
| `executor-enhance` | `executor` | 被拒重做：携带 REJECTED 理由修改重交（可配数组实现换模型重做） |
| `executor-retry` | `executor` | 失败重试：自报失败 / 无凭证后的重试 |
| `executor-escalate` | `executor` | 升级后执行：升级重规划产出的新任务 |

配好后引擎按节点语境自动选位：任务首执行=`executor-task`、被拒重做=`executor-enhance`、失败重试=`executor-retry`、升级新任务=`executor-escalate`、计划审=`reviewer-plan`、任务审=`reviewer-task`、子计划审=`reviewer-subplan`、终审=`reviewer-final`、交叉终审=`reviewer-cross`、分诊=`planner-triage`、计划重写=`planner-command`、子计划细化=`planner-subplan`、升级重规划=`planner-escalate`。

值格式：`"provider/model"` 字符串、候选数组 `["a/m1", "b/m2"]`、`{ rotation: ["a/m1", "b/m2"] }`（前三态与 GUI 设置 schema 一致）或 `{ provider, model }` 对象（引擎兼容形态，GUI 配置路径不可产出）：单候选/rotation 内失效时依次故障转移，被拒重做与审批重问从下一候选换模型（节点级游标轮换）。必须是当前部署模型路由里真实存在的目标。适配红线：reviewer 弱于 executor = 审批形同虚设。配置来源优先级：GUI 设置页 rs-workflow 段（`rs_workflow_config` 工具读取，即时生效）> 本技能目录 `slots.json5`（后备）> 会话默认模型。

## 6. 模板与阈值（细节见 references/templates.md）

| 模板 | 形态 |
|---|---|
| lite | 单发终审：单任务直干，末尾终审一次 |
| plan-final | 计划审 + 终审：前置总计划（pr 计划审通过才执行），末尾终审 |
| step-review | 计划审 + 逐步审：前置总计划（pr），每任务执行完即审，通过才放行下一步 |
| multi-plan | 大纲审 + 子计划审 + 交叉终审链：总规划拆子计划大纲（pr 大纲审），子计划单元逐个细化执行（子计划内逐步审 + 子计划交付审），末尾交叉终审串行链 xr1（正确性）→ xr2（边界与安全） |

阈值（budgets 四字段，GUI/slots.json5 可配，clamp [1,10]，缺省 2/2/3/3）：`reviewRejectBeforeEscalate`=2（交付型审批对象连续被拒或失败达此值 → 升级）、`planRejectBeforeBlocked`=2（计划型审批对象连续被拒达此值 → 升级）、`emptyOutputRetryLimit`=3（审批缺验证证据时的重问上限，超限视为拒绝）、`reportNudgeLimit`=3（executor 返回 completed 但交接摘要空白时的补救追问上限）；升级重规划累计 `ESCALATION_LIMIT`=**2** 次 → blocked（固定，不可配）。审批通过清零规则：交付类审批（逐步审/子计划审/终审/交叉终审）通过清零升级账，计划审批通过只放行不清零。审批 fail-closed：审批者不可用视为拒绝（交付型可原样重交，计划审/大纲审带此原因转计划重规划），APPROVED 必须附验证证据。

分诊口径：缺失信号按 low/small 降级（planner 未标注的信号视为不存在）；三信号全缺 → 按 `defaultTemplate` 兜底（`auto`/缺省 → multi-plan）；planner 可在计划中声明模板，合法才采纳，非法仍落引擎矩阵兜底。

拆解与审批基准：planner 拆解时每任务可带 acceptance（可独立验证的验收判据）与 files（预期触达文件，作范围核查申报基线），任务描述禁止占位措辞（TBD/"适当处理"/"同任务 N"式描述视为计划缺陷）；任务审批基准为可判定清单——只审本任务改动，每条判据须带可核证据（测试名/命令输出/file:line），不确定写明；审批结论可带 severity（critical/important/minor），仅丰富报告、不作通过门控（APPROVED/REJECTED + evidence 契约不变），critical 问题必须进 reasons；带 fixNote 的复审只判定驳回点是否解决与是否引入新问题，不扩大审查范围。

## 7. 庞大需求分阶段编排

单次 workflow 有规模上限（全局任务预算 `maxTasks` / 代理数 caps），超大需求不硬塞单次编排，改用分阶段协议：

- **触发**：分诊 `scope=large` 且拆解触达全局任务预算 `maxTasks`、上轮 blocked 且建议缩小范围，或用户明说"分阶段做"。
- **动作**：
  1. leader 先产出阶段大纲（把需求划分为若干可独立验收的 phase，每个 phase 一个明确目标与验收标准）；用 goal 工具（`create_goal`）把总目标固化为持久目标，由 goal 轮次自动续跑推进；
  2. 逐 phase 调用 workflow（§2 流程，`request` 写该 phase 的目标与验收标准，`contextNotes` 带上仓库要点与上一 phase 的产物摘要）；
  3. 每个 phase 返回后向用户简报该 phase 结果，goal 轮次自动续跑下一 phase；
  4. 某 phase blocked → 用 goal 工具如实标记 blocked（`update_goal`，附原因），带原因与建议，不缩小总目标范围。
- **注意**：多 phase 共享同一工作区，phase 划分必须文件域互斥或串行依赖明确；每 phase 用什么模板由该 phase 的分诊矩阵裁定，用户可点名。
