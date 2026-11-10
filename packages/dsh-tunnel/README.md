# dsh-tunnel

穿透隧道插件: 在 dsh 宿主进程内把本地 TCP 端口反向代理出来, 并向 ai 注册 `tunnel_open` / `tunnel_list` / `tunnel_close` 三个工具, 赋予 ai 主动开关隧道的能力。代理逻辑全在插件进程内, 不引入 nginx/caddy 等外部反代。

## 双入口形态

### path(默认)——子路径模式

`http://<host>:<port>/p/<name>/` → 本机 targetPort:

- HTTP 前缀 strip 纯字节转发, 保留原 Host, 附 `x-forwarded-host/for/proto`(`proto` 取宿主监听协议); 3xx 同源根绝对路径的 `Location` 单头补前缀
- WebSocket 任意路径可用: `/p/<name>/<任意路径>` strip 后透传, 无需声明(动态内核通道如 jupyter 开箱即用)
- 应用需支持子路径部署(vite `--base` / jupyter `base_url` / gradio `root_path` / streamlit `baseUrlPath`), 由 ai 以正确 base 参数启动
- 与 dsh 同源: 目标应用共享 dsh 的 cookie 与安全上下文, cookie/安全敏感的应用优先用子域名

### subdomain——子域名模式

`http://<name>.<任意泛解析到本机的域名>:<port>/` → 本机 targetPort(本机浏览器直接 `<name>.localhost:<port>`):

- 全路径全协议透传: 无 strip、不改写 Location、WebSocket 任意路径可用
- 应用按根路径正常启动, 无需 base 参数
- 实现: 摘取 `webServer.server` 的 request/upgrade 监听各插一层, 隧道 Host 首标签命中即转发, 未命中原样委托原监听; 隧道域名上与宿主路由完全隔离(含 `/api/*` 与宿主 upgrade 路由), 且不改写任何其它插件的路由表
- 限制: 隧道名须至少含一个字母(纯数字会与纯 IP 访问的首段冲突), 并避开入口域名首标签(如 GUI 经 `dsh.example.com` 访问则别用隧道名 `dsh`); HTTPS 访问需入口域名的泛域名证书(`*.example.com`)

## 使用

- ai 通道: 会话内直接让 ai 开隧道 `tunnel_open`(name, targetPort, entry?) / `tunnel_list` / `tunnel_close`; 「允许 ai 使用」开关(默认开)关闭即向 ai 注销三件工具, 看板与 REST 管理不受影响
- GUI 通道: 侧边栏「穿透隧道」面板手动添加/删除/复制访问地址(与 ai 同表); 设置卡两枚开关——「允许 ai 使用隧道工具」与「看板移入 better-sidebar 侧边栏」(设置 > 插件页 / 0.1.7+ 插件管理页包详情);数据与偏好变更经公共 WS 总线 `@mzzsfy/dsh-tunnel` 插件通道推送;host/client 在 `apply(ctx)` 调用 `setupCommonTools(ctx)`,以 `ctx.fiber.entry.options.name` 的完整 npm 包名绑定通道,组件捕获所属 ctx 的 bus，卸载可提前退订；ctx 卸载释放连接持有与全部订阅
- 设置面: legacy(≤0.1.6) 设置 > 插件页独立配置节; 0.1.7+ Config volatile 字段自动配置节(connectTimeoutMs / aiTools / sidebarTab 均支持原地热更, dataDir 为环境路径不进 UI)。`connectTimeoutMs`(响应头等待超时, 改动即时生效, 无需重启)
- 持久化 `~/.dsh/dsh-tunnel/tunnels.json`(随 `DSH_HOME`), 重启自动恢复; 恢复失败的行保留在磁盘并在列表标 `active:false`, 下次激活重试; 目标拒连 502, 响应头等待超时(默认 10s, 头到即解除, SSE 不受影响)504
- 访问地址: 路径模式为同源 `/p/<name>/`; 子域名模式按当前域名派生 `<name>.<域名>`, 经 IP/localhost 访问时退回 `<name>.localhost`(仅本机可解析, 面板会标注)
- REST: `/api/tunnel/tunnels`(GET/POST/DELETE `/api/tunnel/tunnels/:name`) + `/api/tunnel/status` + `/api/tunnel/ui-settings`(POST: aiTools / sidebarTab), 与 GUI/ai 同一入口; 写路由强制 JSON 且校验 Origin 与 Host 同源(浏览器 CSRF 防线)

## client 依赖

看板通过 `@mzzsfy/dsh-common-tools/client` 订阅数据变更，该依赖的装载行 `tunnel-dsh-common-tools` 随本包 `cordis.patch.yml` 自带（依赖 `^0.4.0`），宿主按包名把多个消费插件的装载行合并成一份 client 模块，装本包即可独立运行。公共模块缺失时装载层会报告具体依赖错误；宿主 React 模块缺失时控制台报告原因并禁用面板。剪贴板在非安全上下文(内网 http)自动降级到选区复制。

## 验证

- `npm test`(经 _mocks.common-tools.mjs 预载公共依赖桩;宿主面用 `test/support/fake-host.mjs` 按 0.2.x 分发语义起真实 http.Server 替身): 92 用例全绿, 覆盖双入口行为、故障边界、REST/CSRF、ai 开关注销、开关守卫、client 逻辑与常量同源、看板形态仲裁与刷新可见性门控
- `node scripts/compat/tunnel-fullchain.mjs`: 隔离 dsh 实例全链路(真实激活/恢复/分发面探针, 含动态 WS 路径)

## 设计文档

`docs/设计-隧道改造.md`(分发模型、缺陷修复清单与 BDD 规格); 仓库本地维护文档,不入库,npm 安装读者不可见。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。
