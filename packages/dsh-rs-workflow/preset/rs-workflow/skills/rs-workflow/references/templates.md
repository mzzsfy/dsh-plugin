# rs-workflow 模板蓝图与引擎映射

出处：rs-tui `docs/rs-tui/feat/dynamic-workflow.md` 与 `feat/templates.md`（难度分诊 4 模板、树唯一真相源）。本文档是 v1 迁移版的设计对照；引擎实现在 `references/engine.js`。

## 1. 难度分诊（引擎确定性矩阵）

三信号：**complexity**（改动面/步骤数）、**risk**（破坏面/回归风险）、**scope**（涉及模块/功能数）。planner 只产出三信号、计划与任务拆解（multi-plan 场景另产出子计划大纲），**模板由引擎矩阵决定，planner 不自选**（弱模型不可信，自选字段已从 schema 移除）：

| 判定顺序 | 条件 | 模板 | 用户感知 |
|---|---|---|---|
| 1 | risk=high 或 scope=high | multi-plan | 多子计划逐个干，交叉终审 |
| 2 | complexity=high | step-review | 干一步审一步 |
| 3 | complexity=medium 或 risk=medium | plan-final | 先计划（计划审 pr），通过后执行，干完终审 |
| 4 | 其余（complexity=low 且 risk=low，scope 不为 high 即可） | lite | 单任务直干，终审一次 |

缺失信号按 medium 计；planner 不可用时规则兜底为单任务 plan-final。用户锁定模板（lockedTemplate）时跳过矩阵直接实例化。判定顺序与原版 `selectTemplate` 确定性对齐（差异仅在缺失信号的取值口径，见 §5）。

## 2. 四模板拓扑

```
lite          t1 ──→ fr(终审)

plan-final    pr(计划审) → t1 → t2 → … → tn ──→ fr(终审)   (t 间依赖由 planner 声明, 无依赖可并行;
              pr 拒绝 → 计升级账 + 带驳回意见重规划重建任务段, pr 复审新计划; 达升级上限 → blocked)

step-review   t1 → r1(审) → t2 → r2(审) → …        (每任务后跟审批, 通过才放行后继)

multi-plan    p1 → [p1 子任务逐步审] → sr1(子计划审)
              p2 → [p2 子任务逐步审] → sr2          (p 间依赖由大纲声明)
              sr1, sr2 … ──→ xr1 ∥ xr2(双审交叉终审, 都通过才算过)
```

- 依赖省略 = 链式接续前一个任务（rs-tui 规划协议语义）。
- 并行任务必须文件互不相交；有冲突风险必须声明依赖串行。
- multi-plan 子计划任务在运行时由 planner 子计划节点动态产出（原版 `appendSubtree` 语义）；子计划大纲数上限 4（MAX_SUBPLANS），单子计划任务数上限 4，缺子计划大纲时降级 step-review（有任务）或 lite（无任务）。
- pr（计划审）挂 `reviewer-plan` 位，审批对象 = 计划文本（可执行性/粒度/依赖/文件互斥），对齐原版 plan-final 蓝图的 planReview 节点。

## 3. 审批循环与升级

| 常量 | 值 | 语义 |
|---|---|---|
| REJECT_BEFORE_ESCALATE | 2 | task 主体连续 2 次失败（审批被拒 / 自报失败 / executor 调用失败各计 1）→ 升级重规划（尾段替换） |
| ESCALATION_LIMIT | 2 | 升级重规划累计 2 次 → blocked 终态 |
| MAX_TASKS | 8 | 单轮拆解任务上限（DSH 新增约束，非原版阈值；可经 `args.limits.maxTasks` 覆盖；超大需求由分阶段承接） |
| 调度预算 | 8 + (节点数 + 全程累计升级次数×每次升级最大新增任务数) × 3/轮 | 按当前图规模与全程累计升级次数（不随审批通过清零）现算，大图与振荡兜底 |

两条驳回路由（不对称，勿混）：

