# rs-workflow 模板蓝图与引擎映射

出处：rs-tui（难度分诊 4 模板、树唯一真相源）。本文档是引擎设计对照版，强制符合 rs-tui 原始设置语义；语义基准：`docs/progress/rscli-original-semantics.md`；引擎实现在 `references/engine.js`。

## 1. 难度分诊（引擎确定性矩阵）

三信号：**complexity**（low/medium/high，改动面/步骤数）、**risk**（low/medium/high，破坏面/回归风险）、**scope**（small/medium/large，涉及模块/功能数）。planner 产出三信号、计划与任务拆解（multi-plan 场景另产出子计划大纲），并可在计划中声明模板：合法才采纳，非法仍落矩阵（弱模型不可信由链路兜住）。判定顺序与原版 `selectTemplate` 一致：

| 判定顺序 | 条件 | 模板 | 用户感知 |
|---|---|---|---|
| 1 | risk=high 或 scope=large | multi-plan | 多子计划逐个干，交叉终审链 |
| 2 | complexity=high | step-review | 干一步审一步 |
| 3 | complexity=medium 或 risk=medium | plan-final | 先计划（计划审 pr），通过后执行，干完终审 |
| 4 | 其余（低复杂 + 低风险 + 小范围） | lite | 单任务直干，终审一次 |

缺失信号按 low/small 降级（planner 未标注的信号视为不存在）；三信号全缺 → 按 `defaultTemplate` 兜底（`auto`/缺省 → multi-plan）。模板兜底链（与原版 `resolvePlanTemplateId` 一致）：**锁定**（lockedTemplate，跳过分诊直接实例化）→ **planner 声明**（合法时采纳）→ **矩阵**（按信号裁定）→ **无信号兜底**（defaultTemplate）。特例：兜底选中 lite 但 planner 拆了多任务（信号与拆解自相矛盾）→ 升最小兼容模板 plan-final（lite 单元无依赖出口）。

## 2. 四模板拓扑

```
lite          t1 ──→ fr(终审)

plan-final    pr(计划审) → t1 → t2 → … → tn ──→ fr(终审)   (t 间依赖由 planner 声明, 无依赖可并行)

step-review   pr(计划审) → t1 → r1(审) → t2 → r2(审) → …   (pr 通过才放行任务链; 每任务后跟审批, 通过才放行后继)

multi-plan    pr(大纲审) → s1: p1 → r-* → sr1              (子计划单元按大纲依赖并行/串行;
              s2: p2 → r-* → sr2                            p=子计划细化, r-*=子计划内逐步审,
              …                                             sr=子计划交付审)
              全部子计划交付 → xr1(正确性) → xr2(边界与安全)  (交叉终审串行链, 均挂 reviewer-cross 位,
                                                             xr approve 串联, 后一 xr 依赖前一 xr)
```

- 依赖省略 = 链式接续前一个任务（rs-tui 规划协议语义）。
- 并行任务必须文件互不相交；有冲突风险必须声明依赖串行。
- multi-plan 子计划任务在运行时由 planner 子计划节点动态产出（原版 `appendSubtree` 语义）；子计划数与单子计划任务数无固定上限，子计划运行时预算 = 全局任务预算 `maxTasks` 的剩余额（动态分账，planner 子计划提示词告知剩余预算，实例化超预算时截断兜底并记日志）。
- pr（计划审 / 大纲审）挂 `reviewer-plan` 位，审批对象 = 计划文本（可执行性/粒度/依赖/文件互斥），对齐原版蓝图 planReview 节点：计划审挂在总规划与执行之间。
- 交叉终审串行链：xr1 审正确性、xr2 审边界与安全（原版视角前二），均挂 `reviewer-cross` 位；xr1 通过才轮到 xr2，任一拒绝回跳图内最后一个已完成 task 重做后重挂。
- 断点续跑（prefix 种子近似）：`args.prefix`（上轮已完成任务 `{id, description, output, changedFiles}`）在实例化前种为已完成任务节点（id 加 `x` 前缀防撞）；与种子同描述的新任务在实例化时强制剔除（续跑不重做的机器兜底）；lite / plan-final 的终审依赖含种子节点，step-review 无终审节点；multi-plan 忽略并记日志。

## 3. 审批循环与升级

