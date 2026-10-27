# @mzzsfy/dsh-auto-trust-all

DeepSeek Harness web 入口插件:动态信任所有实际到达的 Host——`dsh web` 启动后,任何实际到达的入口(泛域名、内网 IP、反代域名)等效已被 `--trusted-host=<实际到达的 host>` 静态放行。不干预监听绑定:web 监听地址由部署层决定(`--host` 旗标或宿主缺省 `127.0.0.1`)。

## 功能

- **动态信任**:包装 webServer 全部路由(exact / prefix / upgrade / fallback,含激活前已注册与后续新注册),请求到达即提取 Host 头(与官方信任闸门同构的 WHATWG 解析:小写、去端口、IPv6 保留方括号),去重后写入 `connection` 服务实例的 `trustedHosts` 数组——两代宿主(0.2.0 线 / 0.2.1 线)的 `/api` 信任闸门都实时读它,无需重启;`webRuntime.trustedHosts` 在场时同步镜像(0.2.0 线同构自守卫插件读它,0.2.1 线宿主已移除该服务,缺席即静默降级)。泛域名(`*.example.com`)等无法枚举的入口不再需要改启动命令。
- **LRU 容量**:注册域名容量 `maxHosts` 默认 100(上界 4096),超出按最久未访问淘汰,活跃入口不易被挤出;淘汰同步作用于两类数组,内存总量恒定有界。官方初始条目(部署派生的局域网 IP 等)与 loopback(`localhost` / `[::1]` / `127.x`——官方闸门对其恒放行,登记零增益;`*.localhost` 官方不放行,照常登记)不参与记账。淘汰只撤本插件实际推入的条目,他方写入的同名条目不越权删除;数组换代(宿主重建信任数组)时动态条目按 LRU 记账回填新数组。
- **console 输出**:启动时输出一行状态横幅(绑定、容量、既有信任条目、镜像形态);此后每次注册输出 `auto-trust-all: registered host <域名>`、每次淘汰输出 `auto-trust-all: evicted host <域名>`,直接 grep dsh console 即可做入口审计。
- **绑定不干预**:bundle patch 只插入本插件行,不覆盖官方 webserver 行(0.2.1 线宿主拒通配绑定且 bind 策略属宿主所有)。需要非回环监听时由部署层显式配置,两代配方不同:0.2.1 线 `--host <具体内网 IP>`(CLI 直收);0.2.0 线 CLI 拒绝 `--host 0.0.0.0`、schema 只收 `127.0.0.1`/`0.0.0.0`,唯一途径是 profile patch 覆盖 webserver 行 `host: '0.0.0.0'`(即旧版本本插件 patch 的做法)。缺省 `dsh web` 监听 `127.0.0.1`,同机 nginx 反代到回环即可。
- **认证层不动**:只影响官方 Host/Origin 信任闸门(官方文档明言"绝不建立身份"的可达性闸门);原生浏览器 cookie 认证与 dsh-web-startup-auth 会话闸门原样保留,安全增量趋近于零。
- **干净降级**:冷启动时 `connection` 尚未就绪属预期,插件挂服务激活事件自动延迟启用;等待提示延后——超过 15 秒仍未就绪才输出 `connection 未就绪` 等待行,正常启动不产生该行;`connection.trustedHosts` 冻结等形态异常时告警后停用;官方 web 面形态变化(路由表缺 Map 形态或注册方法缺失)时告警后停用——均不产生启动 pending、不影响 dsh 启动与其余功能;`webRuntime` 缺席(0.2.1 线)只影响镜像,不影响注册主路径。
- **卸载即撤销**:卸载时置空共享载体(带身份校验:新代已接管则跳过撤销与置空,防旧代误删新一代记账中的条目)并从两类数组移除本代注册的全部条目,信任放行随插件移除停止。

## 配置(无 GUI)

唯一配置项 `maxHosts`(注册域名容量,自然数,默认 100)。走 cordis 行级配置,在 profile 的 `cordis.patch.yml`(或 `~/.dsh/cordis.patch.yml`)追加覆盖行,行级配置变更经热重载换代即按新容量生效,无需重启:

```yaml
- id: auto-trust-all
  config:
    maxHosts: 200
```

容量按激活代记账:换代(热重载/行级配置变更)时若新一代先接管,旧代卸载跳过撤销,遗留条目视同官方条目留存、由新一代按需重新记账,重启 dsh web 则动态条目全部归零;新一代尚未接管即卸载(真卸载)时,本代注册条目从两类数组移除。

## 安装

任何 `dsh plugin add`(开发或发布安装)都会把 node_modules 里的既有 junction 重建为实体目录,装完必须重跑 `node scripts/dev-link.mjs all` 恢复工作副本挂载,否则改仓库源码不生效。

发布版安装:

```sh
dsh plugin --profile web add @mzzsfy/dsh-auto-trust-all
```

