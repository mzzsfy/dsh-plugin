# @mzzsfy/dsh-usage-stats(用量统计)

DeepSeek Harness 静态插件:统计本 DSH 内所有会话的模型调用 token 用量与估算费用。数据全部来自本地 `llm/stream` 事件,外部请求仅 models.dev 单价表与 USD->CNY 汇率(均带持久化缓存);账本持久化在 `~/.dsh/dsh-usage-stats/ledger.json`(按日聚合 + 顶层会话索引,保留 180 天)。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-usage-stats
```

`--profile` 必填;本包为 web 平台向,建议 web profile。

或手动把以下条目加入 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 列表(勿写入 profile 根 cordis.yml——该文件每次启动会被重写,手动行会静默丢失):

```yaml
- insert:
    - id: usage-stats
      name: '@mzzsfy/dsh-usage-stats'
```

## 功能

- 全屏仪表盘(shell.overlay 覆盖层,设置区入口打开):本月费用 Hero 与按日均外推预计、今日/本周环比、近 7/30 天趋势(费用/Token 切换)、月历热力图、历史会话明细(读顶层会话索引跨日合并,按费用倒序)、CSV/JSON 导出
- 输入区费用条:本轮费用 + 会话累计 + 近 7 天 sparkline;支持自定义 JS 函数(设置区内嵌编辑框,试运行回显错误,异常自动回退原生渲染;勿粘贴来源不明的代码)
- 侧边栏费用卡:本月费用主数字 + 今日副行
- 计价:自定义单价表(设置区,CNY/USD 原生币种)命中优先于 models.dev 目录价,匹配顺序 provider/model 精确 -> 模型名精确 -> 最长前缀;原生币种计价后统一折 USD 入账本,展示层按当前汇率折 CNY,估算非账单
- 汇率:腾讯财经 -> open.er-api -> 内置兜底,每 6 小时刷新,落盘 `rates.json`,重启沿用上次汇率
- 设置区维护:导出、两段式确认清零(days 与会话索引一起清)
- 非 localhost 访问:全部通道不做来源判断,安全依赖登录层(dsh-web-startup-auth)

## API 通道

| 通道 | 方法 | 用途 |
| --- | --- | --- |
| `/api/usage-stats/summary` | GET | 今日/本月/近期聚合与汇率 |
| `/api/usage-stats/session` | POST | 单会话累计读数(顶层索引) |
| `/api/usage-stats/reset` | POST | 清零账本 |
| `/api/usage-stats/dashboard` | GET | 仪表盘聚合一次取全 |
| `/api/usage-stats/export` | GET | CSV(按日/按会话)与全量 JSON |
| `/api/usage-stats/prices` | GET/POST | 自定义单价表读写(settings 命名空间) |

## 架构与依赖

- Host 半区(`src/index.js`):监听 `llm/stream` Waterfall 事件计量每次调用的 usage;`webServer` 路由;需要 `webServer` 服务,自定义单价经 `settingsNamespace('usage-stats')` 持久化
- Client 半区(`src/client.js`):DSH client-modules 自注册格式(`__ModuleLoader__.load`),注册 `shell.overlay` / `settings.section` / `conversation.composer.dock` / `sidebar.footer.action` 槽位;需要 `slots` 服务与 `react` 18
- 纯逻辑层(无 IO,`npm test` 覆盖):`src/ledger.mjs` 账本聚合与会话索引、`src/pricing.mjs` 币种折算与价格匹配链、`src/rates.mjs` 汇率解析、`src/csv.mjs` CSV 防注入序列化、`src/dashboard.mjs` 仪表盘聚合、`src/feebar.mjs` JS 费用条沙箱求值

## 数据文件

| 文件 | 说明 |
| --- | --- |
| `~/.dsh/dsh-usage-stats/ledger.json` | 运行时账本,可随时删除重建(等同清零) |
| `~/.dsh/dsh-usage-stats/rates.json` | 汇率缓存与最后成功时间 |

v1 旧账本(无顶层 `sessions` 索引)载入时视为空索引并增量写入,不回填;历史会话明细自账本 v2 启用起累积。

## 已知取舍

- 自定义 JS 费用条错误仅在设置区「试运行」可见;运行期求值失败静默回退原生渲染,不做持续的错误提示
