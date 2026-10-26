# @mzzsfy/dsh-cron-board

轻量级定时任务看板 dsh 插件:环境变量集中管理 + 定时任务(cron)调度,执行体支持两类——本地脚本(dsh 宿主进程内 spawn)与 dsh 会话任务(定时向 dsh 会话投递任务,投递即终态,支持「每次新建会话」或「固定同一会话」)。

设计文档见仓库 `docs/progress/debug-fix-cron-board-delivery-semantics.md`(近期语义收敛决策记录)。

## 功能

- **看板**:任务卡片列表(状态色/下次触发相对时间/启停开关/立即运行/编辑/删除),新建编辑模态为调度构建器布局:类型/会话模式/调度频率统一分段组件,结构化频率(每天/每周/工作日/固定间隔)自动生成表达式(反解不出即自定义手输),即将执行时刻 chips 为服务端实时预览
- **环境变量**:集中管理,值打码展示,多值(同名展开笛卡尔积,组合数超出 20 截断并告警),dotenv 文本导入(预览/追加/覆盖)与导出
- **会话任务**:投递即终态(crontab 语义,执行状态归会话本身);fresh 每次新建会话;pinned 固定会话(忙时跳过,会话被删除或归档自动重建并回写,首跑自动绑定);按 workdir 自动挂载宿主分组,界面分组内可见;执行预设可选(Agent Preset,缺省跟随宿主默认,dsh-im 同构);模型可选(provider/model/推理强度,缺省跟随宿主默认,仅作用于本任务运行——经宿主会话级模型选择安装,不改全局默认;投递前校验目录可用性,不可用即失败并记录原因,运行记录展示实际模型。宿主边界:模型选择是会话持久状态,任务成功投递后由该轮消费;pinned 会话任务投递被拒的边缘路径下已装选择会保留到该会话下一次请求,宿主无选择卸载面)
- **调度**:croner 解析,停机期间错过不补跑(misfire 即跳过),孤儿运行恢复,全局与任务级并发闸门;shell 任务超时收尾(会话任务无超时语义);单次运行开关(runOnce,任意一次真实运行入队后自动停用任务)
- **时区**:cron 表达式支持内联时区后缀 `T±N`(整数小时,如 `0 9 * * *T+8` 表示东八区 9 点,范围 -12 至 +14,`T+0` 即 UTC);构建器提供时区行写入后缀,新建任务默认固化设备时区偏移;无后缀表达式按宿主进程系统时区调度(crontab 惯例),摘要与运行记录按任务所用时区展示;固定偏移不随夏令时变化,半时区设备的设备偏移就近取整
- **日志**:每任务每运行独立日志文件,面板查看与清空,按任务保留条数裁剪(按文件修改时间)

## 路由

前缀 `/api/cron-board`(envs / jobs / runs / status / cron/preview / agent-presets / model-catalog),REST 风格,中文业务错误透传。

## 界面挂载

挂载走宿主官方契约(main 全局面板插槽 / sidebar.panellist 侧栏面板行 / better-sidebar 服务),不刮宿主 DOM,宿主 UI 变动由契约消化:

- **默认:全局面板**。看板以同 id 注册 main keyed 条目(中央面板)+ sidebar.panellist 条目(侧栏「新会话」下方面板行);点击面板行由宿主 `layout.selectPanel` 切换中央区,会话保持不动;点击会话行或新会话即切回会话(官方路径)
- **手动移入**:设置>插件 页「定时任务」卡片(官方 PluginCard 形制:折叠卡壳,cb-pc 镜像)提供「看板移入 better-sidebar 侧边栏」开关;开启即注册扩展槽 tab 并卸载全局面板
- **不自动回退**:移入后页签关闭/类型禁用均不再自动返回;把开关关掉即回到全局面板形态(经公共 WS 总线 `@mzzsfy/dsh-cron-board` 插件通道感知,变更即时生效;host/client 在 `apply(ctx)` 调用 `setupCommonTools(ctx)`,通道身份取 `ctx.fiber.entry.options.name` 的完整 npm 包名,组件捕获所属 ctx 的 bus，卸载可提前退订；ctx 卸载释放连接持有与全部订阅)
- **开关可用性**:已装载 better-sidebar 时可切换;未装载时开关呈禁用态仅展示(保持全局面板,无副作用)

## 配置

设置页>插件 页「定时任务」卡片(`cron-board` 命名空间),各项均即时生效:`sidebarTab` 经卡片开关写入;其余项经配置文件或设置接口修改。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `tickSeconds` | 调度轮询周期(秒,最小 5),变更后自动按新周期重建定时器 | 30 |
| `maxConcurrent` | 全局同时运行的执行单元上限 | 2 |
| `logKeepPerJob` | 每任务保留的运行日志份数(超出按文件修改时间裁剪) | 200 |
| `maskEnvInPrompt` | 会话任务投递文本中环境变量值打码 | 关 |
| `sidebarTab` | 看板移入 better-sidebar 侧边栏(需已装载;关闭时以侧栏面板行 + 全局面板呈现) | 关 |

## 依赖

- `croner`:cron 表达式解析与触发点计算
- 宿主服务:settings / timer(软依赖)、webServer;sessionController 在 apply 内探测(缺失时打日志干净禁用,插件整体不激活,含脚本任务;0.1.1-rc.2 及更早版本无此服务)

## 开发

```sh
node scripts/dev-link.mjs dsh-cron-board   # 挂载工作副本到 profile
cd packages/dsh-cron-board
node --test "test/*.test.mjs"              # 测试
```

注意:插件新增进入 profile bundles(`dsh plugin add`)后需 dsh 重启一次完成首装载;此后工作副本改动经 dev-link HMR 热重载。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md` 与本包 `兼容性测试.md`。
