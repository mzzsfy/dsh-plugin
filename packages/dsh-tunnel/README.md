# dsh-tunnel

穿透隧道插件: 在 dsh 宿主进程内把本地 TCP 端口反向代理出来, 并向 ai 注册 `tunnel_open` / `tunnel_list` / `tunnel_close` 三个工具, 赋予 ai 主动开关隧道的能力。代理逻辑全在插件进程内, 不引入 nginx/caddy 等外部反代。

## 双入口形态

### path(默认)——子路径模式

`http://<host>:<port>/p/<name>/` → 本机 targetPort:

- HTTP 前缀 strip 纯字节转发, 保留原 Host, 附 `x-forwarded-host/for/proto`; 3xx 同源根绝对路径的 `Location` 单头补前缀
- WebSocket: 创建时声明 `wsPaths`(相对隧道根), 每值注册带/不带尾斜杠两形态 exact upgrade 路由; 缺省 = 纯 HTTP
- 应用需支持子路径部署(vite `--base` / jupyter `base_url` / gradio `root_path` / streamlit `baseUrlPath`), 由 ai 以正确 base 参数启动

### subdomain——子域名模式

`http://<name>.<任意泛解析到本机的域名>:<port>/` → 本机 targetPort(本机浏览器直接 `<name>.localhost:<port>`):

- 全路径全协议透传: 无 strip、不改写 Location、WebSocket 任意路径可用(动态内核通道如 jupyter 无需枚举)
- 应用按根路径正常启动, 无需 base 参数
- 实现: wrap+shadow 分流(与 dsh-auto-trust-all 同构), 隧道 Host 命中即转发, 隧道域名上与宿主路由完全隔离; Host 信任依赖 dsh-auto-trust-all
- 限制: 隧道名避开入口域名首标签(如 GUI 经 `dsh.example.com` 访问则别用隧道名 `dsh`)

## 使用

- ai 通道: 会话内直接让 ai 开隧道 `tunnel_open`(name, targetPort, entry?, wsPaths?) / `tunnel_list` / `tunnel_close`
- GUI 通道: 侧边栏「穿透隧道」面板手动添加/删除/复制访问地址(与 ai 同表); 设置 > 插件页「穿透隧道」卡片可把看板移入 better-sidebar 侧边栏
- 设置 > 隧道配置节: `connectTimeoutMs`(响应头等待超时, 改动即时生效, 无需重启)、`sidebarTab`(侧边栏注入开关)
- 持久化 `~/.dsh/dsh-tunnel/tunnels.json`(随 `DSH_HOME`), 重启自动恢复; 目标拒连 502, 响应头等待超时(默认 10s, 头到即解除, SSE 不受影响)504
- REST: `/api/tunnel/tunnels`(GET/POST/DELETE `/api/tunnel/tunnels/:name`) + `/api/tunnel/status` + `/api/tunnel/ui-settings`, 与 GUI/ai 同一入口

## 验证

- `node --test "test/*.test.mjs"`: 36 场景 + 8 api 用例 + 11 守卫断言(mock webServer + 真实 http/net 端到端)
- `node scripts/compat/tunnel-fullchain.mjs`: 隔离 dsh 实例全链路(真实激活/恢复/分发面七项探针)

## 设计文档

`docs/调研-路径穿透插件.md`(「方案设计」两节为本包实施规格, 含已知限制); `docs/设计-隧道GUI.md`(GUI/设置/侧边栏注入实施规格)。
