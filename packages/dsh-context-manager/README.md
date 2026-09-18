# dsh-context-manager

对话增强插件:历史输入回溯、插话撤回、对话分叉(进行中轮分叉/自动重发)、标题栏复制 sessionId。dsh-session-manager 历史输入功能的独立延续包(原包已移除该功能)。

## 功能

### 历史输入浮层(Alt+↑)

输入框按 `Alt+↑` 唤起历史输入浮层:

- 范围导航:`←/→` 按 常用(prompts)→ 当前会话(session)→ 本工作区(workspace)→ 全部工作区(global) 依次切换(边界停住),列表时间倒序
- 搜索:输入即时过滤(IME 组合输入守卫,命中计数),`↑/↓` 选中、`Enter` 回填
- 回填经宿主公共契约 `inputActions.setDraft`;`Esc` 两级退出(搜索词非空先清词,再按关闭浮层)
- 列表行悬停星标收藏/取消常用提示词;常用范围内点「编辑」进入编辑态(重命名/删除/新增),数据落全局 `prompts.json`,与自动历史互不覆写

数据链:Host 聚合工作区缓存(`~/.dsh/historyPrompt/`,产物解压 + stat 指纹增量对齐)→ `/api/context/inputs` → 浮层。

### 插话撤回

消息气泡操作排的撤回图标:未应用的插话撤回到输入框重新编辑。RPC 走会话绑定面 `binding.session.updateQueue`,不与官方会话服务耦合。

### 对话分叉(fork,重写式)

用户输入气泡操作排的分叉按钮:分叉出新会话到该轮之前(该轮不带入子会话消息流),该轮的用户输入自动回填子会话输入框供编辑重发——与插话撤回同构,作用于 fork 场景,原会话消息流不动(进行中轮分叉会停止原会话该轮未完成的回复,见下)。图标与官方分支按钮同源;官方「在新对话中分支」驻留轮尾操作排(分叉含该轮),两者语义互补、位置不重叠。

- 锚点:`remote.session.follow` 开场帧(回溯窗口 2000 事件)建轮号 → { 结束 seq, 该轮首问文本, open } 映射;重试轮 N 的分叉边界取轮 N-1 的 turn/end seq(宿主边界语义 inclusive,轮间切口合法)
- 轮内插话不误取:文本取本轮首条携带非空文本的用户本人消息(文本块按行拼接),插件注入/纯图/空白轮不注入按钮
- 进行中的轮可分叉:该轮用户消息已落账而 turn/end 未到时照常注入;锚点仍取其前一个闭合轮,分叉成功后自动停止本会话该轮未完成的回复(止损,失败仅记日志);首轮不注入(宿主 fork 边界必须落在 turn/end 上,「复制零事件」不可表达,新建会话即为同义操作)
- 分叉执行走宿主 sessions 服务面 fork+open(与官方 chat 的 forkAt 同一服务,仅锚点不同);分叉成功自动打开子会话并回填草稿,子会话标题尾号递增;open 失败时暂存保留,手动打开子会话仍兑现回填
- 回填时序:宿主 open 可能先于草稿登记完成子会话挂载,消费侧以有限次延迟重查兜底
- 分叉后自动重发(开关,默认关):开启时分叉成功即以该轮原输入经 `remote.session.prompt` 发送到子会话立即开跑(重生成语义);prompt 失败仅通知,文本已在输入框可手动发送;旧宿主缺 prompt 通道自动降级为仅回填

### 标题栏复制 sessionId

会话标题栏(「标准模式」标签右侧)的复制按钮:点击复制当前会话 id 到剪贴板,便于粘贴给他人排查或脚本引用。

- 平时隐藏(opacity 占位),鼠标悬停标题栏任意位置或键盘聚焦时显示;`prefers-reduced-motion` 下关闭过渡
- 复制优先走 `navigator.clipboard.writeText`,非安全上下文(如 LAN http 访问)自动回退隐藏文本域 `execCommand`
- 挂官方 `conversation.session.header.actions` 插槽,成功/失败均经 toast 反馈

## 启停

设置页「插件」→「对话增强」卡片五开关(历史输入/插话撤回/对话分叉/分叉后自动重发/标题栏复制 sessionId),经宿主 settings 持久,变更刷新页面生效。

## 依赖与门控

- client 半区宿主服务经 inject 声明(`slots`/`sessions`/`workspaces`/`remote`/`remote.session` 点分声明),namespace 未就绪整体保持未激活(干净禁用);host 半区 inject 为 `webServer`/`agents`/`sessionQuery`/`sessionPersistence`
- 公共依赖 `@mzzsfy/dsh-toast` 可选消费(模块缺失通知通道置空)
- 样式注入带 `data-plugin` 标记,开关为 `cx-switch` 形态(状态选择器锚定 `input[type="checkbox"]`)

## API(host 半区)

| 路由 | 方法 | 用途 |
|------|------|------|
| `/api/context/inputs` | GET | 历史输入(`?sessionId=&scope=`) |
| `/api/context/prompts/toggle` | POST | 收藏/取消收藏(按截断后文本查重) |
| `/api/context/history-enabled` | GET/POST | 历史浮层启停 |
| `/api/context/steer-recall-enabled` | GET/POST | 插话撤回启停 |
| `/api/context/fork-enabled` | GET/POST | 对话分叉启停 |
| `/api/context/fork-auto-resend-enabled` | GET/POST | 分叉后自动重发启停 |
| `/api/context/copy-sid-enabled` | GET/POST | 标题栏复制 sessionId 启停 |

设计文档:仓库根 `docs/上下文管理插件设计.md`

## dsh 版本兼容

三版本全部通过:样式注入 data-plugin 契约、Alt+↑ 历史浮层、对话 fork、设置「插件」页对话增强卡四开关、host 半区 API(history-enabled / fork-enabled)。0.1.6 设置分区卡片位于「插件」页,非独立导航项。
