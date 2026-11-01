# 更新日志

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
