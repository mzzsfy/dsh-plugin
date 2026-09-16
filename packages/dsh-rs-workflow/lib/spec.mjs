// spec — 流程模板 DSL v5 规范全文(模板编辑规则的唯一真相源)
// 消费:设置页「模板规范」折叠页渲染。
// 验收契约:含 type:"approve" 与 inputs 章节;不含「教学重问」与「<output」字样。

export const SPEC_TEXT = `# 若水工作流流程模板 DSL 规范(v5)

流程模板 = 一份严格 JSON 文本,声明一个强流程:每一步安排 AI 产出什么,引擎强制校验后推进。
在设置页「若水工作流 → 流程模板」新建或编辑模板,保存前经 host 权威校验(dryRun)。
文本必须是合法 JSON(键双引号、无注释、无尾逗号);本规范示例中的行尾注释仅为说明字段含义,写入模板时不要携带。

## 1. 顶层结构

{
  "id": "novel",
  "label": "小说写作",
  "description": "...",
  "inputs": { "chapterCount": "章节数说明" },
  "autoApprove": false,
  "steps": [ ... ]
}

字段含义:id 必填 ^[a-z][a-z0-9-]*$;label 必填,模板显示名;description 必填,一句话适用场景
(分诊目录展示给引擎);inputs 可选,运行时入参声明(见 §7);autoApprove 可选布尔(缺省 false,
true = 审批由主循环代审,不再转呈页签,见 §4);steps 必填非空,按文档顺序缺省链式依赖。

未知字段一律拒绝(拼写错误防静默失效);校验不合法会逐条报错(target 定位到 step:<id> 或 top:<field>)。

## 2. 步骤字段

每个步骤:
{
  "id": "outline",
  "label": "生成大纲",
  "slot": "executor-loop",
  "prompt": "...",
  "load": ["skill:x", "doc:docs/spec.md"],
  "outputs": { "outline": "章节大纲:每行一条 'N. 章节标题——梗概',共 N 章" },
  "listOutputs": ["outline"],
  "after": ["collect"],
  "maxFail": 3,
  "for_each": "outline.outline",
  "mode": "sequential",
  "type": "ai",
  "target": "draft",
  "rounds": 2,
  "onExhausted": "blocked",
  "flow": "{triage.route}",
  "input": { "brief": "{triage.brief}" }
}

字段含义:id 必填,步骤内唯一,^[a-z][a-z0-9-]*$(小写字母开头,仅小写字母/数字/连字符);label 可选,看板显示名;slot 可选,模型
工作位(仅常规步骤可自定义),六键全集:"planner" "executor" "reviewer" "executor-loop"(循环/重做)
"reviewer-approve"(审批) "executor-escalate"(升级);prompt 必填,指令模板,写清做什么、按什么材料
做、做到什么程度——产出要求由引擎自动附加 [产出要求] 节,不要在 prompt 里写格式要求;load 可选,
强制加载资源(见 §7);outputs 可选,产出契约(见 §3);listOutputs 可选,声明哪些产出按 string
数组解析(for_each 数据源必须是 list 产出);after 可选,依赖步骤 id 数组,缺省 = 文档序前一个常规
步骤(见 §5),禁止环;maxFail 可选,失败重试上限 1..10(缺省取预算 maxStepFail=2);for_each 可选,
循环(见 §6);mode 循环推进:sequential(默认,串行携带)| parallel(并行);type 默认 "ai",
"approve" = 人工审批(见 §4),"flow" = 嵌套子流程(见 §9);target 为 type=approve 必填,被审步骤
id;rounds 为 type=approve 可选,重审轮次上限(缺省预算 approveRounds=2);onExhausted 为
type=approve 必填语义:"blocked" 终局阻塞,其他步骤 id = 升级出口;flow 为 type=flow 必填,子流程
id,支持 {step.output} 动态路由;input 为 type=flow 可选传参(值须为单占位符 {step.output})。

## 3. 产出契约(强流程核心)

outputs 声明"这步必须产出什么"。引擎给子代理的指令自动附带 [产出要求] 节:字段含义与完成口径,并要求
完成后以 structured_output 工具提交。schema 由 outputs 自动生成:object + 全字段 required +
additionalProperties:false;listOutputs 产出类型为 string 数组。

子代理未提交结构化产出、字段缺失或为空 → 记一次失败;失败重试达上限(maxFail/预算)该步骤 failed、
其下游 skipped,流程以 failed 终局。产出说明要具体可判:写清格式、数量、口径,不要写"合理即可"。

## 4. 审批步骤(type:"approve")

审批步骤安排一次审校。被审 target 完成且依赖就绪后,流程进入外部裁决(waiting_approval):
本段暂停并出账待裁决摘要(target 产出、审批口径、上轮意见),裁决经页签或主循环回写——

- APPROVED:被审 target 链放行,流程继续;
- REJECTED(未耗尽):target 置回待办并重做,重做指令自动附 [重做说明] 节(裁决意见 comments +
  被审步骤原产出);审批步自身也回到待办等待再审;重审次数计账,达 rounds 上限即耗尽;
- 耗尽:onExhausted="blocked" → 流程终局 blocked(等用户介入);onExhausted=<升级步 id> → 触发升级步骤。

裁决来源由顶层 autoApprove 决定:false(缺省)转呈页签,用户点击裁决,主循环亦可代审(by=main-agent,
意见必填);true 直接由主循环代审。页签与主循环先到先得,幂等。审批步骤不派发子代理。

升级账:每次走升级出口 escalations+1,达预算 escalateLimit(默认 2)流程终局 blocked。

## 5. 缺省依赖链

未声明 after 的步骤依赖文档序前一个常规步骤(首步无依赖);显式 after(含空数组)完全取代缺省。
升级出口步骤(仅被 onExhausted 引用、无常规依赖)脱离缺省链,不参与调度。

## 6. 升级步(出口步骤)

- 脱离常规调度图:唯一触发边 = 审批耗尽;禁止被其他步骤 after 引用,禁止引用 target 的产出
  (只可引用 target 上游步骤产出——target 已被判不合格);
- 派发内容自定(保守交付/降级方案),完成后流程正常终局判定。

## 7. 运行时入参(inputs)与资源加载

- inputs 在顶层声明后,任意步骤 prompt 用 {input.name} 引用;未提供时解析空串;
- 初跑经会话消息承接(首个规划步骤应写明从 {request} 推导入参的口径);重跑对话框可显式覆盖;
- load 引用:skill:<名称> 经技能服务取全文;doc:<相对路径> 读工作区文件;超长截断,缺失不阻断(该节缺省)。

## 8. 循环(for_each)

for_each: "<stepId>.<listOutput>"——数据源必须是上游步骤的 listOutputs 产出。
- sequential(默认):实例串行,后一实例 prompt 可用 {本步id.outputName} 引用上一实例产出(顺序携带);
- parallel:实例独立并行;{item} 当前实例值,{item.index} 序号(从 1 起);
- 数据源为空数组 → 本步 skipped;实例失败独立计账,任一实例失败达上限 = 本步 failed。

## 9. 嵌套子流程(type:"flow")

- flow: "子模板id" 字面路由,或 "{stepId.outputName}" 动态路由(分诊);
- input: { name: "{stepId.outputName}" } 传参,子流程内以 {input.name} 引用;
- 子流程复用当前 run 记录(步骤前缀区分),产出按子步骤扁平挂载到本步骤产出;
- 嵌套深度上限 3;动态路由目标必须存在于模板集(跨流程校验)。

## 10. 分诊惯例

多入口模板标准开头:一个 triage 步骤,outputs 声明 route(候选模板 id)与 brief(交接摘要),
"listOutputs":["route"];后接 "type":"flow" 步骤 "flow":"{triage.route}"、"input":{"brief":"{triage.brief}"}。
route 为空 = 无候选命中,该步骤按空路由 done 收口(流程结束)。

## 11. 完整示例

示例 A(inputs + 审批闭环 + 循环):
{
  "id": "novel", "label": "小说写作", "description": "按章节数要求写小说初稿并终审",
  "inputs": { "chapterCount": "章节数,正整数" },
  "steps": [
    { "id": "outline", "prompt": "按 {input.chapterCount} 章要求生成大纲;需求:{request}",
      "outputs": { "outline": "每行 'N. 章节标题——梗概'" }, "listOutputs": ["outline"] },
    { "id": "write-chapter", "for_each": "outline.outline", "mode": "sequential",
      "prompt": "写第 {item.index} 章《{item}》,衔接上一章成稿:{write-chapter.draft}",
      "outputs": { "draft": "本章正文" } },
    { "id": "review", "type": "approve", "after": ["write-chapter"], "target": "write-chapter",
      "rounds": 2, "onExhausted": "polish", "prompt": "审校全书一致性;需求:{request}" },
    { "id": "polish", "prompt": "按 {request} 产出保守修订清单,不重写正文",
      "outputs": { "fixes": "修订建议清单" } }
  ]
}

示例 B(分诊动态路由,节选):
{ "id": "triage", "prompt": "分析需求选流程;候选与适用见模板描述", "outputs": { "route": "模板 id", "brief": "交接摘要" }, "listOutputs": ["route"] },
{ "id": "run", "type": "flow", "flow": "{triage.route}", "input": { "brief": "{triage.brief}" } }

## 12. 编写守则(AI 必读)

0. 目标锚点:模板是把模型自驱变强规则驱动的载体——每步只安排一件事、产出可判、衔接走引用,
   禁止把"做什么、做多少、怎么算完"的决定权留给模型;
1. 每步只安排一件事,产出契约可判;禁止把多件事塞一步;
2. prompt 写"做什么与做到什么程度",不写产出格式(引擎统一附加 [产出要求]);
3. 上下游衔接一律走产出引用({stepId.outputName}),不靠"记住上文";
4. 交付落盘(写文件)是子代理工具能力,prompt 可要求"把成稿写入 docs/xxx.md",
   但产出契约仍以结构化提交为准(引擎只认结构化产出);
5. 步骤数 3~12 为宜;过长的流程拆成多模板用分诊/嵌套组合;
6. 保存前自查:每个 prompt 的占位符都有来源;for_each 数据源是 listOutputs;
   approve 的 target 存在且 onExhausted 合法;动态路由候选与 description 一致。
`
