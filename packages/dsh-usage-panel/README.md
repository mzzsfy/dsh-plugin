# @mzzsfy/dsh-usage-panel(用量面板)

DeepSeek Harness 双端插件:在「设置 → 账号余额」手动配置多组(上限 20 个)LLM 平台账号(API 地址 + Key),定期自动查询并展示每个账号的余额、额度与历史趋势;刷新评估越过逻辑点(用量阈值穿越 / 余额阈值穿越 / 额度窗口重置)时,经 webhook、dsh-im、页内 toast 三通道推送通知。无自动发现;配置持久化在本机 `~/.dsh/dsh-usage-panel/accounts.json`,查询快照留存于同目录 `history.json`。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-usage-panel
```

`--profile` 必填;本包为 web 平台向,建议 web profile。

或手动把以下条目加入 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 列表(勿写入 profile 根 cordis.yml——该文件每次启动会被重写,手动行会静默丢失):

```yaml
- insert:
    - id: usage-panel
      name: '@mzzsfy/dsh-usage-panel'

- insert:
    - id: usage-panel-dsh-common-tools
      name: '@mzzsfy/dsh-common-tools'
```

公共 client 依赖的装载行同样由本包提供,手动路径两行都要写;宿主按包名把各消费插件的装载行合并成一份 client 模块(见 [DEVELOPMENT/client-dependency.md](../../DEVELOPMENT/client-dependency.md))。

## 支持的平台

| 类型 | 默认地址 | 查询接口 | 展示 |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `GET /user/balance` | 各币种余额 + 可用性 |
| `openrouter` | `https://openrouter.ai` | `GET /api/v1/credits` | 剩余/总额/已用(USD) |
| `kimi` | `https://api.kimi.com/coding` | `GET /v1/usages` | 5小时/7天窗口进度条 |
| `zhipu` | `https://open.bigmodel.cn` | `GET /api/monitor/usage/quota/limit` | 5小时/7天进度条;兼容 v3 `CREDIT_LIMIT` |
| `minimax` | `https://api.minimaxi.com` | `GET /v1/api/openplatform/coding_plan/remains` | 5小时/7天进度条 |
| `newapi` | 需填写站点地址 | `GET {站点}/api/usage/token` | quota/500000 换算 USD |
| `custom` | 需填写完整 URL | 任意 HTTP 端点 | 按 extract 规则提取 |

预设类型均可用「API 基础地址」覆盖默认(如中转站),Key 按平台要求以 `Authorization: Bearer <key>`(智谱为裸 key)发送。

## 读数展示

- 面板顶部总览条:账号状态(正常/失败/未查询)、按币种余额合计(优先 `remaining`,缺省用 `total`)、全局最高额度占用、最近查询时间(成功与失败尝试均计)
- 额度窗口(5小时/7天)渲染为进度条,绿/橙/红三档(70%/90% 阈值),右侧直接显示百分比与重置剩余时间(随数据刷新更新);余额账户有已用/总额时同样渲染
- 鼠标悬停读数行(键盘聚焦卡片等效)显示明细:余/总额、已用、赠送、充值、重置时间、账户可用性
- 卡片头部:状态点 + 账号名 + 平台类型徽章 + 套餐档位徽章(智谱 `data.level` / Kimi membership),更新时间以相对时间展示(悬浮显示完整时间;查询失败显示“查询”而非“更新”)
- 额度预测仅在查询成功、当前窗口内至少 2 个采样点且观测跨度 ≥1 小时、有重置时间,且当前窗口利用率斜率 >0.05 个百分点/小时、按该斜率预计会在重置前触顶时提示预计触顶时长;其余情况不提示(不输出“安全”结论)
- 余额预测仅当读数带剩余额度、近 7 天序列至少 2 点且观测跨度 ≥1 小时、日均下降时估算可用天数;无剩余额度字段(如 DeepSeek 官方余额接口)在下降时显示日均变化与“剩余余额未知”;remaining 为 0 时显示“余额已耗尽”;持平/回升只显示变化

## 定期查询与趋势(v2)

