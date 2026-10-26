# 日常开发循环与双实现同源

## 日常开发循环

1. 改代码在仓库 `packages/<包>/` 内进行,直接改工作副本
2. 测试:`node --test "test/*.test.mjs"`(在包目录内,含 dsh-rs-workflow 的引擎/流程/编排测试);仓库级:`node --test "tests/*.test.mjs"`(在仓库根,dev-link 与 echo-upstream 对账、CI 全量聚合脚本测试;已被 CI test job 的 repo-tests 单元覆盖);测试文件按平台归属命名——`*.test.mjs` 通用、`*.win.test.mjs` 仅 Windows、`*.linux.test.mjs` 仅 linux(CI 只跑 linux 侧,由 CI 聚合脚本发现层过滤;手动 `node --test` glob 绕过过滤,专属文件注意自行甄别);rs-workflow 插件冒烟在仓库根 `node scripts/test-workflow-plugin.mjs`(默认测 profile 安装副本,传包目录可测任意构建);兼容性单版本端到端(在仓库根执行):`node scripts/compat/run.mjs --version <dsh版本> --host-dir .dsh-versions/<dsh版本>`——隔离 profile 全家桶 boot + 统一底线断言,CI compat job 同款;前置:仓库根需可解析 playwright(`npm install --no-save --no-package-lock --no-audit --no-fund playwright@1.63.0`,与 CI 同款;chromium 走内置/chrome/msedge 通道回退,通常无需 playwright install),方法见 docs/兼容性测试/测试与隔离方法.md「CI 自动化」节
3. 验证效果:确保 dev-link 已挂。**host 半区改动自动热重载**(dev-link 在 home 补丁层 `~/.dsh/cordis.patch.yml` 维护 hmr 覆盖行,watch 仓库 packages,保存后约 1 秒重载对应插件;测试/文档/依赖目录不触发);**client 半区改动刷新页面即生效**(client bundle 从磁盘按请求现读)。同代代码改动不要求重启 dsh。依赖版本或破坏性协议升级按包声明处理;common-tools 0.1→1.0 须统一更新依赖、冷启动宿主并刷新旧页
4. 提交:语义化中文提交信息,一事一提交,禁止把无关改动混入

## 双实现同源

client.js 与 core 之间存在镜像逻辑的(如 turn-notify 的 chooseChannels、nav-icons 的 ICONS),必须保持 parity 测试覆盖,改一侧必须同步另一侧并在提交信息注明。

## 网络请求量核查(测试阶段强制)

涉及 client 数据刷新、轮询、长轮询、事件订阅的改动,测试阶段必须在 DevTools Network 面板核查 dsh 请求量,历史上 多个插件 曾因 setInterval 短轮询与变更风暴导致服务卡顿:

- 空闲期(无数据变更):允许共享 WS 常驻与协议心跳,不得出现周期性 HTTP 快照或持续重连
- 活跃期:请求频率须有上界(限频/合并节流/退避生效);瀑布图中同路径请求间隔持续小于 1s 即为请求风暴,禁止合入
- 服务端新增高频写入路径时,必须评估变更广播对客户端拉取的放大倍数,广播侧合并节流、拉取侧限频,二者缺一不可
- 快照刷新以 usage-panel/turn-notify 为同构基准:WS 只通知失效,首连/重连 onReset 全量对账;宿主合并失效通知,客户端单飞限频与末尾补拉,失败不自行形成重试循环。最后实例退出须取消待发刷新并中止在途请求或忽略迟到响应
