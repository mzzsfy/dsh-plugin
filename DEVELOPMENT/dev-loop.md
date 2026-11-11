# 日常开发循环与双实现同源

性能改动先跑 `node scripts/perf/bench.mjs` 记录或比对基线,约定见 [perf-baseline.md](perf-baseline.md)。

## 新 clone 初始化(按序执行,顺序有依赖)

1. 仓库根解析桥(不可省):工作副本运行时(经 junction realpath)与包测试的 dependencies 解析都落在根 `node_modules`;新 clone 在仓库根执行 `npm install --legacy-peer-deps`(以根 `package.json` 为准——宿主 peer 同源包、playwright 与各包外部依赖并集;`@deepseek-ai/dsh-storage-json` 0.2.2 的 peer 声明与根桥其它 dsh 包代际不一致,不加该标志会 ERESOLVE,测试只用到它的 JsonStorageBackend)。CI 的 `.github/workflows/test.yml`「安装宿主 peer」步用显式钉版 spec 装,但 `npm install --no-save` 仍会按根 manifest 重建整棵树,两份清单同时生效,根 manifest 是事实源。本机已装 dsh 本体时,`@deepseek-ai/*` 宿主 API 也可经目录逐级兜底解析到本体安装目录(DEVELOPMENT/dsh-api-alignment.md)
2. `node scripts/dev-link.mjs all`:把各包 dependencies 外部依赖补进**仓库根解析桥**(根 `node_modules`,devDeps 不装;包内不再安装——包内 node_modules 处于 profile pnpm 与宿主插件安装的重建路径上,不作依赖来源)并挂工作副本;直接跑包测试报 ERR_MODULE_NOT_FOUND 时,先核对根 `node_modules/<依赖名>/package.json`:dependencies 缺失 → 重跑本步;dependencies 在位仍报错 → devDeps(构建/测试态)缺失,`node scripts/install-externals.mjs` 补全(枚举 packages 全部子目录整体重装,不支持单包;显式 CLI spec 安装:非 @mzzsfy 按 name@range 走 registry,@mzzsfy 映射 file: 同层包)——补装会把 devDeps 连同 @deepseek-ai 钉版落回包内,该包 host 运行态解析链随之被钉版截胡(本步有意不装 devDeps 即为防此),测试完成后删除该包内 node_modules;再核对第 1 步根 node_modules(宿主 peer 桥),并按该包 manifest 的 scripts.test 原样命令执行(部分包需 mock 预载参数,勿裸跑 `node --test`)
3. 之后进入下述日常循环

## 日常开发循环

1. 改代码在仓库 `packages/<包>/` 内进行,直接改工作副本
2. 测试:包目录内 `npm test`(需要 `--experimental-test-module-mocks` 的包用裸 `node --test` 会假红且计数偏低,如 cron-board/tunnel/turn-notify/usage-panel;其余包等价于 `node --test "test/*.test.mjs"`,含 dsh-rs-workflow 的引擎/流程/编排测试);仓库级:`node --test "tests/*.test.mjs"`(在仓库根,dev-link 与 echo-upstream 对账、CI 全量聚合脚本测试;已被 CI test job 的 repo-tests 单元覆盖);测试文件按平台归属命名——`*.test.mjs` 通用、`*.win.test.mjs` 仅 Windows、`*.linux.test.mjs` 仅 linux(CI 只跑 linux 侧,由 CI 聚合脚本发现层过滤;手动 `node --test` glob 绕过过滤,专属文件注意自行甄别);rs-workflow 插件冒烟走隔离环境 boot(同款方法见 scripts/compat/ 与 docs/兼容性测试/测试与隔离方法.md,本地维护不入库);兼容性单版本端到端(在仓库根执行):`node scripts/compat/run.mjs --version <dsh版本> --host-dir .dsh-versions/<dsh版本>`——隔离 profile 全家桶 boot + 统一底线断言,CI compat job 同款;前置:仓库根需可解析 playwright(`npm install --no-save --no-package-lock --no-audit --no-fund playwright@1.63.0`,与 CI 同款;chromium 走内置/chrome/msedge 通道回退,通常无需 playwright install),方法见 docs/兼容性测试/测试与隔离方法.md(本地维护不入库)
3. 验证效果:确保 dev-link 已挂。**host 半区改动自动热重载**(dev-link 在 home 补丁层 `~/.dsh/cordis.patch.yml` 维护 hmr 覆盖行,watch 仓库 packages,保存后约 1 秒重载对应插件;测试/文档/依赖目录不触发);**client 半区改动刷新页面即生效**(client bundle 从磁盘按请求现读)。同代代码改动不要求重启 dsh。公共依赖 common-tools 只能在同一 minor 内发 patch:改帧集合或导出形状即 0.5.0 级破坏,须与十个消费方的依赖范围同批发布(规约见 [client-dependency.md](client-dependency.md))
4. 提交:语义化中文提交信息,一事一提交,禁止把无关改动混入

## 双实现同源

client.js 与 core 之间存在镜像逻辑的(如 turn-notify 的 chooseChannels、nav-icons 的 ICONS),必须保持 parity 测试覆盖,改一侧必须同步另一侧并在提交信息注明。

## 网络请求量核查(测试阶段强制)

涉及 client 数据刷新、轮询、长轮询、事件订阅的改动,测试阶段必须在 DevTools Network 面板核查 dsh 请求量,历史上 多个插件 曾因 setInterval 短轮询与变更风暴导致服务卡顿:

- 空闲期(无数据变更):允许共享 WS 常驻与协议心跳,不得出现周期性 HTTP 快照或持续重连
- 活跃期:请求频率须有上界(限频/合并节流/退避生效);瀑布图中同路径请求间隔持续小于 1s 即为请求风暴,禁止合入
- 服务端新增高频写入路径时,必须评估变更广播对客户端拉取的放大倍数,广播侧合并节流、拉取侧限频,二者缺一不可
- 快照刷新以 usage-panel/turn-notify 为同构基准:WS 只通知失效,首连/重连 onReset 全量对账;宿主合并失效通知,客户端单飞限频与末尾补拉,失败不自行形成重试循环。最后实例退出须取消待发刷新并中止在途请求或忽略迟到响应
