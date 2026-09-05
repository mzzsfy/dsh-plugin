# @mzzsfy/dsh-auto-trust-all

DeepSeek Harness web 入口插件:动态信任所有实际到达的 Host,并将 web 默认绑定翻转为全部网卡——`dsh web` 零参数启动等效 `dsh web --host 0.0.0.0 --trusted-host=<任何实际到达的 host>`。

设计文档见 [docs/design/dsh-auto-trust-all.md](../../docs/design/dsh-auto-trust-all.md)。

## 功能

- **动态信任**:包装 webServer 全部路由(exact / prefix / upgrade / fallback,含激活前已注册与后续新注册),请求到达即提取 Host 头(与官方信任闸门同构的 WHATWG 解析:小写、去端口、IPv6 保留方括号),去重后**双写** `webRuntime.trustedHosts` 与 `connection` 服务实例的 `trustedHosts` 快照数组(官方闸门读后者;两数组是装配期克隆的不同对象,缺一则动态域名对 `/api` 闸门不可见),闸门每请求实时读数组,无需重启。泛域名(`*.example.com`)等无法枚举的入口不再需要改启动命令。
- **FIFO 容量**:注册域名容量 `maxHosts` 默认 100,超出按注册先后淘汰最早者;官方初始条目(部署派生的局域网 IP 等)不参与淘汰。内存总量恒定有界。容量按激活代记账:插件重载前注册的条目留存于信任清单但不参与新一代记账,重启即归零。
- **console 输出**:启动时输出一行状态横幅(绑定、容量、既有信任条目);此后每次注册输出 `auto-trust-all: registered host <域名>`、每次淘汰输出 `auto-trust-all: evicted host <域名>`,直接 grep dsh console 即可做入口审计。
- **默认绑定翻转**:bundle patch 覆盖官方 webserver 行的 host 默认值为 `0.0.0.0`;显式 `--host 127.0.0.1` 仍生效(表达式读 webStartup 服务,只翻默认值)。
- **认证层不动**:只影响官方 Host/Origin 信任闸门(官方文档明言"绝不建立身份"的可达性闸门);原生浏览器 cookie 认证与 dsh-web-startup-auth 会话闸门原样保留,安全增量趋近于零。
- **干净降级**:冷启动时 `webRuntime` 尚未就绪属预期,插件挂服务激活事件自动延迟启用;官方 web 面形态变化导致其真缺失时保持静默待命,不产生启动 pending、不影响 dsh 启动与其余功能。

## 配置(无 GUI)

唯一配置项 `maxHosts`(注册域名容量,自然数,默认 100)。走 cordis 行级配置,在 profile 的 `cordis.patch.yml`(或 `~/.dsh/cordis.patch.yml`)追加覆盖行,重启 dsh web 生效:

```yaml
- id: auto-trust-all
  config:
    maxHosts: 200
```

容量按激活代记账:修改 `maxHosts` 需重启 dsh web 生效,新容量只约束其后注册的条目,插件热重载换代的遗留条目视同官方条目留存;重启 dsh web 则动态条目全部归零。

## 安装

任何 `dsh plugin add`(开发或发布安装)都会把 node_modules 里的既有 junction 重建为实体目录,装完必须重跑 `node scripts/dev-link.mjs all` 恢复工作副本挂载,否则改仓库源码不生效。

发布版安装:

```sh
dsh plugin --profile web add @mzzsfy/dsh-auto-trust-all
```

发布前开发安装(在仓库根目录执行——`file:` 相对路径按执行时所在目录锚定):

```sh
dsh plugin --profile web add file:./packages/dsh-auto-trust-all
```

bundle patch 随下次 dsh 重启生效。开发安装的依赖行是 `file:` 过渡态,发布后由 `dev-link.mjs all` 归一为 semver。

patch 覆盖官方 webserver 行的 config 是整体替换语义,本包已完整镜像官方全部键;该镜像由 `test/patch.test.mjs` 快照锁定——但该测试读不到官方安装目录,**不能**自动检出上游增删键。dsh 升级后请用 `dsh web --dump-default-config` 对照官方 webserver 行核对键集,发现新键需同步 `cordis.patch.yml`。

## 与其他插件的关系

- **dsh-web-startup-auth**:完全共存。本插件不提供任何 cordis 服务,零服务冲突;两者都会遮蔽 webServer 注册方法包装路由,委托链在任意激活顺序下保持正确(会话检查与 Host 注册同时生效)。未认证请求至多完成 Host 登记(纯观察),首个拦截点始终是会话闸门。配合语义:startup-auth 的账号会话(`dsh_sid`,30 天)+ 官方 cookie 铸币跳(会话通过但缺官方 cookie 的 GET 由它代签并 303 回跳)替代了 `?token=` 的 per-process 分发——重启 dsh 后浏览器免输 token;本插件则让泛域名新入口免改启动命令即可达。
- **dream-skin 等同构自守卫插件**:同样实时读 `webRuntime.trustedHosts`,本插件的注册对它们同步生效。

## 安全边界

放行的是可达性闸门:攻击者可让任意域名指向本服务并到达登录页(受 startup-auth IP 限速约束),拿不到任何数据。闸门内建的 `sec-fetch-site: cross-site` 拒绝与 Origin 同源检查独立于信任清单,不受本插件影响。泛解析范围控制与防火墙仍是运维责任。

原生 cookie 会话按 `主机:端口` 绑定,每个新入口(各子域、各内网 IP 形态)都需要各自登录一次——这是 dsh 原生行为,与本插件无关。

## 开发

```sh
cd packages/dsh-auto-trust-all
node --test "test/*.test.mjs"
```

宿主半区改动经 dev-link junction 热重载;冒烟验证步骤见设计文档。
