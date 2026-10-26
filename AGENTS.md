# dsh-plugin 开发规约

本文件约束所有在本仓库工作的 AI 会话与人类。核心目标:profile 与仓库只有一种合法状态,任何会话不得发明自己的做法。

规约正文按主题拆分于 `DEVELOPMENT/`,以下文件与本文件同等强制效力。唯一例外:文末「AI 自测规约」一节因 dsh 只注入本文件、不注入链接目标而必须内联,禁止移入 `DEVELOPMENT/`。正因如此,**任务涉及对应主题时,动手前必须先读该文件全文,禁止凭记忆或摘要行事**;不确定涉及哪些主题时,先全部读一遍再动手。

| 主题 | 文件 |
|------|------|
| 包结构与版本、发布流程(publish 唯一入口 / 版本 tag) | [DEVELOPMENT/structure-and-release.md](DEVELOPMENT/structure-and-release.md) |
| profile 链接(dev-link 唯一入口 / junction / fallback 补链) | [DEVELOPMENT/profile-link.md](DEVELOPMENT/profile-link.md) |
| 日常开发循环(热重载边界 / 测试命令 / 提交纪律)、双实现同源 | [DEVELOPMENT/dev-loop.md](DEVELOPMENT/dev-loop.md) |
| 插件 client 规约(UI 开关控件 / 导航图标声明 / 样式注入 data-plugin 契约) | [DEVELOPMENT/plugin-client-conventions.md](DEVELOPMENT/plugin-client-conventions.md) |
| 插件 UI 统一设计规范(色彩槽位 / 尺寸标尺 / 组件视觉形态) | [DEVELOPMENT/plugin-ui-design.md](DEVELOPMENT/plugin-ui-design.md) |
| 公共 client 依赖包(依赖形态发布 / 代挂装载链 / 占位条目) | [DEVELOPMENT/client-dependency.md](DEVELOPMENT/client-dependency.md) |
| DSH 本体 API 对齐(服务优先 / 干净禁用 / 升级回归) | [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) |

安全边界约定(全仓库强制):**所有包不做 host 认证,不设 Host/Origin 可达性闸门**。宿主的 Host 信任闸门由 dsh-auto-trust-all 统一放行(项目威胁模型:本地/内网可达即可信,认证由宿主原生 cookie/startup-auth 承担,本仓库不重复、不加强、不旁路)。任何包新增 HTTP 路由时禁止实现 Host 白名单、DNS-rebinding 防线、token 校验等自有认证层;写路由的跨源防护以 Origin 与 Host 的同源比对为上限(dsh-rs-workflow board 同构)。背景与原理见 [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) 安全边界节。

## AI 自测规约:隔离环境 + echo-upstream

AI 会话自测(凡涉及 LLM 链路:对话轮、思考流、工具调用、usage、错误注入)强制使用隔离环境与仓库公共模拟器,生产面零接触:

- **LLM 上游一律指向 echo-upstream**:`node scripts/echo-upstream/cli.mjs --port 0` 新起独立实例(随机端口,stdout 打印实际端口),provider baseURL 指向该实例;三协议、SSE 流式、thinking、工具调用、错误注入与 HTTP 控制面见 [scripts/echo-upstream/README.md](scripts/echo-upstream/README.md)。禁止消耗真实 API 配额,禁止以"环境不可测"跳过可测断言(分层与夹具规则见 [scripts/echo-upstream/兼容性测试.md](scripts/echo-upstream/兼容性测试.md))。
- **每次自测新起实例,用完即杀**(终止 = 结束本会话拉起的实例进程):独立脚本无热重载,旧进程即旧代码——2026-09-24 cd0224b 之前的实例不支持流式(`stream:true` 恒回单块 JSON),复用长驻实例(默认端口 18123)是"测到旧行为"的唯一已知根因。随机端口按会话隔离,队列与请求历史互不串扰;模拟器实例不留常驻。
- **不改宿主生产面**:不动生产 profile 与 `~/.dsh` 配置、不重启宿主服务,留档不入版本库(默认临时目录;compat 工位按链接方法落 `llm-echo.jsonl`,gitignore 豁免)。需隔离 profile 全家桶级宿主链路验证时,走 `node scripts/compat/run.mjs` 同款隔离方法([docs/兼容性测试/测试与隔离方法.md](docs/兼容性测试/测试与隔离方法.md))。

各 `兼容性测试.md` 与模拟器 README 中固定端口 18123、真实 API、仓库内留档路径的写法属人工历史流程记录,AI 会话一律以本节为准。
