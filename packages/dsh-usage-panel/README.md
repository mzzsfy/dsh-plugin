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
```

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

- 额度窗口(5小时/7天)渲染为进度条,绿/橙/红三档(70%/90% 阈值);余额账户有已用/总额时同样渲染
- 鼠标悬停读数行显示明细:余/总额、已用、赠送、充值、重置时间、账户可用性
- 卡片头部:账号名 + 平台类型徽章 + 套餐档位徽章(智谱 `data.level` / Kimi membership)

## 定期查询与趋势(v2)

- 定期查询:设置面板可调「轮询间隔(秒)」,默认 600,仅正数有效;短窗口账号每轮查询,长窗口 / 余额账号分频到约每小时一次。定时轮询为软依赖:宿主 timer 服务不可用时仅停用自动轮询,面板显示降级提示,手动查询与全部配置能力不受影响
- 失败退避:单账号失败按指数退避(基期 = 查询周期,×2 封顶 8 倍),成功即恢复;面板打开触发的自动查询同样受退避约束,手动刷新不受限
- 历史快照:按序列分档落盘 `history.json`(5 小时滚动 → 10 分钟粒度留 7 天;7 天 / 月 / 余额 → 小时粒度留 30 天),档内去重,超期修剪,硬点数上限兜底
- 趋势视图:悬浮账号卡片弹出 sparkline(自绘 SVG),短 / 长窗口独立成图,绝对值 / 差值双视角;「详情」对话框可切时间范围(长窗口 / 月 / 余额:近 7 天 / 30 天 / 全部;5 小时短窗口仅近 7 天 / 全部),含区间摘要与明细表
- 历史文件解析失败时自动备份为 `history.json.bak` 并暂停写入(防空数据覆盖);`history.json` 被移除或恢复为可解析内容后自动恢复写入,`.bak` 是损坏前的最后数据,删除前请确认不再需要
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
  pollIntervalSec: 600
  notify:
    enabled: false                # 总开关,默认关闭
    quotaThresholdPct: 90         # 用量窗口阈值百分比,(0,100]
    balanceThreshold: null        # 余额阈值,null 为不启用
    resetNotice: true             # 窗口重置时通知上一窗口峰值
    toast: true                   # 页内 toast 通道
    webhookUrl: ''                # 凭据,留空禁用;面板只写不回显
    imTargets: []                 # dsh-im 投递目标 [{botId, targetId}]
```

- 账号覆盖:账号表单「通知规则覆盖」折叠区,仅 `quotaThresholdPct` / `balanceThreshold` / `resetNotice` 三字段,**字段级合并**,留空继承全局;通道配置全局统一。

### 通知通道

- webhook:host 直发(Slack-compatible `{text}` + 结构化字段),超时 10 秒不重试,fire-and-forget;面板「保存并测试」返回真实投递结果
- dsh-im:安装 [@xmanrui/dsh-im](https://www.npmjs.com/package/@xmanrui/dsh-im) 后自动启用,面板可手动添加目标或从其已保存投递目标中点选,「测试 IM」逐目标返回真实结果;目标管理仍在 dsh-im 设置页
- 页内 toast:host 内存投影(环形 20 条 / 60 秒过期),浏览器半区约 5 秒轮询并经公共依赖 `@mzzsfy/dsh-toast` 展示;localStorage 单元级认领锁保证多窗口只弹一次。**toast 依赖由 session-manager 插件代挂**,未安装 session-manager 时此通道静默不可用,其余通道不受影响

### 通知接口

- `GET /api/usage-panel/notifications`:通知投影(轮询用)
- `GET|POST /api/usage-panel/notify-config`:全局通知规则;`webhookUrl` 属凭据任何响应不回传原文,仅 `webhookConfigured` 标志
- `POST /api/usage-panel/test-webhook` / `POST /api/usage-panel/test-im`:测试投递,返回真实结果
- `GET /api/usage-panel/im-targets?botId=`:列出 dsh-im 该 bot 已保存投递目标

写路由(notify-config POST / test-webhook / test-im)带同源守卫(Origin 与 Host 不符 403)与 JSON content-type 校验(text/plain 等简单请求 400),阻断跨站 drive-by 改写通知配置或借测试通道外发;已知边界同 turn-notify:同源守卫不防 DNS rebinding,该暴露面属 host webserver 全部 /api 路由的存量问题,应在 host 层统一解决。

## custom 提取规则

`extract` 是 JSON 对象,`remaining` 必填;取值支持四种形式:

- 点路径字符串:`"data.total_available"`
- 数字常量:`42`
- 运算对象:`{"op": "add" | "subtract", "paths": ["a.b", "c"]}`、`{"op": "divide", "path": "a.b", "by": 500000}`
- 混合:`maxBudget` / `spend` 可选,`unit` 指定币种(默认 USD)

数值提取为严格模式:空串/null/布尔/千分位字符串均视为提取失败,不会伪造成 0。

custom 端点支持自定义请求方法(GET/POST/PUT/DELETE/PATCH)、请求头(JSON)与请求体(非 GET 可选),并提供 NewApi 示例一键填入。

## 架构与依赖

- Host 半区(`src/index.js`):Node ESM,`fetch` 直连平台 API(超时 20s),通过 `webServer` 服务暴露 `/api/usage-panel/*` 路由(accounts / query / history / settings / notifications / notify-config / test-webhook / test-im / im-targets);需要 DSH 提供 `webServer` 服务与 `settings` 服务(轮询间隔与通知规则持久化);`timer` 服务(定期轮询)为软依赖,缺失时仅停用自动轮询
- Client 半区(`src/client.js`):DSH client-modules 自注册格式(`__ModuleLoader__.load`),注册 `settings.section` 槽位;需要 `slots` 服务与 `react` 18;`@mzzsfy/dsh-toast` 可选消费(动态 require,模块表缺失即页内通道停用,操作反馈降级 `console.warn`)
- 纯逻辑层(`src/parsers.mjs` / `src/poller.mjs` / `src/history.mjs` / `src/spark.mjs` / `src/notify.mjs`):无 IO 数据变换,`npm test` 覆盖解析、退避分频、快照留存、SVG 点位与规则合并 / 沿触发评估 / 投影认领 / 配置校验

## 安全提示

账号 Key 以明文保存在 `~/.dsh/dsh-usage-panel/accounts.json`,注意不要分享该文件;Key 只存在与使用于宿主进程,**任何接口响应都不回传 Key**(仅带 `hasKey` 标志,保存时空值表示保持不变)。路由访问控制由 DSH web 鉴权层统一负责。

## 已知取舍

- spark / feebar 视图组件的前端渲染逻辑以内联方式维护,未做 host/client 双端 parity 测试,属已知技术债务
- 早期版本允许无 `id` 的账号(落盘时按索引一次性补齐);当前前端保存时总携带 `id`,不再做旧数据特判

## 开发安装(不经 npm 发布直接装仓库副本)

```sh
dsh plugin --profile web add file:./packages/dsh-usage-panel
```

`file:` 安装指向仓库工作副本,改代码后重跑该命令即同步,无需发版。
