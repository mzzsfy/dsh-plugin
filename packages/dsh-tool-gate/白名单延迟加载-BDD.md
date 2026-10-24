# tool-gate 白名单延迟加载 BDD(白名单是全系统工具 defer 态的唯一事实源)

背景:插件向全局层注入大量工具,全量进模型上下文,污染注意力与 token 预算。
宿主 0.2 起原生支持 deferred tool loading 全链路:工具 definition 带
`deferLoading: true` → `wireSchemas`/system-prompt 投影透传 → deepseek 适配器
映射 API `defer_loading: true` → 服务端按需搜索激活(agent-loop 以 developer
message 记录 tool-addition/tool-removal,dsh-llm 投影层处理会话一致性);不支持
的上游由投影层剥字段退化为全量注入,无害。官方 `tools.restrict()` 只开 agent
级,全局可见性门是官方留白,本包补位。

本包不做工具摘除、不做行禁用。原生 defer 链路(支持 `defer_loading` 的路由)
上机制全部站在宿主侧;不支持的路由按 INV-10 降级折叠(2026-10-20 新增:
「零自实现」修订为「原生链路零干预」——第三方路由的折叠若不自实现即永远
不生效,退化路径实测为全量注入,门形同虚设)。

## 核心不变式

- **INV-1 声明式收敛**:任意时刻,全局层每个工具的 defer 态 = f(白名单)。
  白名单内 ⇒ `deferLoading` 不存在;白名单外 ⇒ `deferLoading === true`。
  不区分标是谁打的:白名单命中即清(覆盖插件作者声明,用户意图优先),
  白名单外即打(含插件自带 defer 声明的工具——白名单外本就应延迟)。
- **INV-2 原状可还原**:收敛只改 `deferLoading` 字段且每次改变前记录原状
  (undo journal);行禁用/卸载时按 journal 还原全部原状,系统回到
  「没装本包」的世界。还原前校验层内同名工具仍是同一 definition 引用,
  防止误改重注册后的新对象。
- **INV-3 打标即生效**:schema 投影(`wireSchemas`/`view`)每请求实时读
  definition,打标/清标不改层成员资格,无需 emit `tools/change`,下一次
  assemble 自然生效。
- **INV-4 干净禁用**:宿主 `ctx.tools` 缺失或全局层内部结构
  (`layers.global.tools`,NamedEntries Map)与已知形态不符时,apply 打日志
  即返回,零动作不崩;宿主升级重构内部面后自愈路径 = 形态再探测。
- **INV-5 原生会话投影零干预**:原生路由的激活、会话投影与 prompt 顺序
  校验由宿主承担。本包注册只读 `tool_search` 供降级路由检索定义文本,
  不注册被搜索工具、不修改会话加载态、不 provide 服务、不拦截执行。
- **INV-6 非 deferLoading 能力宿主不受影响**:工具执行、权限、guard、
  presentCall/presentResult 均不读 `deferLoading`,本包不触碰 definition
  其余字段。
- **INV-7 收敛面 = 全局层 + 全部 per-agent scope 层**:宿主 0.2 起模型可见
  工具多注册在 agent 面(真机实证:全局层近乎恒空,scoped 层 20+ 工具),
  收敛每轮现读层清单,scoped 层随 agent 动态生灭,新层首收敛由其注册触发
  的 tools/change 驱动。层标识用层数据表(Map)对象引用直接作 journal 键,
  禁止字符串化(scope 键对象 String 化全部坍缩 '[object Object]',层间
  lookup 串层,真机实证 read_image/pwsh 漏打)。
- **INV-8 行模块 inject 声明门控**:`export const inject = ['tools']` 使
  行 fiber 等 tools 服务在场才 apply;apply 内 ctx.get 即时解析早于服务
  可达(真机实证 undefined → 误判干净禁用)。服务缺失 = 行保持未激活 =
  干净禁用。
- **INV-9 GUI 单一写入口,零桥收敛**:web 行提供状态读(全层工具清单投影)
  与白名单/enabled 写;写经 settings.replace 落盘行条目 → 主行
  loader/volatile-update 监听自动收敛,不设刷新桥。web 行只读工具 defer 态
  (definition 对象跨行共享),不自己收敛。原生 schemastery 设置节经
  settings.configure({ auto: false }) 抑制(主行动态 ctx.inject(['settings'])
  声明,settings 缺失只影响节抑制不影响收敛本体),GUI 卡片是唯一配置入口。
