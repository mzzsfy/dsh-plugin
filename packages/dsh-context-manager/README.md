# dsh-context-manager

对话增强插件:历史输入回溯(Alt+↑ 或输入框工具排按钮唤起)、插话撤回、对话分叉(进行中轮分叉/自动重发)、标题栏复制 sessionId、克隆仓库打开工作区(官方浏览目录弹窗注入)。dsh-session-manager 历史输入功能的独立延续包(原包已移除该功能)。

## 功能

### 历史输入浮层(Alt+↑ 或输入框按钮)

输入框按 `Alt+↑`,或点击输入框下方工具排的历史按钮(指令/附件右侧,与 Alt+↑ 等效,再点关闭)唤起历史输入浮层:

- 范围导航:顶栏范围标签点击展开 pill 组选择;`←/→` 按 常用(prompts)→ 当前会话(session)→ 本工作区(workspace)→ 全部工作区(global) 依次切换(边界停住),列表时间倒序
- 收录范围:普通输入与斜杠命令(如 `/goal …`,按会话日志的 command/run 重组为完整命令行),工具结果回填与插件注入不收录
- 搜索:输入即时过滤(IME 组合输入守卫,命中计数),`↑/↓` 选中、`Enter` 回填
- 回填经宿主公共契约 `inputActions.setDraft`;`Esc` 两级退出(搜索词非空先清词,再按关闭浮层)
- 列表行悬停星标收藏/取消常用提示词;常用范围内点「编辑」进入编辑态(重命名/删除/新增),数据落全局 `prompts.json`,与自动历史互不覆写

数据链:Host 聚合工作区缓存(`~/.dsh/historyPrompt/`,产物解压 + stat 指纹增量对齐)→ `/api/context/inputs` → 浮层。批量与焦点解压各自运行,文件提交按目标文件串行读改写,跨同进程插件热重载实例共享提交队列;已确认收藏及焦点新增输入不会被并发旧快照覆盖。不同文件互不阻塞;不提供多进程同时写同一缓存目录的协调。

### 插话撤回

未应用插话气泡(消息流 steering 项)操作排的撤回图标:点击撤回到输入框重新编辑。RPC 走会话绑定面 `binding.session.updateQueue`,不与官方会话服务耦合。

- 注入形态同 fork(官方复制按钮模式):克隆官方按钮类,尺寸/hover/悬停显隐原生;显隐由 inbox 投影行集驱动——行在(未应用)注入,行不在(已应用/已撤回)即时摘除,投影订阅驱动重扫
- 气泡三形态全覆盖(顺序对齐,渲染文本不参与匹配):发送会话内插话气泡为 `data-pending-steering` + `data-submission-echo` 双标记(宿主 pendingInputs 以本地 submission 替换投影行渲染),切会话回来/刷新(本地 state 清空)为纯 `data-pending-steering` 单标记,已入转录后为 durable steering 气泡(`data-chat-flow-kind="steering"`,按 node-key messageId 匹配)——pending 形态一律按文档序与投影序一一配对,无行排尾(Host 未确认)由行存在性检查天然不注入
- 图标在场即暗示可撤:点击与投影更新之间的竞态窗口由「行不在降级提示 / remove 失败提示」兜底;含附件的插话点击明确提示不支持
- 匹配:durable 气泡 `data-chat-node-key` 的 `input-message` 后缀与 `next-step` 投影行 id 同源(官方两侧同用 `String(event.data.id)`),点击时实时重读防节点复用后过期

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

### 克隆仓库打开工作区(IDEA "Get from VCS" 同构)

入口按登录闸门自适应(默认注入,轮询探测):
- 启动即在工作区列表 header 注入第 4 个克隆按钮(无闸门环境基座「添加工作区」无反应,此按钮是唯一可用入口),点击弹出自绘克隆弹窗
- 同步轮询探测登录闸门(每秒一次,30s 封顶):`/login` 是闸门的排他性路由——闸门宿主返回 200,裸宿主 404;命中即移除按钮还原官方 3 按钮布局,克隆入口收敛到**浏览弹窗 footer**(取消与打开按钮之间,先经弹窗导航到目标目录再点击,父目录自动预填)

弹窗收集仓库地址/目标目录全路径/浅克隆(单一路径字段,目录名按地址推导后拼入),宿主执行 `git clone`,成功后自动注册为新工作区并打开空会话,立即可发消息——免去手工新建文件夹、终端 clone、再添加工作区的往返。