- **task 主体**（逐步审 r-*）：failCount 挂 task 节点，被拒/自报失败/调用失败各 +1，审批通过清零（同时升级账清零）；未达阈值 → 原任务带驳回意见重试（`executor-retry` 位，slot 配候选数组时换模型重做）；达阈值 → **尾段替换**——从失败节点可达的未完成节点废弃，planner 重规划剩余任务接在前缀之后，**并按模板重建蓝图**：lite/plan-final 重建终审 fr（依赖含新任务段与 prefix 种子），step-review/multi-plan 新任务链式配对 r-\* 审批，multi-plan 被波及的子计划审 sr 与交叉终审 xr 随新任务段重建。
- **聚合主体**（计划审 pr / 子计划审 sr / 终审 fr / 交叉终审 xr）：无 2 次阈值，首次被拒即消耗 1 次升级账并触发返工重规划——pr 走计划重规划（重建任务段，终审随段重建），sr/fr/xr 走返工重挂（追加返工任务、审批重挂到返工之后）；升级账达 ESCALATION_LIMIT → blocked。
- 非 overall 主体的审批通过时升级账清零（escalations=0，pr 通过同享），防长工作流历史累计误判 blocked。
- **审批证据契约**：APPROVED 必须附 `evidence`（实际执行的检查命令与结果要点）；空证据重问一次，仍空 → 降级 REJECTED（可补证据后原样重交）。
- **审批 fail-closed**：审批者子代理调用失败 → 候选轮换重试一次，仍失败**视为拒绝**（reviewerFault），理由固定"审批者不可用(视为拒绝), 可原样重交"，走既有驳回路由；不存在"警告通过"。
- **范围核查**：reviewer/终审提示词含强制规则——实际变更（git diff/status）出现申报清单之外且不属于其他任务申报范围（豁免清单）的文件 → REJECTED 并点名越界文件；豁免清单仅 task 主体审批注入，终审无豁免、仍按各任务申报并集与全量变更比对。blocked 时未运行到的审批返回 `verdict=UNREVIEWED`（如实区分，不冒充 REJECTED）。

## 4. 交接摘要（原版 context-bridge 语义）

执行/审批/子计划生成/任务级升级重规划的提示词经 `handoff()` 组装：原始需求、总计划（PLAN_TEXT，截断 1500 字）、已完成节点摘要（id + 描述 + 输出前 400 字，**不含变更文件**；含 prefix 种子节点）、附加段（驳回意见等）、当前任务。分诊 planner 无 handoff，但带 prefix 时注入"【已完成工作(断点续跑,禁止重复规划)】"清单；返工与计划重规划提示词改带"原始需求 + 驳回原因 + 已完成摘要"（不含总计划）；变更文件仅在审批提示词出现（本任务申报字段 + 非本任务范围的豁免清单）。对应原版"隐藏 custom 通道注入交接上下文"；v1 无隐藏通道，直接拼入提示词。

断点续跑近似：`args.prefix`（上轮已完成任务 `{id, description, output, changedFiles}`）在实例化前种为已完成任务节点（id 加 `x` 前缀防撞），进入交接摘要与分诊提示词；与种子同描述的新任务在实例化时强制剔除（续跑不重做的机器兜底）；lite / plan-final 的终审依赖含种子节点，step-review 无终审节点；multi-plan 忽略并记日志。

## 5. v1 与原版的差异（如实声明）

| 原版 | v1 迁移版 |
|---|---|
| Pi Extension 常驻引擎，树经 entry 持久化，session 可恢复续跑 | workflow 脚本单次前台运行；断点续跑为 **prefix 种子近似**（task 级模板），真·快照恢复无对应物（平台限制） |
| 节点树唯一真相源 + 通用遍历器 | 同构 DAG 调度循环 + 模板蓝图构建，语义对齐、实现收敛 |
| 隐藏 custom 通道交接 | 交接摘要拼入子代理提示词 |
| 模板可目录发现自定义扩展 | 固定 4 模板（用户决策：不做扩展机制） |
| TUI 快捷键锁定模板/开关工作流 | 会话内自然语言锁定模板；off 态 = 主代理直接处理 |
| 14 细分工作位 + 3 基础工作位 + rotation/能力池 | 3 基础工作位（planner/executor/reviewer）+ 5 细分位（planner-triage/planner-escalate/reviewer-final/reviewer-plan/executor-retry），值支持候选数组实现 failover + 换模型重做（节点级游标轮换）；原版跨调用的 round-robin rotation 与能力池不做（用户决策，"不做"仅指该全局轮换，候选内游标轮换保留） |
| 分诊矩阵（selectTemplate，无信号 → 保守 fallback multi-plan，缺失信号按低/小降级） | 引擎确定性矩阵已对齐判定顺序；差异仅口径：缺失信号按 medium 计、planner 全挂兜底单任务 plan-final |
| 角色工具硬拦截（工具面随角色收敛）/ permission-guard 底线集 / guardian 二审 | 平台限制（workflow agent() 无权限参数）无法迁移；补偿控制 = fail-closed 审批 + 证据契约 + reviewer/终审范围核查（事后检测必驳回） |
| branch-executor 子进程分支 | 并行就绪任务 = 并发子代理（同工作区，靠依赖声明避免文件冲突） |