- 定期查询:时间驱动调度——全账号统一每 10 分钟查询一次(余额阈值等通知最长延迟约 10 分钟);上次尝试查询时刻随配置持久化,宿主重启后调度无缝衔接。定时轮询为软依赖:宿主 timer 服务不可用时仅停用自动轮询,面板显示降级提示,手动查询与全部配置能力不受影响
- 失败退避:单账号失败按指数退避(基期 = 统一查询间隔,×2 封顶 8 倍),成功即恢复。退避与到点判定独立叠加,二者皆过才发起查询。面板打开触发的自动查询同样受退避约束,手动刷新不受限
- 历史快照:按序列分档落盘 `history.json`(5 小时滚动 → 10 分钟粒度留 7 天;7 天 / 月 / 余额 → 小时粒度留 30 天),档内去重,超期修剪,硬点数上限兜底;删除账号时其历史序列同步清理,历史写盘失败不静默(响应带 `historyWarning` 并在宿主日志留痕,面板提示「已保存但历史清理失败」)。落盘走「临时文件 + rename」,写满或中断时旧 `history.json` 保持完整;并发 `ensure` 共享同一次读盘,第二个调用不会拿到读盘前的空表(否则会把空表写回覆盖历史)
- 趋势视图:悬浮账号卡片按已有序列(5小时/7天/月/余额)分别成图,每图最多取最近 24 点(5小时序列约 4 小时、7天序列约 24 小时,完整范围见详情);标题行直接显示最新值与较前值变化,图表带 Y 轴刻度、X 轴时间端点与悬停游标(竖线 + 精确时间/数值提示);单位由当前读数推导:余额/月按币种金额,额度窗口接口给出 `remaining`+`limit` 时为剩余计数,否则为利用率百分比;绝对值 / 差值双视角
- 详情对话框:长窗口 / 月 / 余额均可切近 7 天 / 30 天 / 全部,5 小时短窗口仅近 7 天 / 全部;所选范围至少 2 个采样点才显示最新/均值/最低/最高/总变化摘要,无采样点时不显示摘要且不可导出 CSV;有数据时提供较前值明细表与 CSV 导出
- 历史文件解析失败时自动备份为 `history.json.bak` 并暂停写入(防空数据覆盖);形状校验包含「序列档位必须与键后缀一致」(`:5h`→10m,`:7d`/`:month`/`:balance`→1h),声明漂移或残缺键同样按损坏处理;`history.json` 被移除或恢复为可解析内容后自动恢复写入,`.bak` 是损坏前的最后数据,删除前请确认不再需要。`accounts.json` 同构守卫:损坏或形状不符时备份为 `accounts.json.bak` 并拒绝一切写入(防账号 Key 被空配置覆盖);只有原路径重新出现可解析的 `accounts.json` 才解除(备份移走本身不算恢复),损坏期间所有保存/删除请求返回 400
- 月窗口序列 `月` 由 host 侧按当月余额快照聚合产出

## 通知(v3)

刷新(自动轮询与手动查询)本身不是通知类型,而是评估时机:每次查询成功后评估读数,**越过逻辑点才触发一个事件**,通知关闭时评估短路零成本。

### 通知类型与沿触发

| 类型 | 触发逻辑点 | 防抖 |
| --- | --- | --- |
| 用量阈值 | 窗口利用率上穿阈值(全局默认 90%,账号可覆盖) | 沿触发:触发一次即解除武装,窗口重置后恢复 |
| 余额阈值 | 可用余额下穿阈值(数值即启用,留空不评估;口径 remaining 优先、缺失回落 total,币种随读数) | 沿触发:充值回升到阈值上方后恢复武装 |
| 窗口重置 | 额度窗口 `resetsAt` 轮转(5小时/7天等) | 每窗口生命周期一次,内容为上一窗口峰值利用率 |

沿触发状态与窗口峰值基线随账号持久化在 `accounts.json`,宿主重启不重发。

### 规则模型

- 全局规则(host settings `usage-panel` 命名空间的 `notify` 键,面板与 settings.yaml 等价,热生效):

```yaml
usage-panel:
  notify:
    enabled: false                # 总开关,默认关闭
    quotaThresholdPct: 90         # 用量窗口阈值百分比,(0,100]
    balanceThreshold: null        # 余额阈值,null 为不启用
    resetNotice: true             # 窗口重置时通知上一窗口峰值
    toast: true                   # 页内 toast 通道
    webhookUrl: ''                # webhook 目标 URL,空串禁用;面板只回显是否已配置,输入框留空表示保持现值(清除走显式「清除」)
    imTargets: []                 # dsh-im 投递目标 [{botId, targetId}]
```

