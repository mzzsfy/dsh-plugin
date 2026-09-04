# dsh-plugin

DSH(DeepSeek Harness)插件维护主仓库(monorepo)。

## 仓库结构

```
dsh-plugin/
├── packages/         # DSH 插件包
├── scripts/          # 发版脚本、rs-workflow 冒烟测试脚本
├── tests/            # 仓库级测试
└── docs/             # 本地资料;不入库
```

> npm 发行的包使用统一使用`@mzzsfy/*`格式

## 插件一览

| 名称 | 功能 | 简单原理 | 类型 |
| --- | --- | --- | --- |
| @mzzsfy/dsh-usage-panel | 多平台 LLM 账号余额与额度面板:配置 DeepSeek/OpenRouter/Kimi/智谱/MiniMax/NewApi/自定义端点,定期自动查询并画趋势图 | 定时调用各平台查询接口并存快照(分频 + 指数退避防风控),面板用自绘 SVG 画余额/额度趋势,快照分档留存 | DSH 双端插件(settings 槽位 + web 路由) |
| @mzzsfy/dsh-maintain | 版本与运维一体化:自动发现新版本、一键升级、安全重启,重启后页面自动恢复 | 监测 npm dist-tag 发现新版本;升级即执行自定义命令(`{tag}` 占位符);重启走优雅退出(5 秒兜底),页面轮询检测宿主恢复后自动刷新 | DSH 双端插件(settings 槽位 + web 路由) |
| @mzzsfy/dsh-think-expand | 流式思考自动展开:始终显示最新一条思考,手动操作优先,打开会话仅展开最后一条,卸载无残留 | 纯前端观察流式渲染,新思考出现即收起上一条;无设置项,安装即自动生效 | DSH 纯前端插件(client 模块,DOM 观察) |
| @mzzsfy/dsh-turn-notify | 回合完成通知:合成音效 / 系统弹窗 / webhook / IM 四通道,六类事件独立开关,多窗口只响一次 | host 端观察回合状态,client 端发声;同浏览器多窗口按 localStorage 认领保证唯一发声;非回环 HTTP 访问降级 toast + 标题闪烁 | DSH 双端插件(host 观察投影 + client 发声) |
| @mzzsfy/dsh-session-manager | 会话管理三合一:超期会话自动归档(阈值可配)、归档面板(取消归档 / 两段式删除 / 回收站还原)、归档推送提示 | host 定期扫描会话目录,按阈值幂等归档;删除移入系统回收站可恢复,面板维护已删台账并支持一键重新挂载 | DSH 双端插件(host 自动归档 + client 面板) |
| @mzzsfy/dsh-rs-workflow | 若水工作流一体化:安装即得 rs-workflow agent 模式(协议技能 + 编排引擎 + 模式组合),带工作流设置表单与配置工具 | 一个包三种行角色:settings 行注册设置页表单,preset-sync 行把 agent 预设自释放到用户预设根,tool 行注册 rs_workflow_config 模型工具 | DSH 插件(settings + preset-sync + tool 三角色) |
| @mzzsfy/dsh-llm-pi-gateway | newapi 等 LLM 网关的会话粘性路由,提升网关侧 prompt 缓存命中;装上即零感知接管官方 pi-ai 路由,卸载即还原 | 请求体按协议写入会话标记(anthropic metadata.user_id / openai prompt_cache_key,sha256 派生不暴露内部 id),compat 全控、metadata 模板透传、静态 headers 兜底;bundle patch 以官方 schema 接管路由 | DSH host 端插件(pi-ai 透传 adapter) |
| @mzzsfy/dsh-model-capability-editor | 模型能力编辑器:可视化编辑各模型的思考档位与图片输入(多模态)声明 | 读取官方 describe 拿当前声明,表单编辑后整组写回 settings.yaml(未编辑条目保留,冲突字段级重放不静默覆盖);官方模型行内直接挂编辑块,锚点破坏时浮动入口兜底 | DSH 纯前端插件(模型页行内注入 + 浮动回退) |
| @mzzsfy/dsh-settings-nav-icons | 设置导航分区图标:把千篇一律的齿轮换成各分区专属图形,重载页面即恢复官方齿轮 | 观察设置导航 DOM,按分区显示文本匹配贴图;插件面板可声明自己的图标,语言切换自动重贴 | DSH 纯前端插件(DOM 观察) |

