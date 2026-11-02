# 更新日志

## 0.3.0（2026-11-02）

设置可递进、上游可观测、API 反代可用。

### 新增

- **搜索候选「看一眼」**：搜索结果行名称区点击直接进详情（同 browse 点进路径），与选择/加自选正交；refresh 支持 `securities` 对象形态（id+exchange+code），港美股候选（不在目录）不经目录解析按完整身份直拉行情。
- **市场浏览可点进详情**：浏览市场行点击直接打开该证券详情（行情/K线全可用，无需先加自选）；按需拉取该证券报价（collector 证券解析链扩展：自选→目录缓存兜底）；非自选详情以「加自选」为主操作并提供「返回市场」，别名等自选管理仅在自选详情呈现——自选定位回归"市场快捷方式"。
- **市场概览**：浏览市场页头部显示代表指数实时点位与涨跌幅（沪=上证指数 000001，深=深证成指 399001），随 browse 响应一并返回（`browse.overview`），指数拉取失败静默隐藏不阻断目录浏览；指数不入自选/目录，走东财 quotes 管道直拉并经延迟派生。
- **接口反代（API 端点覆盖）**：数据源实例可按适配器端点键替换请求地址（东财五个端点/腾讯两个端点，descriptor `endpointKeys` 下发标签），自建反向代理或镜像只需原样转发同路径；留空回官方默认。适配器端点表化（`DEFAULT_ENDPOINTS`+`endpointOf(ctx,key)`）。
- **实例级 HTTP 代理出口**：`providers[].proxy`（`http(s)://[user:pass@]host:port`），executor 按 URL 惰性缓存 undici ProxyAgent 注入 ctx.fetch；包不可用时该实例静默降级直连。
- **上游可观测**：executor 记录每实例最近 20 条请求环形日志（时间/能力·适配器/状态/耗时），快照 `providerStatus[].recentRequests` 下发；设置页实例卡「运行状态」折叠组展示，summary 标注代理态。
- **设置页递进信息架构**：「① 数据源 → ② 市场与能力 → ③ 显示偏好」三区块；实例卡内适配器一句话说明（descriptor `description`）、高级预算折叠、接口反代与运行状态分组。
- **列表概览横幅**：常驻显示启用数据源数与最近请求失败实例，「管理」直达设置页；K 线就绪市场数随横幅展示。

### 变更

- snapshot `providerStatus[]` 扩展 `proxy`/`endpointsCovered`/`recentRequests` 字段（向后兼容追加）。
- **延迟真实化**：适配器未声明延迟但带报价时间时，collector 按时间差派生（≤90 秒实时，否则延迟 N 秒）；四家适配器（东财/新浪/腾讯/Tushare）零改动自动生效，缺时间戳仍保守显示未知。
- 包内测试 131→141。

## 0.2.0（2026-10-31）

K 线图表与八市场支持。

### 新增

- **K 线图表**（lightweight-charts v5 vendor 内嵌，单文件装载）：分时（Area+均价线+昨收虚线，HH:mm 时间轴）、日K/周K/月K（蜡烛+MA5/10/20/60+成交量副图，红涨绿跌随显示偏好），周期按钮组+刷新+骨架/错误/空态，主题跟随宿主色板重涂。
- **八市场**：沪/深 A 股、港股（00700 五位补零）、美股 NYSE/NASDAQ（secid 动态归属）、日经、韩证、伦敦。市场元数据（币种/价差/时区）单源 MARKET_META 下发。
- **K 线数据管道**：东财 push2his 主源（klt 101/102/103、qfq）+腾讯 fqkline 备源（键名漂移兜底+qt[4] 昨收）；kline-cache 三档 TTL（trend 不落盘/日K 1h/周月K 24h），routingRevision 失效；executor 8s 滑动超时+failover。
- **多市场搜索**：候选带市场与币种徽标；remote 搜索市场面=启用实例适配器市场并集（suggest 全市场语义）。
- **一键为已启用市场配置K线**：设置页按钮走 check→configuration 合同（capability 并集全检）。
- 探针按市场代表证券直探（600519/000001/00700/AAPL/BABA/7203/005930/155.SHEL），八市场 verifiedByDefault=true。

### 修复

- 设置页 providers fieldset Array.map 缺右括号静默吞 children（M5.2）。
- 删除撤销横幅时序（M5.1）；watchlist securityId 八市场准入；kline GET query limit coerce；响应双层 data 包裹；路由上限 8→40；K 线额度/网络瞬时错误退避自动重试（按服务端 retryAfterMs）。
- 三角色评审收敛（2026-11-01）：宽屏详情返回入口常驻；一键 K 线成功/no-op 均有反馈且错误条可内联开启；搜索筛选补全八市场对称标签；移除"个股状态"死字段；别名 maxLength 对齐 30；高级预算项默认折叠；client 币种回退表删除（消除 GBP 漂移）。

### 兼容性

- `capability` 新增 `kline`；provider 合同 descriptor 需声明 kline 能力方可承载 kline 路由（registry 白名单强制）。
- 配置 routes 上限 8→40（八市场×5 能力全开 40 封顶）。
- 包内测试 131/131；端到端与三角色评审证据见 兼容性测试.md 2026-10-31 / 2026-11-01 节。