- 账号覆盖:账号表单「通知规则覆盖」折叠区,仅 `quotaThresholdPct` / `balanceThreshold` / `resetNotice` 三字段,**字段级合并**,留空继承全局;通道配置全局统一。

### 通知通道

- webhook:host 直发(Slack-compatible `{text}` + 结构化字段),超时 10 秒不重试,fire-and-forget;地址须为不含 userinfo 的 http(s) URL,面板「保存并测试」返回真实投递结果(失败明细已遮住地址中的凭据)
- dsh-im:安装 [@xmanrui/dsh-im](https://www.npmjs.com/package/@xmanrui/dsh-im) 后自动启用,面板粘贴 Bot ID 加载其已保存投递目标目录,勾选即自动保存;支持绑定多个 bot,已绑 bot 以标签展示,点标签加载该 bot 目录,× 一键取消注册(移除该 bot 全部目标);触发逻辑与 webhook 完全一致(fire-and-forget 不重试);目标的新建与平台测试仍在 dsh-im 设置页完成,此处仅选择;「测试 IM」逐目标返回真实结果
- 页内 toast:host 内存投影(环形 20 条 / 60 秒过期,version 单调递增),浏览器订阅公共依赖 `@mzzsfy/dsh-common-tools` 的 WS 总线 `@mzzsfy/dsh-usage-panel` 插件通道,首连、重连与变更时拉取快照,经其 toast 展示(语义与 turn-notify 同构);同源窗口通过 IndexedDB 事务认领同一事件,提交后仅认领成功的窗口呈现;认领记录自认领起按浏览器本地时间保留 90 秒（60 秒投影窗口 + 30 秒请求消费窗口）,不按单窗旧快照删除。快照请求及后续认领共用超时信号,不比较宿主与浏览器时钟。IndexedDB 不可用时控制台通告降级,仅保证本窗口去重。公共依赖由本包 `cordis.patch.yml` 自带的装载行 `usage-panel-dsh-common-tools` 引入(依赖 `^0.5.0`),为总线订阅的硬依赖;多个消费插件的装载行由宿主按包名合并成一份 client 模块。host/client 在 `apply(ctx)` 调用 `setupCommonTools(ctx)`,通道身份来自 `ctx.fiber.entry.options.name` 的完整 npm 包名;client 各实例退出时释放自己的订阅，同一 factory 的存活实例接管一次共享通知工作，最后实例退出才中止共享快照；跨 factory HMR 清理旧代

### 通知接口

- `GET /api/usage-panel/notifications`:通知投影即时全量快照,响应 `{units, version}`;变更通知由公共 WS 总线插件空间推送
- `GET|POST /api/usage-panel/notify-config`:全局通知规则;`webhookConfigured` 布尔回显是否已配置,地址明文不回传(修改需重新输入,清除走显式空串写入)
- `POST /api/usage-panel/test-webhook` / `POST /api/usage-panel/test-im`:测试投递,返回真实结果
- `GET /api/usage-panel/im-targets?botId=`:列出 dsh-im 该 bot 已保存投递目标

全部路由统一经共享 `withRouteGate`(注册处下沉):宿主闸门(`connection.requestRejection`)+ 写路由守卫——同源比对 Origin↔Host(大小写不敏感)与 content-type 媒体类型精确匹配 `application/json`(允许 charset,`text/plain; application/json` 之类子串伪装 400),阻断跨站 drive-by 改写账号配置(含注入指向攻击者端点的账号)、通知配置或借测试通道外发;守卫拒绝回共享信封 `{ error }`(跨源 403 / 非 JSON 400 / 读体超限 413),业务错误仍为 `{ error }` 业务文案;非 GET/POST 方法一律 405;已知边界同 turn-notify:同源守卫不防 DNS rebinding,该暴露面属 host webserver 全部 /api 路由的存量问题,应在 host 层统一解决。

## custom 提取规则

`extract` 是 JSON 对象,`remaining` 必填;读数按余额(balance)形态呈现并参与余额阈值通知、余额历史序列与月窗口聚合。取值支持四种形式:

- 点路径字符串:`"data.total_available"`
- 数字常量:`42`
- 运算对象:`{"op": "add" | "subtract", "paths": ["a.b", "c"]}`、`{"op": "divide", "path": "a.b", "by": 500000}`
- 混合:`maxBudget` / `spend` 可选,`unit` 指定币种(默认 USD)

数值提取为严格模式:空串/null/布尔/千分位字符串均视为提取失败,不会伪造成 0。

custom 端点支持自定义请求方法(GET/POST/PUT/DELETE/PATCH)、请求头(JSON)与请求体(非 GET 可选),并提供 NewApi 示例一键填入。

## 架构与依赖

- Host 半区(`src/index.js`):Node ESM,`fetch` 直连平台 API(超时 20s),通过 `webServer` 服务暴露 `/api/usage-panel/*` 路由(accounts / query / history / settings / notifications / revision / notify-config / test-webhook / test-im / im-targets);需要 DSH 提供 `webServer` 服务与 `settings` 服务(通知规则持久化);`timer` 服务(定期轮询)为软依赖,缺失时仅停用自动轮询
- Client 半区(`src/client.js`):DSH client-modules 自注册格式(`__ModuleLoader__.load`),注册 `settings.section` 槽位;需要 `slots` 服务与 `react` 18;公共依赖 `@mzzsfy/dsh-common-tools`(依赖 `^0.5.0`,装载行 `usage-panel-dsh-common-tools` 随本包自带)的 WS 总线与 toast 均为硬消费
- 纯逻辑层(`src/parsers.mjs` / `src/poller.mjs` / `src/history.mjs` / `src/historyStore.mjs` / `src/notify.mjs`):无 IO 数据变换,`npm test` 覆盖解析、时间驱动调度与退避、快照留存、持久化守卫与规则合并 / 沿触发评估 / 投影认领 / 配置校验;趋势图 SVG 点位算法内联于 client.js(唯一实现),client LOGIC 段(趋势几何/单位/总览/预测/倒计时/CSV)由 `test/client-trend.test.mjs` 覆盖

## 安全提示

账号 Key 以明文保存在 `~/.dsh/dsh-usage-panel/accounts.json`,注意不要分享该文件;Key 只存在与使用于宿主进程,接口响应不回传账号 Key(仅带 `hasKey` 标志,保存时空值表示保持不变),`baseUrl` 与 `custom.url` 的敏感查询参数及 userinfo(用户名/密码任一非空即视为凭据,`https://token:@host` 的 token 在用户名位)、自定义头/体与 `last.error` 上游错误体同样在响应侧脱敏。自定义头值、自定义体与上游错误体一律按凭据面处理:头值全部置占位;体字段名不可信(`access_key`/`auth`/`pin` 等命名各异,白名单拦不住),JSON 体内所有非空字符串值都置占位、数值与布尔结构保留,非 JSON 体整体占位;体值同时进 `last.error` 的脱敏集合,上游把请求原样写进错误体时不会漏;回存时脱敏占位按旧账号对称还原,无法还原的占位拒绝落盘。保存入口只接受可解析的 http(s) 绝对地址,非法 URL(如 `https://user:pass@` 这种缺主机名的串)直接 400 且错误信息不回显原值;历史遗留的非法 URL 无法按分量脱敏,响应整体置 `[已隐藏]`,`last.error` 里的同串凭据按文本形态遮住,用户需重新填写地址才能保存。webhook 地址不接受 userinfo,接口只回显是否已配置,投递失败明细同样先遮住目标地址的 userinfo 再回给面板。路由访问控制由 DSH web 鉴权层统一负责。

## 已知取舍

- spark / feebar 视图组件的前端渲染逻辑以内联方式维护,未做 host/client 双端 parity 测试,属已知技术债务(点位算法纯客户端消费,单一实现无漂移面)
- 早期版本允许无 `id` 的账号(落盘时按索引一次性补齐);当前前端保存时总携带 `id`,不再做旧数据特判
- 账号卡片渲染未做 memo 化、趋势浮层常挂载:数据规模受账号上限(20)与悬浮窗口点数(24)双重钳制,未做规模性能测量,后置观察

## 开发安装(仓库工作副本直挂,不经 npm 发布)

```sh
node scripts/dev-link.mjs dsh-usage-panel   # 仓库根执行:归一 profile 依赖行 + 挂 junction
```

工作副本以 junction 挂进 profile,改代码保存即热重载(host 半区)或刷新页面生效(client 半区),无需发版;规约与全仓归一见仓库根 `node scripts/dev-link.mjs all`。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。