- **INV-10 降级折叠只作用降级路由**:装饰器仅 patch 官方 llm-pi-ai 行注册的
  adapter 类原型(`llm.directory` entry.settingsNs === 'llm-pi-ai',sweep +
  `llm/adapters-updated` 重扫,gateway 同构);deepseek 原生 adapter(不同类)
  不 patch,原生 `defer_loading` 链路不受影响。rewrite 三重透传门:门关
  (enabled=false 或 collapse=false)→ 原样;请求 tools 任一带
  `deferLoading === true`(toolUpdate capable 路由原生投影保留标)→ 原样;
  请求名 ∩ registry deferred 名为空 → 原对象零拷贝透传。改写一律不可变构造。
  命中时不剔除而是折叠为名字+参数骨架占位(name 保留,description 换占位
  引导文案,parameters 深剥全部 description 留骨架——键名/类型/required,
  不带 deferLoading 键,投影幂等)。
- **INV-10a 生成端名字与参数可见性**:请求 tools 必须保留 deferred 工具的
  名字与参数骨架。provider 对 tool call 名按请求 tools 集合校验/锚定(真机
  实证:剔除后模型对 web_fetch 的调用意图被收敛到语义最近的 web_search,
  参数被强行套入,静默降级);空 schema 则模型生成空参数,工具自身参数
  校验失败(真机实证:无参数 deferred 工具全部成功,有参数的全部失败)。
  占位 ~20 token/工具 + 骨架,常量 description 对 prompt cache 稳定。
- **INV-11 缝上标记即原生信号**:capable 路由的 `projectToolUpdates` 产物保留
  deferLoading 标,降级路由产物已剥标——缝上「见标即透传」零成本区分两类
  路由,不读宿主 modelInfo/compat 内部面。
- **INV-12 tool_search 隐式白名单**:折叠入口工具 `tool_search` 经
  `defineTool` 注册于主行全局层(effect 注销),收敛把它视作隐式白名单成员
  永不打标;执行只读 `tools.view(exec.agent).visible`,正则匹配 name+description,
  继承、restrict 与同名遮蔽由宿主解析,无 agent 时仅全局视图。返回定义文本
  (name/description/parameters),模型据文本以正确名字与参数直接调用
  (宿主执行层按名查 registry,与请求 tools 列表无关;但请求 tools 必须含
  该名字,见 INV-10a)。无效 pattern 返回错误文本不抛。owner 限定 adapter
  实例(gateway 同款),同原型非授权实例透传。

## GUI 场景

- **SC-11 状态投影**:GET /api/tool-gate/state 返回 { enabled, allowlist,
  tools }——tools 按名聚合跨层(出现于 N 层、其中 defer 态层数、是否在
  白名单、是否未注册),层明细随行。
- **SC-12 白名单勾选**:POST /api/tool-gate/allowlist(名字数组,清洗:
  剔非字符串/空串/重复)→ settings.replace 落盘 → 主行收敛;响应回新 state。
- **SC-13 enabled 开关**:POST /api/tool-gate/enabled → 同上链路。
- **SC-14 守卫**:写路由跨源 403、方法不符 405、非 JSON 体 400;
  GET 无守卫(只读)。
- **SC-15 卡片呈现**:设置页「工具门」分区——enabled 开关(规约 switch
  形态,tg- 前缀)、工具清单每行开关(勾选 = 白名单)、未注册白名单名警示;
  写失败显示错误不翻状态。

## 配置语义

- `allowlist`(volatile 数组):全量注入白名单,精确工具名匹配。
- `enabled`(volatile 布尔,默认 true):false = 收敛为「全部还原原状并
  停止打标」,等效临时停用而不动行。
- `collapse`(volatile 布尔,默认 true):降级折叠总开关;false = 装饰器
  全量透传,行为回到「只打标」的旧世界(打标本身维持)。
- 出厂白名单 = 会话核心工具集(read/edit/write/shell/glob/grep/
  todo_write/ask_user_question),用户按需增删。
- 白名单含未注册名:收敛照常,日志 warn 未知名清单(不报错不阻断)。

## 降级折叠场景

- **SC-16 降级路由请求折叠为占位**:registry 有 deferred 名(read 外全部),
  装饰缝收到 options.tools = [read, shell, web_fetch](无标,降级路由剥标
  形态)⇒ 改写产物 tools = [read 原引用, shell 占位, web_fetch 占位],
  占位 = {name, 占位 description, parameters 骨架(深剥 schema 说明)} 且
  不带 deferLoading 键,原数组与新 options 对象均不被变异。
- **SC-16b 参数名不被误剥**:properties 下键名是参数名而非 schema 说明
  (subagent 的参数恰名 description)⇒ 骨架投影保留参数键名,仅剥参数
  定义内部的 description;按键名误剥会让模型端 schema 缺参数定义,
  required 项永远空缺报错(真机实证:subagent 九连报 missing description)。
