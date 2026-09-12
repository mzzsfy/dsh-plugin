# @mzzsfy/dsh-cron-board

轻量级定时任务看板 dsh 插件:环境变量集中管理 + 定时任务(cron)调度,执行体支持两类——本地脚本(dsh 宿主进程内 spawn)与 dsh 会话任务(定时向 dsh 会话投递任务,投递即终态,支持「每次新建会话」或「固定同一会话」)。

设计文档见仓库 `docs/progress/debug-fix-cron-board-delivery-semantics.md`(近期语义收敛决策记录)。

## 功能

- **看板**:任务卡片列表(状态色/下次触发相对时间/启停开关/立即运行/编辑/删除),新建编辑模态支持 shell 与会话两类任务、cron 预设与服务端实时预览(人话摘要 + 下三次触发)
- **环境变量**:集中管理,值打码展示,多值(同名展开笛卡尔积,组合数超出 20 截断并告警),dotenv 文本导入(预览/追加/覆盖)与导出
- **会话任务**:投递即终态(crontab 语义,执行状态归会话本身);fresh 每次新建会话;pinned 固定会话(忙时跳过,会话被删除或归档自动重建并回写,首跑自动绑定);按 workdir 自动挂载宿主分组,界面分组内可见;执行预设可选(Agent Preset,缺省跟随宿主默认,dsh-im 同构)
- **调度**:croner 解析,停机期间错过不补跑(misfire 即跳过),孤儿运行恢复,全局与任务级并发闸门;shell 任务超时收尾(会话任务无超时语义)
- **日志**:每任务每运行独立日志文件,面板查看与清空,按任务保留条数裁剪(按文件修改时间)

## 路由

前缀 `/api/cron-board`(envs / jobs / runs / status / cron/preview / agent-presets),REST 风格,中文业务错误透传。

## 界面挂载

挂载权交给用户,运行期不自动切换:

- **默认:主界面**。无论是否安装 dsh-better-sidebar,看板始终在主界面(原生侧栏「定时任务」入口 + 中心列看板,激活时隐藏会话区,面板互斥)
- **手动移入**:设置>插件 页「定时任务」卡片(官方 PluginCard 形制:折叠卡壳,cb-pc 镜像)提供「看板移入 better-sidebar 侧边栏」开关;开启即注册扩展槽 tab(显式 openTab 落入工作台)并拆除主界面形态
- **不自动回退**:移入后页签关闭/类型禁用均不再自动返回主界面;把开关关掉即回到主界面形态(轮询感知,约一个 tick 周期内生效)
- **开关可用性**:已安装 better-sidebar 时可切换;未安装时开关呈禁用态仅展示(保持主界面,无副作用)

## 配置

设置页>插件 页「定时任务」卡片(`cron-board` 命名空间),各项均即时生效:`sidebarTab` 经卡片开关写入;其余项经配置文件或设置接口修改。

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `tickSeconds` | 调度轮询周期(秒,最小 5),变更后自动按新周期重建定时器 | 30 |
| `maxConcurrent` | 全局同时运行的执行单元上限 | 2 |
| `logKeepPerJob` | 每任务保留的运行日志份数(超出按文件修改时间裁剪) | 200 |
| `maskEnvInPrompt` | 会话任务投递文本中环境变量值打码 | 关 |
| `sidebarTab` | 看板移入 better-sidebar 侧边栏(需已安装;关闭时始终使用主界面) | 关 |

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
