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

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| @mzzsfy/dsh-usage-panel | DSH 静态插件(settings 槽位 + web 路由) | 多平台 LLM 账号余额与额度面板:配置 DeepSeek/OpenRouter/Kimi/智谱/MiniMax/NewApi/自定义端点,v2 定期自动查询(分频 + 指数退避防风控)、余额/额度趋势图(自绘 SVG)、快照分档留存、非 localhost 直接访问 |
| @mzzsfy/dsh-rs-workflow | DSH 插件(一个包三种行角色:settings + preset-sync + tool) | 若水工作流一体化:settings 行注册 rs-workflow 设置页表单,preset-sync 行把 agent preset(模式组合 + 协议技能 + 编排引擎)自释放到用户预设根,tool 行注册 rs_workflow_config 模型工具 |
| @mzzsfy/dsh-maintain | DSH 静态插件(settings 槽位 + web 路由) | 版本与进程运维一体化:npm dist-tag 追踪监测新版本,一键执行自定义升级命令(`{tag}` 占位符),安全重启(appExit 优雅退出,5 秒兜底,重启后页面自动检测宿主恢复并刷新) |
| @mzzsfy/dsh-think-expand | DSH 纯前端插件(client 模块 + settings 槽位) | 流式思考自动展开最新一条:新思考出现收起上一条,手动意图优先,历史会话不干预,关开关即移除全部副作用 |
| @mzzsfy/dsh-turn-notify | DSH 双端插件(host 观察投影 + client 发声) | 回合完成通知三通道:合成音效/系统弹窗/webhook;同浏览器 profile 多窗口仅一份发声(localStorage 认领);六状态分类开关,非回环 HTTP 降级 toast + 标题闪烁 |
| @mzzsfy/dsh-session-manager | DSH 双端插件(host 自动归档 + client 面板) | 会话管理三合一:超期会话自动归档(阈值可配,幂等评估)、归档面板(取消归档/两段式删除)、删除移入系统回收站可恢复,归档推送 Toast 提示 |
| @mzzsfy/dsh-llm-pi-gateway | DSH host 端插件(pi-ai 透传 adapter) | 网关路由专用 adapter:全协议会话标记默认开启(anthropic metadata.user_id / openai prompt_cache_key,sha256 派生不暴露内部 id)、compat 全控、metadata 模板透传、静态 headers 兜底;无 GUI,settings.yaml 配置 |
| @mzzsfy/dsh-model-capability-editor | DSH 纯前端插件(settings.models.footer 卡片) | 模型能力编辑器:编辑 reasoningEfforts 档位(false/删除/off:null/线上拼写)与 input 多模态声明,describe 读取 + 整组写回(未编辑条目保留),冲突字段级重放绝不静默覆盖 |

## 开发与测试

要求 Node >= 22(dsh-usage-panel 的 engines 字段)。

- 仓库级测试:根目录执行 `node --test tests/engine.test.mjs`(rs-workflow engine.js 编排脚本验收)
- 包内测试:dsh-usage-panel 与 dsh-maintain 目录执行 `npm test`(即 `node --test "test/*.test.mjs"`);@mzzsfy/dsh-rs-workflow 无 npm test,只有下面的冒烟脚本
- @mzzsfy/dsh-rs-workflow 冒烟:`node .\scripts\test-workflow-plugin.mjs`(默认测已安装副本,传入包目录路径可测任意构建;仓库内副本解析不了 peer 依赖,需先安装再测)

dsh-usage-panel 的无 IO 纯逻辑层(`src/parsers.mjs`)由其 npm test 覆盖。包元数据:dsh-usage-panel peerDependencies 为 `react ^18.2.0`;@mzzsfy/dsh-rs-workflow 为 `@deepseek-ai/dsh-settings`(^0.1.1-rc.2)、`@deepseek-ai/dsh-tools`(^0.1.1-rc.2)与 `@deepseek-ai/schemastery`(^3.18.1);@mzzsfy/dsh-maintain 为 `@deepseek-ai/dsh-settings`(>=0.1.1-rc.2)、`@deepseek-ai/schemastery`(>=3.18.0)与 `react`(^18.2.0)。peer 均由 pnpm 标准安装的虚拟层链入解析。

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
