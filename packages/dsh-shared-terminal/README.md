# DSH 共享终端

AI `terminal` 工具与用户通过 DSH 官方 Sidebar `terminal` tab 操作同一 Session-owned shell,并对同一终端的 Host xterm active viewport 做只读快照。写入通道随宿主代际:0.2.0 与 0.2.1-alpha.2 代 AI 借用官方 xterm UI 的输入 attachment 写入;0.2.1-rc.2 起插件自持输入附着(attach 泵,见下)。

## 功能

只注册一个工具 `terminal`：

| 动作 | 参数与语义 |
| --- | --- |
| `open` | 当前 Session 创建官方终端，返回 `terminal_id`。默认 `cols=80, rows=24`，整数范围 `cols=2..300, rows=1..200`，宿主仍可进一步限制；`shell_path` 只能选择 Controller 发现的 shell。成功结果挂载后打开官方 tab。 |
| `list` | 列出当前 Session 终端的标题、目录、尺寸、状态与 attachment 有无。 |
| `read` | 必填 `terminal_id`；`lines` 默认 20，范围 1–200。读取 active buffer viewport 内最新内容起的最多 N 个物理行——以最后一个非空行与光标行（非空时）为界，高窗口不会读到尾部空白；保留内部空行、软换行和当前 alternate screen（整屏坐标）。 |
| `write` | 必填 `terminal_id, text`；原样输入，`submit=true` 附加 CR。0.2.0 与 0.2.1-alpha.2 蹭 UI attachment 写（无附着返回 `NOT_ATTACHED`，不创建 follower、不抢 control）；0.2.1-rc.2 起自持 attach 泵（持续持有输入控制权，用户可随时「接管输入」抢回，泵的下一次写入重新抢回——最后写入者胜出；重抢仍失败返回 `TERMINAL_ERROR`，可重试）。 |
| `close` | 必填 `terminal_id`；通过官方 Controller 关闭终端，同一 Session 重复关闭保持宿主的幂等语义。 |

`read` 返回 `text, lines, truncated, state, sequence`；`truncated` 表示该读取窗口上方仍有当前 viewport 行未返回，不表示截断历史。`sequence` 是宿主输出帧编号，不是所有屏幕变化的修订号。请求行数超过屏幕内容范围时只返回实际内容行数。

`open` 结果提供“打开终端”按钮；已有匹配 tab 则揭示该 tab，不重复打开。`read/write/close` 只呈现结果，不触发导航。历史 `open` 结果只能打开仍存在的终端，不能恢复已经关闭的 PTY。

## 会话内工具卡片

`terminal` 调用在会话流中经官方 `tool.call.toolview` 槽位渲染：动作标题 + 摘要 + 可展开详情（read 的屏幕文本、list 的终端清单、write 的输入回显、open/close 的终端短 ID）；错误显示错误码与消息，参数或结果无法解析时回退原文行。文案经 locale 字典注册（中英双语），图标与文本微光使用官方 primitives，样式注入按 `data-plugin` 契约。

## 权限与版本边界

命令由 shell 执行；本工具不做命令安全校验。Controller 使用 **system-user execution permissions**，不受 Agent sandbox/approval 策略约束。命令可能修改系统用户有权限访问的文件。停止 AI 回合不撤销已经交给 Controller 的 `write/close`；排队写入也可能在取消后执行。

仅支持实测版本 DSH **0.2.0-rc.2、0.2.1-alpha.2 与 0.2.1-rc.2**（精确允许表；其他版本启动时干净禁用并告警）。`read` 使用这些版本共同的 `@deepseek-ai/dsh-api-terminal-controller` 私有 owner lookup、BrowserTerminal operation queue 和 xterm-headless active buffer。新建终端的工作目录：0.2.0-rc.2 为创建时的宿主默认工作区目录；0.2.1 起为 Session 当前目录（Controller 工作目录服务）。插件不修改 DSH、不另开 PTY、不读取 serializer 输出；附着策略随宿主代际：0.2.0 与 0.2.1-alpha.2 蹭 UI 附着写入（不调用 `follow` 抢 attachment），0.2.1-rc.2 起自持 attach 泵（见下）。

装载与功能是两层：peerDependencies 声明装载面（允许宿主装载后走停用路径），允许表声明功能面。dsh **0.2.1-rc.2** 实测：Controller 移除 `write`/`resize` 公开方法，输入改经 `attach` 命令帧通道——本包自持 attach 泵适配该模型：工具 `write` 时插件成为控制者（0.2.1-rc.2 输入排他），泵保持附着直到用户点官方「接管输入」拿回控制权、终端关闭被驱逐或插件停用；用户接管后泵的下一次写入会重新附着抢回（最后写入者胜出，用户可随时再次接管，双方交替互斥）。插件持有控制权期间用户页面显示「此页面当前只读」与「接管输入」按钮。0.2.1-rc.2 上切走浏览器页面等价于放弃输入控制权，AI 写入不再依赖 UI 附着。

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

也可设 `DSH_TEST_HOST`。runner 校验精确 Controller 版本后将绝对宿主路径传入子进程；测试 helper 从该宿主显式解析、校验并导入受支持版本的 Tools 与 Controller（同一允许表），不依赖 ESM 的 `NODE_PATH` 查找。未提供宿主且普通模块解析链缺少限定版本时明确失败，不跳过真实契约测试。

测试包含真实 BrowserTerminal/xterm 的宽字符、组合字符、软换行、scrollback、alternate buffer、resize、队列与关闭竞态；其 subprocess 边界为测试替身，不等于真实 shell E2E。真实 shell、工具调度和客户端装载须在独立 `DSH_HOME`、独立 profile、独立端口中另做验收。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.0-rc.2"`:低于该代际的宿主 API 面未验证,compat 装载层自动排除。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`。

dsh `0.2.1-rc.2` 起官方 Controller 移除 `write`/`resize` 公开方法,终端输入改经 `attach` 命令帧通道(gateway 侧 uplink):本包自持 attach 泵适配——工具 `write` 经 `controller.terminal(agent,id).attach()` 建立插件侧附着,命令帧 sequence 按附着世代严格递增(重抢后随新附着重置);read-only(用户接管)与 detached(附着流断)触发自动重抢一次,重抢仍失败返回 `TERMINAL_ERROR` 并提示重试;版本白名单已纳入 `0.2.1-rc.2`(dshReleases `compatible`)。
