# dsh-context-manager

会话上下文增强插件:历史输入回溯、插话撤回、对话分叉。dsh-session-manager 历史输入功能的独立延续包(原包已移除该功能)。

## 功能

### 历史输入浮层(Alt+↑)

输入框按 `Alt+↑` 唤起历史输入浮层:

- 范围导航:`←/→` 切换 workspace / session / global / prompts 四范围,列表时间倒序
- 搜索:输入即时过滤(IME 组合输入守卫,命中计数),`↑/↓` 选中、`Enter` 回填
- 回填经宿主公共契约 `inputActions.setDraft`;`Esc` 两级退出(编辑态 → 浮层)
- 编辑态:收藏(`C`)/重命名/删除常用提示词,数据落全局 `prompts.json`,与自动历史互不覆写

数据链:Host 聚合工作区缓存(`~/.dsh/historyPrompt/`,产物解压 + stat 指纹增量对齐)→ `/api/context/inputs` → 浮层。

### 插话撤回

消息气泡操作排的撤回图标:未应用的插话撤回到输入框重新编辑。RPC 走会话绑定面 `binding.session.updateQueue`,不与官方会话服务耦合。

### 对话分叉(fork)

消息气泡操作排的分叉按钮:从任意已完成轮创建分叉会话。

- 锚点:`remote.session.follow` 开场帧(回溯窗口 2000 事件)建轮号 → turn/end seq 映射,分叉请求 `sessions.fork({ atSeq })`
- 窗口外更早轮与进行中的轮不注入按钮(锚点不可得,宁缺毋错)
- 分叉成功自动打开子会话,子会话标题尾号递增

## 启停

设置页「会话上下文」分区三开关(历史输入/插话撤回/对话分叉),经宿主 settings 持久,变更刷新页面生效。浮层内 `S` 键或开关行亦可切换。

## 依赖与门控

- 宿主服务经 inject 声明(`slots`/`sessions`/`workspaces`/`remote`/`remote.session` 点分声明),namespace 未就绪整体保持未激活(干净禁用)
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

设计文档:`docs/上下文管理插件设计.md`