| 项 | 值 | 语义 |
|---|---|---|
| reviewRejectBeforeEscalate | 2（budgets 可配，clamp [1,10]） | 交付型审批对象（task / 整体交付）连续被拒或失败达此值 → 升级重规划 |
| planRejectBeforeBlocked | 2（budgets 可配，clamp [1,10]） | plan 型审批对象（pr 的计划 / sr 的子计划）连续被拒达此值 → 升级重规划 |
| emptyOutputRetryLimit | 3（budgets 可配，clamp [1,10]） | 审批缺验证证据时的重问上限，超限视为拒绝 |
| reportNudgeLimit | 3（budgets 可配，clamp [1,10]） | executor 返回 completed 但交接摘要（summary）空白时的补救追问上限 |
| ESCALATION_LIMIT | 2（固定） | 升级重规划累计 2 次 → blocked 终态 |
| FAIL_RETRY_FUSE | reviewRejectBeforeEscalate + 2（固定） | 任务原地重试保险丝，仅防合并记账判定被异常绕过后的死循环，非业务阈值 |
| 调度预算 | 8 + (当前节点数 × (1 + reviewRejectBeforeEscalate) + 全程累计升级次数 × maxTasks × 3) × 3/轮 | 按当前图规模（节点项随任务拒绝阈值放大）与全程累计升级次数（不随审批通过清零）现算，大图与振荡兜底；每次升级增额 = maxTasks × 9 轮 |

budgets 四字段经 `args.budgets` 传入，GUI/slots.json5 配置，缺省 2/2/3/3。

拒绝路由（对齐原版，拒绝计数挂被审对象，达阈值才升级）：

- **计数挂被审对象**：被审对象为 plan 型（pr 审的计划 / sr 审的子计划）→ 阈值 `planRejectBeforeBlocked`；其余（task / 整体交付）→ 阈值 `reviewRejectBeforeEscalate`。
- **未达阈值 → 原位路由**：pr → 计划重写由 `planner-command` 位执行（重建任务段），**不计升级账**；sr → 该子计划由 `planner-subplan` 位带驳回意见重新细化并重建其任务段与 r-* 审批，sr 重挂；fr/xr → 被审对象（最后一个已完成 task）带拒绝重入前缀重做（`executor-enhance` 位），fr/xr 重挂其后。
- **达阈值 → 升级**：升级重规划由 `planner-escalate` 位执行，计入升级账；升级账达 `ESCALATION_LIMIT` → blocked。
- **task 主体**（逐步审 r-*）：与原始一致，failCount/rejectCount 合并记账（被拒/自报失败/调用失败各计 1），达 `reviewRejectBeforeEscalate` → 尾段替换升级——从失败节点可达的未完成节点废弃，planner 重规划剩余任务接在前缀之后，**并按模板重建蓝图**：lite/plan-final 重建终审 fr（依赖含新任务段与 prefix 种子），step-review/multi-plan 新任务链式配对 r-\* 审批，multi-plan 被波及的子计划审 sr 与交叉终审 xr 随新任务段重建。
- **approve 清零语义**：交付类审批（r-*/sr/fr/xr）通过清零升级账（同时清被审对象拒绝计数）；计划审批（pr）通过只放行计划文本，未经交付验证，**不清零升级账**（防升级重规划循环内 blocked 兜底永不触发）。
- **审批证据契约**（v1 补偿控制）：APPROVED 必须附 `evidence`（实际执行的检查命令与结果要点）；空证据按 `emptyOutputRetryLimit` 预算重问，仍空 → 降级 REJECTED（可补证据后原样重交）。
- **审批 fail-closed**（v1 补偿控制）：审批者子代理调用失败 → 候选轮换重试，仍失败**视为拒绝**（reviewerFault），走既有驳回路由；折算理由分两支——交付型审批（r-*/sr/fr/xr）"审批者不可用(视为拒绝), 可原样重交"，计划型审批（pr）"审批者不可用(视为拒绝), 将带此原因重新规划"；不存在"警告通过"。
- **范围核查**：reviewer/终审提示词含强制规则——实际变更（git diff/status）出现申报清单之外且不属于其他任务申报范围（豁免清单）的文件 → REJECTED 并点名越界文件；豁免清单仅 task 主体审批注入，终审无豁免、仍按各任务申报并集与全量变更比对。blocked 时未运行到的审批返回 `verdict=UNREVIEWED`（如实区分，不冒充 REJECTED）。
- **审批基准可判定化**：planner 拆解时每任务可带 `acceptance`（可独立验证的验收判据）与 `files`（预期触达文件，与任务申报清单共同构成范围核查对照基线），任务描述禁止占位措辞（TBD/"适当处理"/"同任务 N"式描述视为计划缺陷）；任务审批基准为可判定清单——只审本任务改动，每条验收判据须带可核证据（测试名/命令输出/file:line，prose 不算证据），不确定写明而不是猜。
- **severity 与复审限制**：审批输出可带 `severity`（critical/important/minor），仅作报告丰富、不作 APPROVED 机器门控（verdict+evidence 契约不变），critical 问题必须进 reasons；带 fixNote 的复审只判定驳回点是否解决与是否引入新问题，不扩大审查范围。

