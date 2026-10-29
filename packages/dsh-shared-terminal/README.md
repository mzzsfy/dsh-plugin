# DSH 共享终端

AI `terminal` 工具与用户通过 DSH 官方 Sidebar `terminal` tab 操作同一 Session-owned shell,并对同一终端的 Host xterm active viewport 做只读快照。写入通道随宿主代际:0.2.0 与 0.2.1-alpha.2 代 AI 借用官方 xterm UI 的输入 attachment 写入;0.2.1-rc.2 起插件自持输入附着(attach 泵,见下)。

## 功能

只注册一个工具 `terminal`：

| 动作 | 参数与语义 |
| --- | --- |
| `open` | 当前 Session 创建官方终端，返回 `terminal_id`。默认 `cols=80, rows=24`，整数范围 `cols=2..300, rows=1..200`，宿主仍可进一步限制；`shell_path` 只能选择 Controller 发现的 shell。成功结果挂载后打开官方 tab。 |
| `list` | 列出当前 Session 终端的标题、目录、尺寸、状态与 attachment 有无。 |
| `read` | 必填 `terminal_id`；`lines` 默认 20，范围 1–200。读取 active buffer viewport 内最新内容起的最多 N 个物理行——以最后一个非空行与光标行（非空时）为界，高窗口不会读到尾部空白；保留内部空行、软换行和当前 alternate screen（整屏坐标）。 |
| `write` | 必填 `terminal_id, text`；原样输入，`submit=true` 附加 CR。0.2.0 与 0.2.1-alpha.2 蹭 UI attachment 写（无附着返回 `NOT_ATTACHED`，不创建 follower、不抢 control）；0.2.1-rc.2 起自持 attach 泵：写入时抢附着，**空闲冷却 10s 后释放**（冷却期内连续写复用同一附着，sequence 递增；释放后首写重建附着并重置 sequence，最后写入者胜出，用户可随时接管）；重抢仍失败返回 `TERMINAL_ERROR`，可重试。 |
| `wait` | 必填 `terminal_id, text`；`text` 为待等待子串（大小写敏感逐字），`timeout_ms` 默认 10000、范围 100–55000（上限为工具超时减返回余量）。阻塞轮询屏幕直到 `text` 出现（`found`，携带命中时刻屏幕快照与 `elapsed_ms`）、终端进入 `exited/failed`（`exited`，退出优先于命中）、用户手动跳过（`skipped`，携带跳过时刻屏幕快照）或超时（`timeout`，携带 `timeout_ms` 与最后一次屏幕快照）。匹配面为 read 同款 active viewport：滚出屏幕的历史不参与匹配；等待中终端被关闭返回 `TERMINAL_UNAVAILABLE`；回合取消即中止。轮询间隔 100ms。 |
| `close` | 必填 `terminal_id`；通过官方 Controller 关闭终端，同一 Session 重复关闭保持宿主的幂等语义。 |

`read` 返回 `text, lines, truncated, state, sequence`；`truncated` 表示该读取窗口上方仍有当前 viewport 行未返回，不表示截断历史。`sequence` 是宿主输出帧编号，不是所有屏幕变化的修订号。请求行数超过屏幕内容范围时只返回实际内容行数。`wait` 复用同一快照形状并增加 `kind`；长命令（构建、服务启动、交互提示符）用 `wait` 同步完成信号，替代反复 `read` 轮询。

`open` 结果提供“打开终端”按钮；已有匹配 tab 则揭示该 tab，不重复打开。`read/write/close` 只呈现结果，不触发导航。历史 `open` 结果只能打开仍存在的终端，不能恢复已经关闭的 PTY。

## 会话内工具卡片

`terminal` 调用在会话流中经官方 `tool.call.toolview` 槽位渲染：动作标题 + 摘要 + 可展开详情（read/wait 的屏幕文本、list 的终端清单、write 的输入回显、open/close 的终端短 ID）；wait 摘要为等待子串并以徽章标示 `found/timeout/exited/skipped` 终态。错误显示错误码与消息，参数或结果无法解析时回退原文行。文案经 locale 字典注册（中英双语），图标与文本微光使用官方 primitives，样式注入按 `data-plugin` 契约。

### wait 手动打断（0.4.0 起）

wait 等待期间，工具卡片以等待子串替代「执行中」摘要（提示正在等什么）并显示「跳过等待」按钮；点击经宿主路由 `/api/shared-terminal/wait/skip`（POST JSON `{sessionId, terminalId}`）中断该终端当前全部 pending wait，wait 以 `skipped` 终态携带当前屏幕快照返回，AI 继续后续步骤——不打断回合。判定次序：回合取消 > 终端退出 > 文本命中 > 手动跳过 > 超时。路由按仓库安全边界仅做 Origin 同源比对，不做自有认证。

## 权限与版本边界

命令由 shell 执行；本工具不做命令安全校验。Controller 使用 **system-user execution permissions**，不受 Agent sandbox/approval 策略约束。命令可能修改系统用户有权限访问的文件。回合取消会拒绝尚未完成的插件泵写入并丢弃该附着尚未消费的输入；已经交给 Controller/provider 的 `write/close` 无法撤销。同代并发写随取消一起中止时，其他尚未确认的写报结果未知且不自动重发，以免重复执行已经投递的输入。卸载与关闭永久销毁对应泵，旧引用不可继续写入或自动重抢；关闭失败也不复用旧附着，仍允许再次尝试关闭。

