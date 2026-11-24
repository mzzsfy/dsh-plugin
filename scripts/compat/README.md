# scripts/compat

单版本端到端兼容性验证与隔离工位管理。方法论见 `docs/兼容性测试/测试与隔离方法.md`,
检查维度与门槛见 `docs/兼容性测试/兼容性检查总纲.md`。

## 入口

| 脚本 | 作用 |
|------|------|
| `run.mjs` | 安装宿主 → 隔离 profile → boot → activation/diagnostics → 浏览器渲染 → 路由闸门 → LLM 链路 → 判定 `result.json` |
| `boot-keep.mjs` | 常驻隔离工位(daemon/前台),写 `live.json`,供多步调试与 L3 探针接管 |
| `keep-stop.mjs` | 收尾 `live.json` 记录的宿主/模拟器,幂等 |
| `prune.mjs` | 回收工位磁盘(默认只删可重建的宿主闭包) |
| `ci.mjs` / `window.mjs` | 版本窗口解析与逐槽 CI 执行 |
| `gate-probe.mjs` | 插件路由闸门:无 cookie 401/403、带 cookie 放行 |
| `activation-probe.mjs` | `/dsh-market/installed` 激活态与 diagnostics 探针 |
| `browser-probe.mjs` / `l3-probe.mjs` | 真实 chromium 渲染与 UI 步骤探针 |
| `tunnel-fullchain.mjs` | tunnel 全链路九探针 |
| `echo-upstream/` | 本地 LLM 模拟器(零真实 API 配额) |

## 探针认证口径

- boot 日志里的 `token=` 只用于打开页面与铸会话 cookie(`GET /?token=…` → 303 + `set-cookie`)。
- 0.2.3-alpha.2 起宿主 `dsh-host-webserver` 对全部命名路由执行 `webserver/authorize`
  (缺省 `required`),`/dsh-market/installed`、`/api/*` 等必须携带宿主会话 cookie;
  非 `/` 路径的 `?token=` 查询一律 401。
- `run.mjs` 用 `mintSessionCookie` 铸一次 cookie,activation 与 gate 探针共用同一来源;
  cookie 未取得或被 401/403 拒绝时回退 token 查询(仅兼容旧宿主),实际认证方式与
  失败取证(`auth`、`status`、`bodySample`)写入 `result.json` 的 activation 字段。
- `installed.json` 始终落本次探测的原始响应(失败时可为认证页正文),不因认证方式改变。

## 端口与隔离

- 端口限制在 9291-9310;CI 用 9291/9292,人工/AI 会话在 9296-9310 随机取空闲并带
  `--refuse-port-owner`,禁止清理他人实例。
- 每次 boot 必须同时带 `DSH_HOME` 与各包数据目录(见 `env.mjs`),否则落到生产 `~/.dsh`。
- 收尾:先 `node scripts/compat/keep-stop.mjs`,再 `node scripts/compat/prune.mjs`。