## 4. 交接摘要（原版 HandoffSummary 格式）

每次节点切换生成一次交接摘要，拼入子代理提示词（原版经隐藏通道注入，DSH 无隐藏通道直接拼接），格式与截断对齐原版 `serializeHandoffSummary`：

```
[原始需求] …                              （截 2000 字符）
[进度] i/n                                （首个未完成 task 序号/总任务数，全完成 = n/n）
[已完成子任务]
1. 描述: 关键输出                          （最近 10 条携带 keyOutput，截 500 字符；更早仅描述；无则"无"）
[当前子任务] …                            （活跃集合，并行时"；"连接）
[并行执行中]                              （有并行兄弟任务才有）
- 描述
[下一步] …                                （活跃节点前向首个 pending 后继；无则"无,全部完成"）
[关键文件变更]
- 文件                                    （全部已完成任务申报并集去重；无则"无"）
[上次失败模型] provider/model              （仅失败重试语境）
[强制续跑] 请继续推进工作，不要停止。        （仅 fail/escalate 语境）
```

总计划不入交接摘要，移入任务指令 [执行计划] 段与计划审/重规划上下文。分诊 planner 无交接摘要，但带 prefix 时注入"【已完成工作(断点续跑,禁止重复规划)】"清单（种子节点同时进入交接摘要 [已完成子任务]）。变更文件仅在审批提示词出现（本任务申报字段 + 非本任务范围的豁免清单）。截断常量与引擎契约一致：原始需求 2000、keyOutput 500、已完成窗口 10。

## 5. 与原版的差异（如实声明）

| 原版 | DSH 版 |
|---|---|
| Pi Extension 常驻引擎，树经 entry 持久化，session 可恢复续跑 | workflow 脚本单次前台运行；断点续跑为 **prefix 种子近似**（task 级模板），无树快照恢复（平台限制） |
| 模型能力池（models.json5 能力声明，池内自动轮换，池空抛错） | 无能力池，未配置的工作位回落会话默认模型兜底 |
| rotation 全局轮换（slotIndex/poolIndex 两级索引跨调用推进 + 失败退避越级落池） | 无全局轮换；候选数组/rotation 值内做节点级游标轮换（failover + 换模型重做） |
| planner-leader 监督对话位 + rs_leader_* 工具 + 分支求助两段链 | 无 planner-leader（DSH 主代理即 leader），无 leader 工具 |
| 角色工具硬拦截（工具面随角色收敛）/ permission-guard 底线集 / guardian 命令二审 | 平台限制（workflow agent() 无权限参数）无法迁移；v1 补偿控制 = fail-closed 审批 + 证据契约 + 范围核查（事后检测必驳回） |
| 隐藏 custom 通道交接（不进会话历史、切模型不新建 session） | 无隐藏通道，交接摘要拼入子代理提示词 |
| TUI 快捷键锁定模板/开关工作流 | 自然语言锁定模板；off 态 = 主代理直接处理 |
| 模板可目录发现自定义扩展（~/.rs-tui/templates/） | 固定 4 模板，无自定义模板目录 |
| 无任务数/子计划数上限（原版任何配置都无此约束） | DSH 保留 `maxTasks` 全局任务预算（每任务 = 独立子代理，平台 agent caps 需要，成本模型与原版共享会话不同），子计划运行时按剩余额动态分账 |
| planner 规划空转自愈（planHeal 退避重发，连续 3 次取消转空闲等用户） | planner 全挂由规则兜底：无信号走 `defaultTemplate` 兜底链实例化单任务（需求原文即任务），缺省配置（multi-plan）因缺大纲但有任务降档为 step-review（含前置计划审）；单次运行不能等待用户 |
| branch-executor 分支子进程（超时/续跑韧性）+ 重放缓存 + 自愈族（结算/API/规划/重规划空转自愈）+ 求助两段链 + leader 工具 + 成本熔断 | 并行 = 并发子代理（同工作区，靠依赖声明避免文件冲突）；分支子进程、重放缓存、自愈族、求助链、leader 工具、成本熔断等宿主能力无对应物 |
| 提示词注入面与原始 rs-tui 等同：用户需求与各节点产出（计划文本/执行摘要/审批意见）原样拼入子代理提示词，无定界符或转义（架构固有，未新增防护；拦截类安全约束由 v1 补偿控制事后兜底） | 同左，DSH 版未改变该注入面，亦未新增防护 |