仅支持实测版本 DSH **0.2.0-rc.1、0.2.0-rc.2、0.2.1-alpha.2、0.2.1-rc.2、0.2.1-rc.3 与 0.2.1-rc.4**（精确允许表；其他版本启动时干净禁用并告警）。`read` 使用这些版本共同的 `@deepseek-ai/dsh-api-terminal-controller` 私有 owner lookup、BrowserTerminal operation queue 和 xterm-headless active buffer。新建终端的工作目录：0.2.0-rc.2 为创建时的宿主默认工作区目录；0.2.1 起为 Session 当前目录（Controller 工作目录服务）。插件不修改 DSH、不另开 PTY、不读取 serializer 输出；附着策略随宿主代际：0.2.0 系与 0.2.1-alpha.2 蹭 UI 附着写入（不调用 `follow` 抢 attachment），0.2.1-rc.2 起自持 attach 泵（见下）。

装载与功能是两层：peerDependencies 声明装载面（允许宿主装载后走停用路径），允许表声明功能面。dsh **0.2.1-rc.2** 实测：Controller 移除 `write`/`resize` 公开方法，输入改经 `attach` 命令帧通道——本包自持 attach 泵适配该模型：工具 `write` 时插件成为控制者（0.2.1-rc.2 输入排他），**最后一笔写入 ack 后空闲冷却 10s 才释放附着**。释放仍必要：无人附着时宿主向 UI 广播状态使其恢复可写并按容器重算终端几何——若泵永久附着，UI 长期只读，官方布局重算被跳过，插件写入推高的 PTY 行数会把终端底部推出可视区且滚动失效。冷却期亦必要：写完立即释放会让每次写入都经历 attach/detach,宿主 gateway `cancellableStream` 的 abort 竞态偶发吞掉 UI 输出流的终止信号(实机复现:渲染冻结在旧屏、phase 停留 connected,须换代重连恢复);高频连续写场景下"写完即释放"的停摆概率显著,冷却把 attach/detach 频率从每写一次收敛到每轮命令一次。用户点官方「接管输入」随时拿回控制权；用户接管后泵的下一次写入会重新附着抢回（最后写入者胜出，双方交替互斥）。0.2.1-rc.2 上切走浏览器页面等价于放弃输入控制权，AI 写入不再依赖 UI 附着。

Host 启动检查 Controller 版本、方法和 owner map；检测不匹配时不注册工具并告警。每次读取另检查终端实例、队列和屏幕结构，失败返回 `TERMINAL_UNAVAILABLE`。这不是公开 API，升级后不保证兼容。

## 安装与重装

在已安装受支持 DSH 版本的环境中，用 `dsh plugin --profile web add @mzzsfy/dsh-shared-terminal` 安装**已发布版本**，然后重启该 profile 的宿主；重装或升级即重新执行同一命令并重启。当前仓库实现未发布，不能用此命令获取未发布源码。

仓库开发态在仓库根使用唯一链接入口；Windows 脚本固定操作 `%USERPROFILE%/.dsh/profiles/web`，需该 profile 已初始化且 pnpm/cmd 可用，不跟随隔离 `DSH_HOME`：

```sh
node scripts/dev-link.mjs dsh-shared-terminal
```

新增 bundle 后需重启宿主；不需要改 DSH 源码或构建官方前端。此插件客户端已按宿主 classic-script ModuleLoader 格式编写。

## 验证

测试需要任一受支持版本完整、独立安装的宿主闭包（独立 `DSH_HOME` 安装该版本即得）。宿主目录指包含该宿主 `node_modules` 的目录，不是 Controller 包目录：

```sh
# 在插件包目录执行
npm test -- /path/to/isolated-dsh-host
```

也可设 `DSH_TEST_HOST`。runner 校验精确 Controller 版本后将绝对宿主路径传入子进程；测试 helper 从该宿主显式解析、校验并导入受支持版本的 Tools 与 Controller（同一允许表），不依赖 ESM 的 `NODE_PATH` 查找。未提供宿主且普通模块解析链缺少限定版本时明确失败。旧 Controller 没有 attach 时，attach 专属真实生命周期场景会明确跳过；验证 attach 修复必须另跑支持 attach 的主测宿主，要求这些场景全部执行且通过。

测试包含真实 BrowserTerminal/xterm 的宽字符、组合字符、软换行、scrollback、alternate buffer、resize、队列与关闭竞态；UI 附着夹具按宿主能力使用 `follow/resize` 或 `attach` resize 命令帧，验证读取排在 resize 之后，且原 follower、控制者和可写权限保持不变。其 subprocess 边界为测试替身，不等于真实 shell E2E。真实 shell、工具调度和客户端装载须在独立 `DSH_HOME`、独立 profile、独立端口中另做验收。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.0-rc.1"`:低于该代际的宿主 API 面未验证,compat 装载层自动排除。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)。

dsh `0.2.1-rc.2` 起官方 Controller 移除 `write`/`resize` 公开方法,终端输入改经 `attach` 命令帧通道(gateway 侧 uplink):本包自持 attach 泵适配——工具 `write` 经 `controller.terminal(agent,id).attach()` 建立插件侧附着,命令帧 sequence 按附着世代严格递增(空闲冷却释放与重抢后随新附着重置);read-only(用户接管)与 detached(附着流断)触发自动重抢一次,重抢仍失败返回 `TERMINAL_ERROR` 并提示重试;版本白名单已纳入 `0.2.1-rc.2`、`0.2.1-rc.3` 与 `0.2.1-rc.4`(dshReleases `compatible`)。
