# dsh-tool-gate

全局层工具白名单延迟加载。白名单内工具全量注入模型上下文;白名单外统一打
`deferLoading` 标,交给宿主 deferred tool loading 原生链路(API `defer_loading`,
服务端按需搜索激活),解决插件注入大量工具污染上下文的问题。

## 机制

- **声明式收敛**:白名单是全系统工具 defer 态的唯一事实源——白名单内清标
  (覆盖插件作者自带声明),白名单外打标;每次收敛只动与目标态有差异的名。
  打标落在宿主 registration 包装内的 definition(0.2.2 起层条目为
  `{ definition, when }`,模型面投影读 definition.deferLoading)。
- **原生链路零干预**:支持 `defer_loading` 的路由(DeepSeek Messages 端)上,
  搜索、激活、会话投影(tool-addition/tool-removal)全部由宿主承担。
- **降级折叠**:第三方路由(无 defer_loading 能力,宿主剥标全量注入)在官方
  llm-pi-ai adapter 的请求缝上把 deferred 工具折叠为占位(name 保留 +
  占位引导 description + 参数骨架——键名/类型/required,深剥 description,
  白名单工具原样;provider 按请求 tools 集合校验 tool call 名与参数 schema,
  占位保住生成端名字与参数可见性:剔除会让调用意图被收敛到语义最近的白
  名单工具,空 schema 会让模型发空参数,均真机实证);模型经 `tool_search`
  检索完整定义后以正确名字与参数调用(宿主按名执行 registry 完整定义)。
  capable 路由(请求带 defer 标)与 deepseek 原生 adapter 一律透传。
- **会话隔离检索**:`tool_search` 只搜索调用方本步可见工具,继承、限制、同名
  覆盖与条件注册(`when`)准入由宿主解析:模型步内用宿主 toolSet 的准入面
  (`tools.definitions(scope, toolSet)`),程序化调用(无 toolSet)同一读取面
  返回注册视图(等价 `view(scope).visible`);无 agent 的调用只搜索全局层。
  搜索只返回定义文本,不注册工具、不修改白名单或任何会话的加载态。
- **原状还原**:收敛改动以 undo journal 按 definition 记录原状,行禁用/卸载
  按 journal 逐条还原,系统回到「没装本包」的世界(层表换代后同 definition
  重建仍可还原)。
- **干净禁用**:宿主 tools/llm 全局层内部结构不符已知形态、或 tools 缺
  `definitions` 投影面(0.2.2 前)时打日志零动作,不崩;llm 面失败只损失折叠,
  打标收敛不受影响。

## 使用(设置 → 工具门)

GUI 卡片是唯一配置入口(原生 schemastery 节已抑制):

- **启用工具门**开关:关 = 全部工具恢复注册原状(全量注入),白名单保留
- **降级折叠**开关:关 = 请求缝全量透传(打标维持),行为回到只打标
- **工具清单**:全部层聚合的工具名列表,每行开关 = 是否进白名单;行尾显示
  层数与 defer 态(`tool_search` 为折叠入口,常驻在列,开关禁点)
- 白名单含未注册名时卡片顶部警示

HTTP 面(`/api/tool-gate/*`,GUI 数据通道):`GET /state`、
`POST /allowlist`、`POST /enabled`、`POST /collapse`。

## 配置(行条目,经 GUI 写)

| 字段 | 默认 | 说明 |
|------|------|------|
| `allowlist` | `read/edit/write/shell/glob/grep/todo_write/ask_user_question` | 全量注入白名单,精确工具名 |
| `enabled` | `true` | `false` = 还原全部原状并停止打标(临时停用,不动行) |
| `collapse` | `true` | 降级折叠总开关(第三方路由请求改写) |

volatile 字段热改即时收敛(`loader/volatile-update`),不重启;新工具注册/
重注册由 `tools/change` 驱动重收敛。

## 局限

- 原生 defer 收益(DeepSeek 端服务端搜索)不变;第三方路由折叠由本地
  `tool_search` 承载,模型检索定义多一轮交互属机制内成本。
- 降级折叠只 patch 官方 llm-pi-ai 行 adapter;未来出现其他无 defer 能力的
  官方 adapter 需扩 sweep 名单(settingsNs 过滤单点收敛)。
- 彻底屏蔽某工具(不可搜索不可调用)走宿主 market 禁插件行,不在本包范围。

设计全文见 [白名单延迟加载-BDD.md](白名单延迟加载-BDD.md),兼容性见
[兼容性测试.md](兼容性测试.md)。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.2-rc.1"`:宿主 0.2.2 起工具层条目为 registration
包装(`{ definition, when }`),defer 态读写面按该形态对齐。低于 hostMin 的宿主由
compat 装载层排除(不装载);若被强制加载(旧 profile 手工挂载,或宿主版本不可读
时 dev-link 跳过校验)形态探测兜底为干净禁用(打日志、零动作、不崩),不回退旧
形态(dev-link 在版本可读且低于 hostMin 时直接拒绝)。逐轮实测结论见
`docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。