## 安装与更新:缩短 pnpm 宽限期

pnpm 的 `minimumReleaseAge` 是新包发布后的安装宽限期(防供应链投毒)——刚发版的插件会因此装不上或装到旧版。建议永久改为 6 小时:

```sh
pnpm config set --global minimumReleaseAge 360
```

单位为分钟(6h = 6*60 = 360),写入全局 pnpm 配置,对所有项目生效。刚发版想立刻安装,可单次绕过:`pnpm install --config.minimum-release-age=0`。

## 开发与测试

要求 Node >= 22(各包 engines 字段;其中 dsh-settings-nav-icons 为 >=20,dsh-rs-workflow 未声明 engines)。

- 仓库级测试:根目录执行 `node --test tests/engine.test.mjs`(rs-workflow engine.js 编排脚本验收)
- 包内测试:除 @mzzsfy/dsh-rs-workflow 外的 8 个包目录执行 `npm test`(即 `node --test "test/*.test.mjs"`);@mzzsfy/dsh-rs-workflow 无 npm test,只有下面的冒烟脚本
- @mzzsfy/dsh-rs-workflow 冒烟:`node .\scripts\test-workflow-plugin.mjs`(默认测已安装副本,传入包目录路径可测任意构建;仓库内副本解析不了 peer 依赖,需先安装再测)

## 开发态链接(dev-link)

```sh
node scripts/dev-link.mjs all          # 归一 profile 依赖行(^线上最新)+ 挂工作副本 junction
node scripts/dev-link.mjs <包名>       # 单包模式
node scripts/dev-link.mjs all --unlink # 恢复纯 registry 版本
```

- 开发态合法形态唯一:依赖行 = semver,工作副本挂载 = junction;pnpm 对 file: 是整目录拷贝,禁止 file:/link: 依赖行
- link 时在 home 补丁层(~/.dsh/cordis.patch.yml)维护 hmr 覆盖行:仓库 packages 保存即热重载(host 半区约 1 秒,client 半区刷新页面),卸链时移除

dsh-usage-panel 的无 IO 纯逻辑层(`src/parsers.mjs`)由其 npm test 覆盖。包元数据:dsh-usage-panel peerDependencies 为 `@deepseek-ai/dsh-settings`(>=0.1.1-rc.2)、`@deepseek-ai/schemastery`(>=3.18.0)与 `react`(^18.2.0);@mzzsfy/dsh-rs-workflow 为 `@deepseek-ai/dsh-settings`(^0.1.1-rc.2)、`@deepseek-ai/dsh-tools`(^0.1.1-rc.2)与 `@deepseek-ai/schemastery`(^3.18.1);@mzzsfy/dsh-maintain 为 `@deepseek-ai/dsh-settings`(>=0.1.1-rc.2)、`@deepseek-ai/schemastery`(>=3.18.0)与 `react`(^18.2.0)。peer 均由 pnpm 标准安装的虚拟层链入解析。

## 发布

推荐走仓库级发版脚本(内置版本校验、测试、发布后回读验证与打 tag):

```sh
node scripts/publish.mjs dsh-usage-panel              # 发单个包
node scripts/publish.mjs all                          # 按序发全部
node scripts/publish.mjs <包名> --dry-run             # 只打印动作,不执行
node scripts/publish.mjs <包名> --bump patch          # 本地版本已发布时自动升 patch 再发
```

规则:

- git tag 与包版本一一对应,tag 形如 `<npm包名斜杠换连字符>-v<版本>`(如 `@mzzsfy-dsh-usage-panel-v0.1.0`),发布成功后脚本自动打在本地,推送由维护者执行(`git push --tags`);本规范自本仓库启用发版脚本起生效,启用前的历史版本不补 tag
- 本地版本低于线上时拒绝发布(防版本回退);等于线上时默认不动作(幂等,重跑安全)
- 各包 package.json 的 `npmPublish` 脚本是无校验的单包发布命令,仅在明确清楚后果时使用
- 发布要求本机已 `npm login`(2FA 账号需配置 otp 或使用 automation token)

## License

MIT,见 [LICENSE](LICENSE)。
