# @mzzsfy/dsh-think-expand

DeepSeek Harness 插件:流式输出思考时自动展开最新一条思考行,免去每次手点;可选「展开全部消息」模式,追加一条独立的工具行展开机(自动展开最新一条工具调用/命令卡等折叠行)。思考与工具两台状态机独立计算:思考行要看完,工具行展开可见性低,互不接管。

## 行为

默认仅思考模式:

| 场景 | 行为 |
|---|---|
| 流式思考行出现(`data-state="running"`) | 自动展开该行 |
| 新思考行出现 | 收起上一条由插件展开的行,展开新行 |
| 用户手动展开任意行 | 插件收起自己展开的行,此后不再干预该手动行 |
| 用户手动收起插件展开的行 | 视为已读,本轮不再展开,直到下一条新思考行 |
| 流式结束(`running` → `ok`) | 保留最后一条展开状态 |
| 打开会话 / 刷新页面 / 切换会话 | 最后一条思考行自动展开,其余保持收起 |
| 自动展开后用户手动收起 | 不再重展开,直到下次打开或切换会话 |
| 用户手动展开较旧行 | 手动意图优先,插件不展开最后一条 |
| 插件展开/收起动作改变内容高度 | 动作前置底的视口在高度落定后回补置底,官方自动滚动跟随不失联;用户主动滚开则不干预 |

「展开全部消息」模式(设置卡片开关,实时生效,持久 localStorage)——追加独立的工具行展开机,思考机行为不变:

| 场景 | 行为 |
|---|---|
| 开关开启 | 思考机照常运行;工具机启动,自动展开最新一条可折叠工具行(工具调用/命令卡等),其余保持收起 |
| 新工具行出现 | 工具机收起上一条由插件展开的工具行(手动行除外),展开新行——与思考机同形态、独立节奏 |
| 用户手动收起插件展开的工具行 | 视为已读,该行不再展开;不影响思考机 |
| 用户手动展开任意工具行 | 手动意图优先,工具机不展开最新一条且不收回该行 |
| 打开会话 / 刷新页面 / 切换会话 | 最后一条思考行与最后一条可展开工具行各自动展开(两机独立),其余保持收起 |
| 开关关闭 | 工具机停止,插件展开的工具行收回,手动展开行保留;思考机契约不变 |

卸载插件:重载页面即恢复官方默认行为;唯一残留为本插件写入的 localStorage 开关键,不被任何代码读取。

## 实现要点

- Think 行识别:官方 ReasoningRow 根节点字面量属性 `[data-variant="think"]` + `data-state`,折叠头 `[data-disclosure-row]`,滚动容器 `[data-conversation-scroll]`;正文容器按 `thinkBody` 类名子串匹配(CSS Modules 哈希带前缀);识别失败即不干预。
- 工具机(全部消息模式):第二状态机 `planTools`,独立 registry/current/manual/read,与思考机零共享状态;行根 = flowItem `[data-chat-node-key]` 全集减思考行根,可展开性按官方 `data-expandable` 标记判定(preparing 行无标记天然落选),正文按 `bodyWrap` 类名子串匹配;目标行 = 文档序最后一个可展开行(工具流 state 形态多样,不按 state 选行);手动识别仅在插件已展开过行后激活(首轮既存展开行视为中性,与思考机流式守卫同构)。
- 展开/收起模拟点击折叠头(按 `aria-expanded` 判定),与官方组件状态机一致,不直改 DOM 内部状态;会话区不写任何 DOM 属性,设置卡片样式元素自带 `data-plugin` 标记(claimStyles/HMR 契约)。
- 行标识 = 控制器侧元素稳定 uid(WeakMap 计数),标记命中 uid 优先、已见文本前缀兜底,标记载体为模块级 Map(键为登记时文本);client 端插件展开过的行另以元素 WeakSet 记闩锁(展开记入、收起解除,会话切换重置),供决策层区分手动展开,不写 DOM 属性;全部标记随页面生命周期存活,不持久化。body 哨兵观察器常驻 document.body 监视容器身份变化(会话切换,仅 childList 通道);容器重挂后首扫抑制手动识别,既存展开行视为中性;观察器句柄挂 window 代际槽,HMR 重评估先拆上一代,防多套决策机并行同扫。
- 纯逻辑层(行分类、展开决策、标记存活性、置底判定、工具机)在 `src/logic.mjs`,`src/client.js` 内嵌同源实现,`node --test` 以同一套 BDD 场景对两份实现做 parity 验证,并逐函数对比源码文本(含内部助手)防双写漂移。
- 置底保持:官方滚动跟随以"视口贴近底部"为前提(距离底部不超过阈值判定置底),插件展开/收起改变内容高度会把置底视口推离底部,官方跟随随即失联。动作前记录置底状态,高度落定(rAF 帧计数)后偏离量可被本次高度变化解释才回补置底,用户主动滚开不干预;判定函数进纯逻辑层。
- 设置卡片:client 半区 `inject: ['slots']` 声明式挂载(cordis inject waiting 门控,服务未就绪整体挂起即干净禁用),两代槽位并存注册(`settings.plugin.item` / `plugins.bundle.config`,context-manager 同构)。开关持久于 localStorage(`dsh-think-expand:expandAll`),切换实时生效;样式注入 head 带 `data-plugin` 标记,视觉走 `--te-*` 包局部 token(引用宿主 `--dsw-alias-*` 带亮色 fallback)。
- Host 半区 `src/index.js` 为空壳,profile 行仅用于让 client 模块系统发现本包的 dsh.client 声明。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-think-expand
```

重启 dsh 后流式会话即生效;设置入口(0.1.6- 为设置页插件条目,0.1.7+ 为插件管理页本包条目)可切换「展开全部消息」。

## 升级 / 卸载

```sh
dsh plugin --profile web add @mzzsfy/dsh-think-expand      # 升级到最新发布版本
dsh plugin --profile web remove @mzzsfy/dsh-think-expand   # 卸载
```

插件 Host 半区为空壳,无任何 Host 端状态;卸载后重载页面即恢复官方默认行为。旧版本开关的 settings 字段残留不影响任何行为。

## 测试

```sh
pnpm --dir packages/dsh-think-expand test
# 或
node --test packages/dsh-think-expand/test/*.test.mjs
```

覆盖:上表全部行为场景、置底判定与置底回补判定(阈值边界/高度变化可解释偏离/用户滚开不回补)、uid 行身份(同开头历史行不劫持定位、已读标记不拦同开头新行)、suppressManual 首扫、批量 running 降级、识别失败降级、空正文降级、工具机场景(目标行展开/已读/手动/manual 接管不收/接管收起/preparing 跳过/无行不干预/首扫中性/双机状态隔离)、双实现 parity(场景 + 导出键守卫 + 逐函数源码对比)、client.js 语法检查与样式 data-plugin 守卫。

## License

MIT

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md` 与本包 `兼容性测试.md`。