- **SC-17 capable 路由透传**:options.tools 含 `deferLoading === true` 条目
  ⇒ 原样透传(原生 toolUpdate 投影在管,INV-11)。
- **SC-18 零命中零拷贝**:请求名 ∩ deferred 名为空 ⇒ 返回原 options 引用
  (不重建对象,不注入 tool_search 副本)。
- **SC-19 门关透传**:collapse=false 或 enabled=false ⇒ 全量透传,且注册层
  原状还原(enabled=false 走 SC-7 路径)。
- **SC-20 owner 限定**:同原型非授权 adapter 实例调用 streamWithSnapshot ⇒
  透传,不改写。
- **SC-21 tool_search 执行**:pattern 命中 name 或 description 子串(正则)
  ⇒ 返回命中工具定义文本(含 parameters JSON);无命中返回空态文本;无效
  正则返回错误文本不抛;tool_search 自身不出现在结果里。
- **SC-22 收敛不打标 tool_search**:tool_search 在白名单外 ⇒ 收敛后其
  definition 仍无 deferLoading(隐式白名单,INV-12);GUI 工具清单该行显示
  「折叠入口」锁定态。
- **SC-23 检索会话隔离**:Given A/B scope 注册各自私有工具,A 继承预设工具并
  restrict 一个全局工具;When A/B 分别搜索;Then 只返回各自可见定义,局部
  同名定义覆盖全局定义,无 agent 调用只返回全局定义。
- **SC-24 检索无加载副作用**:Given A/B 均已投影 tools;When A 搜索私有工具;
  Then 两者 tools schema 与 defer 态均不变,B 仍搜不到 A 的私有工具。

## 场景

- **SC-1 白名单内外分野**:注册 read/shell/web_search,白名单 = [read,
  shell] ⇒ read/shell 无 `deferLoading`,web_search `deferLoading === true`。
- **SC-2 覆盖作者声明**:web_search 注册时自带 `deferLoading: true`,移入
  白名单收敛 ⇒ 该字段被清除(用户意图优先,INV-1)。
- **SC-3 白名单热改收敛**:收敛态白名单 = [read],settings 写白名单 =
  [read, shell] → `loader/volatile-update` ⇒ shell 解除 defer;原白名单外
  其余工具维持 defer。
- **SC-4 新工具收敛**(`tools/change`):收敛态下新插件注册 web_fetch ⇒
  下一轮收敛 web_fetch 打标(白名单外)。
- **SC-5 重注册收敛**:已打标工具被插件卸载重注册(新 definition 对象,
  defer 态回原状)⇒ 下一轮收敛重新打标。
- **SC-6 行退场还原**:收敛态若干工具被本包改动 ⇒ 行禁用 ⇒ journal 逐项
  还原:本包打过标的字段消失,被本包清掉的自带 defer 声明恢复;层内已被
  重注册顶替的名字跳过还原。
- **SC-7 enabled=false**:`enabled` 写 false ⇒ 全部按 journal 还原并停止
  打标;写回 true ⇒ 重新收敛。
- **SC-8 未知名白名单**:白名单 = [read, no_such_tool] ⇒ 收敛正常,
  warn 含 no_such_tool。
- **SC-9 内部面缺失**:ctx.tools 无 layers.global.tools Map 结构 ⇒ 日志
  说明即返回,不崩,零动作。
- **SC-10 官方投影锁定**(集成):真 cordis + dsh-tools 下,deferred 工具的
  `schemaOf` 产物带 `deferLoading: true`,白名单内工具不带;`view().visible`
  两者均在(defer 不改可见性,只改声明形态)。

## 已知边界

- 原生 defer 收益(DeepSeek Messages 端服务端搜索)不受影响;第三方路由改由
  本地降级折叠承载,服务端搜索不再参与(该类路由本无此能力)。
- 降级折叠只 patch 官方 llm-pi-ai 行的 adapter;未来出现其他无 defer 能力的
  官方 adapter 需扩 sweep 名单(settingsNs 过滤点单点收敛)。
- 同原型被第三方包复用注册自身 adapter 时,owner 过滤保证其透传;若第三方
  以官方行 settingsNs 注册(伪造),视为对抗场景不在防线内。
- 工具 deferral 不改变其执行权限与调用许可;屏蔽级需求(彻底不可用)走
  宿主 market 禁行,不在本包范围。
- 会话早于门启用时,历史中已见过的 deferred 工具在折叠后失去 schema,
  模型可经 tool_search 重新取回定义;历史 tool_call 块投影不受影响。