开发安装(仓库工作副本直挂,不经 npm 发布):

```sh
node scripts/dev-link.mjs dsh-auto-trust-all   # 仓库根执行:归一 profile 依赖行 + 挂 junction
```

bundle patch 经 dev-link 维护的 hmr 覆盖行保存约 1 秒热重载;规约与全仓归一见 `node scripts/dev-link.mjs all`。

## 与其他插件的关系

- **dsh-web-startup-auth**:完全共存。本插件不提供任何 cordis 服务,零服务冲突;两者都会遮蔽 webServer 注册方法包装路由,委托链在任意激活顺序下保持正确(会话检查与 Host 注册同时生效)。未认证请求至多完成 Host 登记(纯观察),首个拦截点始终是会话闸门。配合语义:startup-auth 的账号会话(`dsh_sid`,30 天)+ 官方 cookie 铸币跳(会话通过但缺官方 cookie 的 GET 由它代签并 303 回跳)替代了 `?token=` 的 per-process 分发——重启 dsh 后浏览器免输 token;本插件则让泛域名新入口免改启动命令即可达。
- **dream-skin 等同构自守卫插件**:同样实时读 `webRuntime.trustedHosts`(仅 0.2.0 线宿主提供该服务),本插件的注册对它们同步生效;0.2.1 线宿主已移除 `webRuntime`,该类插件需各自适配。

## 安全边界

放行的是可达性闸门:攻击者可让任意域名指向本服务并到达登录页(受 startup-auth IP 限速约束),拿不到任何数据。闸门内建的 `sec-fetch-site: cross-site` 拒绝与 Origin 同源检查独立于信任清单,不受本插件影响。泛解析范围控制与防火墙仍是运维责任。

原生 cookie 会话按 `主机:端口` 绑定,每个新入口(各子域、各内网 IP 形态)都需要各自登录一次——这是 dsh 原生行为,与本插件无关。

被 LRU 淘汰的域名在再次访问时自动重新登记:已包装路由的请求先于宿主闸门执行注册,淘汰条目重访即恢复(无需重启);LRU(最久未访问先淘汰)语义使活跃入口被低频新入口挤出的概率远低于按注册先后淘汰。

**全仓库约定(见 AGENTS.md 与 DEVELOPMENT/dsh-api-alignment.md「安全边界」节)**:本插件放行可达性闸门是项目级决策,所有插件包一律不做 host 认证——不实现 Host 白名单、DNS-rebinding 防线、自有 token/cookie 校验。任何单包再设可达性闸门都与本插件冲突(宿主放行、单包再拦,行为不一致)。插件写路由的跨源防护以 Origin 与 Host 同源比对为上限;审查报告把"缺 Host 校验"列为缺陷的条目一律无效。

## 已知行为与边界

- 卸载后,遮蔽的注册方法与路由包装标记滞留:其后新注册的路由仍会过一层透传包装(每请求一次 no-op 载体调用,代价微小),属防卸载期路由半包装的既定取舍,进程存续期不可逆。
- 激活后对 `webServer.fallback` 实例字段的直接赋值不经包装,该 handler 的请求不注册 Host(本插件只拦注册方法与激活时点已存在的路由)。
- 未认证请求至多完成 Host 登记(纯观察),首个拦截点始终是会话闸门;多样化 Host 流量下 registered / evicted 日志逐条输出,可作入口审计也可能成为日志噪声来源。
- 第三方直接收缩信任数组(原引用被 splice 清空)时,已记账条目的重访不回填(命中记账即短路);恢复途径 = LRU 淘汰后重访(走全新注册路径)、宿主重建信任数组(换代探测回填)或重启。被 LRU 淘汰的条目重访即自愈,换代遗留条目留存至 dsh web 重启。

## dsh 版本兼容

同一版本覆盖 0.2.0 线与 0.2.1 线宿主(共同契约:`connection.trustedHosts` 实时数组 + webServer 路由包装,均为两代源码核实的形态;`webRuntime` 镜像仅 0.2.0 线可用),两线均经隔离实测(横幅/注册/401/403/淘汰自愈/激活 live)。manifest `dsh.hostMin = 0.2.0-rc.2` 为本包验证过的最低宿主代际(dev-link / compat 装载层按其过滤);两线实测状态与登记见 manifest `dsh.compatibility.dshReleases`。**注意**:自本版本起 bundle patch 不再翻转 web 默认绑定——依赖旧版"零参数监听 0.0.0.0"的部署需按上文「绑定不干预」在部署层显式配置监听。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。

## 开发

```sh
cd packages/dsh-auto-trust-all
node --test "test/*.test.mjs"
```

宿主半区改动经 dev-link junction 热重载,保存约 1 秒重载;冒烟验证:dsh web 启动后以非常见 Host 头请求任一路由,响应正常且 console 出现 registered 前缀日志。
