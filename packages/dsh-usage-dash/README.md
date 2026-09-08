# @mzzsfy/dsh-usage-dash

用量统计面板(dsh 插件)。天/小时/分钟三粒度 token 与请求统计,设置页自绘面板:汇总卡、活动热力图、缓存命中率曲线、模型 donut 与列表、回扫状态行、会话底栏接管与单轮用量费用行,支持 en/zh 双语与可选费用估算。复刻自 [HaoyueQin/dsh-usage-statistics-panel](https://github.com/HaoyueQin/dsh-usage-statistics-panel),感谢原作者。

## 功能(全阶段已交付)

设置页「使用统计」区块:

- 三粒度视图:按天(最近 7/14/30/90 天/自定义日期段)、按小时(最近 24/48/72 小时)、按分钟(最近 60/180/360 分钟,10 分钟桶粒度),后两者为滚动窗口
- 汇总卡六张:Tokens 用量(服务商总口径)、会话数量、请求数量、最常用模型、平均缓存命中率、活跃天数(恒按天口径,不随视图切换);配置定价规则后 Tokens 卡追加估算费用副行
- 活动热力图:GitHub 风格周列×星期行,26 周窗口,五档色阶,悬停明细
- 缓存命中率曲线:日粒度命中率 + 右侧副轴,悬停显示当日命中率与 token 明细(配置定价规则后附当日估算费用行,受「费用显示」开关)
- 模型 donut 与列表:按 token 前 5 模型占比环形图(中心为总量),列表含命中率与占比,悬停联动
- 三粒度堆叠柱状趋势图(数据量大时裁最旧并提示)
- 回扫状态行默认隐藏:首次启用自动回扫历史会话,运行中显示进度,出现跳过会话/写入失败/采集错误时提示;「重建」按钮在面板工具栏,二次确认(3 秒)后清库重扫
- 会话底栏接管:替换官方信息行为增强版,偏好卡三个开关——精确缓存命中率(两位小数)、会话 Token 明细(总/命中缓存/未命中缓存/输出)、费用显示(底栏费用项与趋势 tooltip 费用行);三开关全关时与官方逐字节一致
- 会话尾部单轮行:每轮对话结束后动作行上方显示该轮 token 摘要与估算费用(最新一轮常显,历史轮悬停显现,触屏恒显;有产出文件的轮次自动让位产物行)
- 定价规则编辑器:设置面板内编辑模型与四桶单价,货币为全局切换(「定价规则」标题右侧,整表统一,不逐模型设置),显式「保存」整表写入
- 双语:跟随宿主语言设置(设置 → 通用 → 语言)即时切换 en/zh
- 数据 API 守卫:POST 同源校验 + JSON content-type(与 dsh-usage-panel 同构),局域网远程访问可用

口径:token 总量 = 未缓存输入 + 输出 + 缓存读 + 缓存写;命中率 = 缓存读 / (缓存读 + 未缓存输入 + 缓存写);桶按 host 本地时区。保留策略:天桶永久,小时桶固定 15 天,分钟桶默认 2 天且上限 48h(设置项 `minuteRetentionDays`,0 = 禁用分钟桶)。

## 定价与费用估算

规则存于设置存储域,经 `GET/POST /api/usage-dash/pricing` 读写(响应含单调 revision);设置面板编辑器为常规入口。

规则形态:`{ model, currency, price: { input, output, cacheRead, cacheWrite }, conditions }`,单价单位固定「每百万 token」。货币为编辑器级全局设置:「定价规则」标题右侧切换,打开编辑器即按首个非空货币归一显示,切换或保存后整表统一;wire 形态不变(仍为逐规则字段)。

- 模型匹配:`model` 精确相等的规则按数组序取首个命中;无命中回落 `*` 通配规则;仍无命中不计费用并计 unpriced
- 条件类型(数组内 AND,空数组恒生效):
  - `dailyWindow`:`{ from: 'HH:MM', to: 'HH:MM' }` 每日时段,from<to 含头不含尾,from>to 跨午夜,from===to 全天生效
  - `weekdays`:`{ days: [0-6] }` 星期几,0=周日,空数组不成立
  - `monthDays`:`{ from, to }` 月内号段双闭整数,from>to 跨月环绕(账单周期),2 月无 31 号自然不触发
  - `dateRange`:`{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }` 字典序双闭,倒序视为配置错误不成立
- 费用精度:**小时级**——聚合按小时桶起点时刻匹配价格,分钟槽费用由其所属小时桶价格导出;改价即时生效,历史费用下次查询按新规则重算(不回溯账单)
- 时区口径:匹配与聚合均用 host 进程本地时区;client 侧注入点(底栏费用项/单轮费用行)按**浏览器本地时区**的当前时刻评估条件,跨时区访问时与面板费用存在预期内偏差;所有费用均为按当前费率的估算值(标注「≈」与「估算」),不构成账单

## 与 dsh-usage-statistics-panel 的关系

本插件复刻自 [HaoyueQin/dsh-usage-statistics-panel](https://github.com/HaoyueQin/dsh-usage-statistics-panel)(npm 包 [dsh-usage-statistics-panel](https://www.npmjs.com/package/dsh-usage-statistics-panel)),感谢原作者 HaoyueQin 的开源实现。在其基础上补足缺失的小时/分钟粒度与热力图/曲线/donut,移除其远程访问限制。路由(`/api/usage-dash/*`)与存储域(`usage_stats`)均不冲突,共存只是重复采集。

同装时两插件争抢会话底栏 'stats' 槽位:槽注册表对同 id 同 priority 直接抛错,本插件以更低 priority 注册遮蔽原插件(lowest renders),同装时本插件胜出、卸载本插件后原插件恢复。仍建议卸载原插件以避免重复采集。

## 注意

装载本插件需要它在 `dsh.profile.bundles`(`dsh plugin --profile web add @mzzsfy/dsh-usage-dash`);bundles 表变化不支持热重载,需重启 dsh 生效。之后代码改动:宿主半区经 dev-link 自动热重载,client 半区刷新页面即生效。

双语能力经宿主 `locale` 服务声明装载(与官方插件同构);极端旧宿主无该服务时插件整体未激活(cordis 门控,升级宿主即自愈)。
