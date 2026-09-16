# 日常开发循环与双实现同源

## 日常开发循环

1. 改代码在仓库 `packages/<包>/` 内进行,直接改工作副本
2. 测试:`node --test "test/*.test.mjs"`(在包目录内);仓库级:rs-workflow 引擎测试 `node --test tests/engine.test.mjs`、流程解释器 BDD `node --test tests/flow.test.mjs` 与 parity `node --test tests/workflow-parity.test.mjs`(均在仓库根);rs-workflow 插件冒烟在仓库根 `node scripts/test-workflow-plugin.mjs`(默认测 profile 安装副本,传包目录可测任意构建)
3. 验证效果:确保 dev-link 已挂。**host 半区改动自动热重载**(dev-link 在 home 补丁层 `~/.dsh/cordis.patch.yml` 维护 hmr 覆盖行,watch 仓库 packages,保存后约 1 秒重载对应插件;测试/文档/依赖目录不触发);**client 半区改动刷新页面即生效**(client bundle 从磁盘按请求现读)。改完代码不要求重启 dsh,也不要建议用户重启
4. 提交:语义化中文提交信息,一事一提交,禁止把无关改动混入

## 双实现同源

client.js 与 core 之间存在镜像逻辑的(如 turn-notify 的 chooseChannels、nav-icons 的 ICONS),必须保持 parity 测试覆盖,改一侧必须同步另一侧并在提交信息注明。