- 注入点:官方浏览目录弹窗为 DOM 结构识别(含面包屑 `role=navigation` 的 dialog 卡片,footer 末按钮=打开);按钮克隆官方取消按钮类名(原生视觉),disabled 镜像打开按钮(loading/路径编辑态同样不可点,disabled 属性观察保证空目录导航后的镜像翻转);官方结构漂移时返回 null 静默跳过(目录选择 flow 所在槽为 single 不可插件并列,故走 DOM 注入而非插槽)。header 兜底按钮注入后基座重渲染卸载外来节点时指数退避重试(setTimeout 主动调度,1s→30s 封顶),写入计数熔断只计自家写入、页面水合期高频变异零自家写入不会误伤
- 目标目录预填:点击 footer 按钮时经官方「编辑路径」输入态读取弹窗当前目录(读取即收起浏览弹窗,合成 Escape 在 portal 内必然触发官方 Modal 的整体关闭,这是实测锁定的代价),预填 = 当前目录 + 推导目录名;读取失败回退上次克隆位置(localStorage 记忆目标的父目录),两者皆无则要求手填;header 按钮无弹窗可读,直接走记忆/手填
- 目录名按仓库地址自动推导(去 `.git`,支持 https/ssh/git 协议与 `git@host:path` scp 语法),目标目录手改过则不覆盖
- 执行:POST `/api/context/git-clone` → 宿主 `git clone [选项] -- <url> <目标>`(参数数组直传,无 shell;url 以 `-` 开头拒绝,`--` 兜底);目标必须绝对路径且支持 `~` 展开,已存在时须为空目录(git 允许克隆进空目录),父目录必须存在;单飞行守卫,并发请求直接拒绝;超时 30 分钟树杀(Windows `taskkill /T /F`);失败透出 git stderr 尾部;git 缺失收敛为可行动文案
- 完成链:克隆 resolve 即收起浏览弹窗(footer 取消按钮主路径,结构漂移派发 document 级合成 Escape 兜底)并关闭克隆弹窗——两弹窗关闭不依赖登记链;随后 `workspaces.create({path})`(幂等,已登记返回现有)→ `uiWorkspace.startSession(workspaceId)` 打开新工作区空会话,登记迟滞/挂起/失败均不阻塞关闭,失败经 toast 通报;uiWorkspace 经 inject 声明获取(实测 ctx.get 懒取不可达),与 slots/sessions 等既有 services 同门控策略
- 凭据走 git 自身凭据链(私有仓库与命令行克隆同源);浅克隆为 `--depth 1`(只取最新提交),选择记忆

## 启停

设置页「插件」→「对话增强」卡片七开关(历史输入/输入框历史按钮/插话撤回/对话分叉/分叉后自动重发/标题栏复制 sessionId/克隆仓库按钮),经宿主 settings 持久,变更刷新页面生效。「输入框历史按钮」仅控制工具排按钮显隐,停用后 Alt+↑ 与浮层不受影响。

## 依赖与门控

- client 半区宿主服务经 inject 声明(`slots`/`sessions`/`workspaces`/`uiWorkspace`/`remote`/`remote.session` 点分声明),namespace 未就绪整体保持未激活(干净禁用);host 半区 inject 为 `webServer`/`agents`/`sessionQuery`/`sessionPersistence`
- 公共依赖 `@mzzsfy/dsh-common-tools` 可选消费(toast 通知通道,模块缺失即置空)
- 样式注入带 `data-plugin` 标记,开关为 `cx-switch` 形态(状态选择器锚定 `input[type="checkbox"]`)

## API(host 半区)

| 路由 | 方法 | 用途 |
|------|------|------|
| `/api/context/inputs` | GET | 历史输入(`?sessionId=&scope=`) |
| `/api/context/prompts/toggle` | POST | 收藏/取消收藏(按截断后文本查重) |
| `/api/context/history-enabled` | GET/POST | 历史浮层启停 |
| `/api/context/history-button-enabled` | GET/POST | 输入框历史按钮启停 |
| `/api/context/steer-recall-enabled` | GET/POST | 插话撤回启停 |
| `/api/context/fork-enabled` | GET/POST | 对话分叉启停 |
| `/api/context/fork-auto-resend-enabled` | GET/POST | 分叉后自动重发启停 |
| `/api/context/copy-sid-enabled` | GET/POST | 标题栏复制 sessionId 启停 |
| `/api/context/git-clone` | POST | 克隆仓库(url/parent/name/shallow,单飞行,返回 `{path}`) |
| `/api/context/clone-enabled` | GET/POST | 克隆仓库按钮启停 |

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。
