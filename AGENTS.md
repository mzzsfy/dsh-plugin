# dsh-plugin 开发规约

本文件约束所有在本仓库工作的 AI 会话与人类。核心目标:profile 与仓库只有一种合法状态,任何会话不得发明自己的做法。

规约正文按主题拆分于 `DEVELOPMENT/`,以下文件与本文件同等强制效力。dsh 只自动注入本文件,不注入链接目标——**任务涉及对应主题时,动手前必须先读该文件全文,禁止凭记忆或摘要行事**;不确定涉及哪些主题时,先全部读一遍再动手。

| 主题 | 文件 |
|------|------|
| 包结构与版本、发布流程(publish 唯一入口 / 版本 tag) | [DEVELOPMENT/structure-and-release.md](DEVELOPMENT/structure-and-release.md) |
| profile 链接(dev-link 唯一入口 / junction / fallback 补链) | [DEVELOPMENT/profile-link.md](DEVELOPMENT/profile-link.md) |
| 日常开发循环(热重载边界 / 测试命令 / 提交纪律)、双实现同源 | [DEVELOPMENT/dev-loop.md](DEVELOPMENT/dev-loop.md) |
| 插件 client 规约(UI 开关控件 / 导航图标声明 / 样式注入 data-plugin 契约) | [DEVELOPMENT/plugin-client-conventions.md](DEVELOPMENT/plugin-client-conventions.md) |
| 公共 client 依赖包(依赖形态发布 / 代挂装载链 / 占位条目) | [DEVELOPMENT/client-dependency.md](DEVELOPMENT/client-dependency.md) |
| DSH 本体 API 对齐(服务优先 / 干净禁用 / 升级回归) | [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) |

安全边界约定(全仓库强制):**所有包不做 host 认证,不设 Host/Origin 可达性闸门**。宿主的 Host 信任闸门由 dsh-auto-trust-all 统一放行(项目威胁模型:本地/内网可达即可信,认证由宿主原生 cookie/startup-auth 承担,本仓库不重复、不加强、不旁路)。任何包新增 HTTP 路由时禁止实现 Host 白名单、DNS-rebinding 防线、token 校验等自有认证层;写路由的跨源防护以 Origin 与 Host 的同源比对为上限(dsh-rs-workflow board 同构)。背景与原理见 [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) 安全边界节。
