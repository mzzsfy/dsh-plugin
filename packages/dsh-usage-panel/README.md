# @mzzsfy/dsh-usage-panel(用量面板)

DeepSeek Harness 双端插件:在「设置 → 用量面板」手动配置多组(上限 20 个)LLM 平台账号(API 地址 + Key),定期自动查询并展示每个账号的余额、额度与历史趋势。无自动发现;配置持久化在本机 `~/.dsh/dsh-usage-panel/accounts.json`,查询快照留存于同目录 `history.json`。

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

## custom 提取规则

`extract` 是 JSON 对象,`remaining` 必填;取值支持四种形式:

- 点路径字符串:`"data.total_available"`
- 数字常量:`42`
- 运算对象:`{"op": "add" | "subtract", "paths": ["a.b", "c"]}`、`{"op": "divide", "path": "a.b", "by": 500000}`
- 混合:`maxBudget` / `spend` 可选,`unit` 指定币种(默认 USD)

数值提取为严格模式:空串/null/布尔/千分位字符串均视为提取失败,不会伪造成 0。

custom 端点支持自定义请求方法(GET/POST/PUT/DELETE/PATCH)、请求头(JSON)与请求体(非 GET 可选),并提供 NewApi 示例一键填入。

## 架构与依赖

- Host 半区(`src/index.js`):Node ESM,`fetch` 直连平台 API(超时 20s),通过 `webServer` 服务暴露 `/api/usage-panel/*` 路由(accounts / query / history / settings);需要 DSH 提供 `webServer` 服务与 `settings` 服务(轮询间隔持久化);`timer` 服务(定期轮询)为软依赖,缺失时仅停用自动轮询
- Client 半区(`src/client.js`):DSH client-modules 自注册格式(`__ModuleLoader__.load`),注册 `settings.section` 槽位;需要 `slots` 服务与 `react` 18
- 纯逻辑层(`src/parsers.mjs` / `src/poller.mjs` / `src/history.mjs` / `src/spark.mjs`):无 IO 数据变换,`npm test` 覆盖解析、退避分频、快照留存与 SVG 点位

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
