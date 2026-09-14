/**
 * spec — 流程模板 DSL 规范全文(AI 编辑规则的唯一真相源)。
 *
 * 三处消费:
 *   - rs_workflow_template 工具 action:"spec" 返回给模型(AI 替用户写模板的依据);
 *   - 模板释放模式的看板「模板规范」折叠页直接渲染(GUI 用户参考);
 *   - docs/DESIGN.md 引用本文件(文档与实现同源,parity 测试钉住关键锚点)。
 */

export const SPEC_TEXT = `# 若水工作流流程模板 DSL 规范

流程模板 = 一份 JSON5 文本,声明一个强流程:每一步安排 AI 产出什么,引擎强制校验后推进。
你(AI)根据用户口述的逻辑写模板;写完调 rs_workflow_template {action:"save", release:true} 保存并释放为可选模式。

## 1. 顶层结构

{
  id: "novel",          // 必填,^[a-z][a-z0-9-]*$;释放的模式 id = rs-<id>
  label: "小说写作",     // 必填,模式显示名(选择器与看板展示)
  description: "...",   // 必填,一句话适用场景(分诊目录展示给引擎)
  steps: [ ... ],       // 必填,非空;步骤按文档顺序缺省链式依赖
}

## 2. 步骤字段

每个步骤:
{
  id: "outline",        // 必填,步骤内唯一,^[a-zA-Z][a-zA-Z0-9_-]*$
  label: "生成大纲",     // 可选,看板显示名
  slot: "planner",      // 可选,模型工作位,默认 "executor";
                        // 合法值(全集16): "planner" "executor" "reviewer"
                        // "planner-triage" "planner-command" "planner-subplan" "planner-escalate"
                        // "reviewer-plan" "reviewer-task" "reviewer-subplan" "reviewer-final" "reviewer-cross"
                        // "executor-task" "executor-enhance" "executor-retry" "executor-escalate"
  prompt: "...",        // 必填,指令模板。写清:做什么、按什么材料做、做到什么程度。
                        // 产出要求由引擎自动附加,不要在 prompt 里重复写格式要求
  load: ["skill:x", "doc:docs/spec.md"], // 可选,强制加载资源(见 §4)
  outputs: {            // 可选,产出契约(见 §3)。无 outputs 的步骤不强制产出块
    outline: "章节大纲:每行一条 'N. 章节标题——梗概',共 N 章",
  },
  listOutputs: ["outline"], // 可选,声明哪些产出按列表解析(for_each 的数据源必须是 list 产出)
  after: ["collect"],   // 可选,依赖步骤 id 数组。缺省 = 依赖文档序前一步(链式);
                        // 显式声明多依赖 = 并行汇合。禁止环
  maxFail: 3,           // 可选,步骤失败重试上限 1..10(默认取预算 reviewRejectBeforeEscalate)
  for_each: "outline.outline", // 可选,循环(见 §5)
  mode: "sequential",   // 循环推进:sequential(默认,实例串行链式)| parallel(实例并行)
  type: "ai",           // 默认 "ai";"flow" = 嵌套子流程(见 §6)
  flow: "{triage.route}",   // type=flow 必填:子流程 id;支持 {step.output} 动态路由(分诊)
  input: { brief: "{triage.brief}" }, // type=flow 可选:传参,子流程内 {input.brief} 引用
}

未知字段一律拒绝(拼写错误防静默失效)。步骤引用/依赖环/列表来源等由引擎校验,保存时不合法会逐条报错。

## 3. 产出契约(强流程核心)

outputs 声明"这步必须产出什么"。引擎给子代理的指令自动附带:
  [产出要求] 完成后,在回复末尾原样输出以下产出块:
  <output name="outline">章节大纲:每行一条...</output>

子代理回复末尾缺少对应 <output name="..."> 块 → 引擎附格式示例教学重问(预算 emptyOutputRetryLimit,默认 3);
重问耗尽 → 步骤失败;失败重试达 maxFail → 整个流程 blocked(看板可见)。弱模型在此机制下被流程兜住。
outputs 说明要具体可判:写清格式、数量、口径(如"每行一条,不超过 20 字"),不要写"合适的输出"。

## 4. 资源加载(load)

- "skill:<技能名>" → 注入 dsh 技能全文(如 "skill:web-search");
- "doc:<相对路径>" → 注入工作区文件全文(相对会话工作目录,绝对路径亦可);
- 资源全文注入指令的 [参考资料: ...] 节,单资源超 16k 字符截断;
- 资源缺失不阻断该步(指令缺该节),但引用错技能名等于没加载,prompt 不得假设资源必然存在。

## 5. 循环(for_each)

for_each: "<步骤id>.<产出名>" — 数据源必须是该步骤的 listOutputs 产出。
引擎把列表逐项实例化本步骤,实例指令注入 {item}(条目文本)与 {item.index}(1 起序号)。

- sequential(默认):实例串行,上一实例产出对下一实例可见 —— prompt 可引用本步骤
  自身产出实现循环携带(如前章梗概衔接:{write-chapter.summary};首实例该引用解析为空串);
- parallel:实例并行独立,prompt 禁止引用自身产出(校验拒绝);
- 非循环步骤不要写 for_each。

## 6. 嵌套子流程(type=flow)

{ id: "run", type: "flow", after: ["triage"], flow: "{triage.route}", input: { brief: "{triage.brief}" } }

- flow 是字面流程 id 或单一占位符 {step.output}(动态路由 = 分诊);
- 路由解析为空 → 步骤按完成处理(分诊未选中任何目标,合法出口);
- input 值必须是单一占位符引用;子流程内用 {input.<名>} 读取,{request} 仍是用户原始需求;
- 子流程产出扁平挂在本步骤产出下:下游用 {run.<子步骤id>.<产出名>} 引用;
- 嵌套深度上限 3,流程环拒绝;内置协作模板(collab)不可作子流程目标。

## 7. 分诊(triage)惯例

多入口流程的标准开头:
{ id: "triage", slot: "planner-triage",
  prompt: "分析需求,从下列流程中选择最合适的一个...可选: news/novel/video。输出选中的 id 与理由",
  outputs: { route: "选中的流程 id,必须是候选之一", brief: "给下游流程的需求简报,一句话" } },
{ id: "run", type: "flow", flow: "{triage.route}", input: { brief: "{triage.brief}" } }

route 无匹配时不建硬失败:把 route 写成候选 id 之一,或让下游步骤用 route 为空当条件。

## 8. 完整示例:新闻生产(news)

{
  id: "news",
  label: "新闻生产",
  description: "收集多源信息,交叉核对后产出新闻稿",
  steps: [
    { id: "plan", label: "采集计划", slot: "planner",
      prompt: "围绕需求制定信息采集计划:列出要检索的关键词、可信信息源与核对要点。",
      outputs: { keywords: "检索关键词列表", sources: "信息源列表" } },
    { id: "collect", label: "信息采集", after: ["plan"],
      prompt: "按计划逐源检索与摘录,记录来源与时间。需求:{request}",
      load: ["skill:web-search"],
      outputs: { facts: "事实清单:每条含事实、来源、时间", gaps: "未找到或存疑的信息点" } },
    { id: "verify", label: "交叉核对", after: ["collect"],
      prompt: "对事实清单交叉核对,剔除无源与相互矛盾的条目,标注置信度。",
      outputs: { verified: "核实后的事实清单" } },
    { id: "write", label: "成稿", slot: "reviewer", after: ["verify"],
      prompt: "基于核实事实写新闻稿:标题、导语、正文、引用来源。需求:{request}",
      outputs: { article: "新闻稿全文(Markdown)" } },
  ],
}

## 9. 完整示例:小说写作(novel,循环+循环携带)

{
  id: "novel",
  label: "小说写作",
  description: "先定大纲与人物,再逐章写作,每章衔接前文",
  steps: [
    { id: "outline", label: "大纲", slot: "planner",
      prompt: "为需求构思整部小说:确定章节数与各章梗概。需求:{request}",
      outputs: { chapters: "章节大纲:每行一条 'N. 章节标题——梗概'" },
      listOutputs: ["chapters"] },
    { id: "write-chapter", label: "逐章写作", for_each: "outline.chapters",
      prompt: "写第{item.index}章:{item}\\n\\n全文需求:{request}\\n前文最新梗概:{write-chapter.summary}",
      outputs: { summary: "本章 200 字内梗概(供后章衔接)" } },
    { id: "polish", label: "通稿润色", after: ["outline"],
      prompt: "通读全书设定与各章梗概,输出一致性修订建议清单。",
      outputs: { fixes: "修订建议清单" } },
  ],
}

注意 write-chapter 无显式 after:for_each 步骤在数据源步骤完成后自动展开。

## 10. 编写守则(AI 必读)

1. 每步只安排一件事,产出契约可判;禁止把多件事塞一步(弱模型会漏);
2. prompt 写"做什么与做到什么程度",不写产出格式(引擎统一附加);
3. 上下游衔接一律走产出引用({stepId.outputName}),不靠"记住上文";
4. 交付落盘(写文件)是子代理工具能力,prompt 可要求"把成稿写入 docs/xxx.md",
   但产出契约仍要正文块(引擎只认产出块);
5. 步骤数 3~12 为宜;过长的流程拆成多模板用分诊/嵌套组合;
6. 保存前自查:每个 prompt 的占位符都有来源;for_each 数据源是 listOutputs;
   动态路由候选与 description 一致。
`;
