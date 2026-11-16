# @mzzsfy/dsh-keep-working

持续工作:回合未声明结案就静默结束时,自动补一条用户消息把 AI 拉回,直到它交付产物或明确中止。

替代 `dsh-client-auto-continue` 的全部宿主侧恢复能力,并补上“任务没做完但回合正常结束”这一缺口。

## 结案规则

一句话:改过文件就 `present` 交付(之后不要再改文件、不再写 `TASK_DONE`),没改文件就最后一行单独写 `TASK_DONE`,做不下去最后一行写 `TASK_BLOCKED: 原因`。

判定层严格匹配裸标记:最后一行必须恰好是 `TASK_DONE`,或 `TASK_BLOCKED: 非空原因`。括号、下划线、连字符、反引号、粗体与句末标点都不算结案。

`write` / `edit` / `str_replace_editor` 的写调用都算改过文件,不区分路径。`apply_patch` 不是本宿主工具,不计。失败的写与 `str_replace_editor` 的 `view` 子命令不算。判定层在 present 有效时即判定结案,不追罚多余标记;二选一由提示词约束。

边界:经 shell 工具改写文件(`sed -i`、重定向)不在识别面内,这类回合不会被要求 present。工具名穷举不可能覆盖所有写路径,这里不追罚也不补判,是显式的口径边界。

规则经 `systemPrompt.section` 常驻注入,不依赖提醒文案;`enforceClosure` 只关闭“未结案就补发”的强制层,提示词段落始终注入、不随开关变化。段落在 `DELIVERABLE_FILE_REFERENCES` 之后注册:宿主那段建议里写着“不要只为列出编辑过的源文件就调用 present”,结案规则必须压在其后,并显式声明 present 的时机以本段为准。

未结案时补发一条用户消息,内容按原因选择:结案提醒 / 输出截断 / 重启中断 / 失败详情 / 无可见输出。

## 恢复矩阵

| `turn/end` 原因 | 动作 |
|---|---|
| `completed` 且已结案 | 清连续计数,不发送 |
| `completed` 且有可见输出但未结案 | 实时结案提醒;重启扫描有可见回答直接跳过 |
| `completed` 且无可见输出 | 无输出提醒;有写入没 present 时改为结案提醒 |
| `error` | 先看结案;已结案不发送,否则补发继续文案。默认所有错误都重试(受 `maxConsecutive` 封顶);开启「区分永久错误」后只跳过上下文超限、参数非法等请求结构错误,鉴权、余额、模型不存在、401/403 等上游级错误仍重试(中转后面可能还有别的上游);网关断流、连接重置、超时等传输故障始终按临时错误重试(即使上游把它们包装成 `INVALID_REQUEST`) |
| `interrupted` | 重启中断提醒,不看结案标记 |
| `max-tokens` | 先看结案;已结案不发送,否则截断提醒 |
| `aborted` | 用户取消不恢复;`disposed` / `legacy` 按中断恢复,不看结案标记 |
| `blocked` | 宿主 pre-step 被拒的回合终态(维护闸门、目标预约竞争等),按中断恢复;归档会话与子会话除外。目标因此落成 `blocked`(`prompt-rejected`)时重新武装交回 driver |
| `forked` 等 | 不处理 |

以下回合一律不发送:子会话(`origin === 'subagent'`,旧记录按 `parentSession` + `delegationDepth >= 1`)、用户中途插话的回合、非用户发起的回合的结案提醒、已达连续上限的会话。

`enforceClosure=false` 时表中所有“未结案”分支不成立:正常结束的回合直接结案,写文件不要求 present、末行不要求标记;只有空回合(`resumeSilentTurns`)、中断、报错、重启扫描仍按各自规则恢复。系统提示词不变。

实时路径的 `interrupted` 与 `disposed` / `legacy` 取消不看标记,始终补中断提醒;这是插件的主恢复功能。重启扫描的 `interrupted` / 未闭合回合同样恢复中断,只有正常结束的回合才用可见回答 / done / present 判断是否冷启动恢复。`blocked` 在宿主里只表示 pre-step 被拒(维护闸门、归档闸门、目标预约竞争),拒绝发生在两个 step 之间,不等于末行 `TASK_BLOCKED: 原因`,也不等于回合已交付;按 `interrupted` 同一口径恢复。归档会话与子会话继续排除:归档闸门的拒绝就是这个集合的预期终态。目标会话的 blocked 回合优先交回 goal driver(仍 active 的由 driver 自己续跑,`prompt-rejected` 的重新武装),目标已完结、非预检阻塞或接回异常时补中断消息;接回冷却中先补消息,冷到点由定时器再交回一次。除此之外的"不驱动"都是有意为之:全局暂停、目标暂停、归档会话、子会话。

已 live 不等于已接管。客户端打开会话就会物化 agent,而崩溃重启后浏览器会重连并打开上次的会话——此时 agent 空闲、回合仍停在中断状态,若不补消息就永远没人续跑。扫描因此只在 `agent.status === 'running'`(真有回合在跑)时让路,空闲的 live agent 照常补恢复消息,且不再重复 `resume`。

## 节奏

`graceMs` 到点才发送;两次发送之间至少间隔 `cooldownMs`,连续失败按 `backoffFactor` 退避,封顶 `backoffMaxMs`;单会话连续 `maxConsecutive` 次后放弃,等待人工介入;真人发起的回合一到就清零,额度恢复。`cooldownMs` 同时是目标接回的最小间隔:冷却中降级为补消息,到点由定时器再尝试接回一次,频率受同一窗口约束,失败与补发都计入连续上限。判定看回合前导段:宿主注入的上下文(指令文件、工作目录、任务事件等,来源不是 `user`)不算发起,本插件补发的消息也不算。

断网时挂起,`offlineCheckMs` 后复查;探测失败按在线处理,不会永久卡住。

## 重启恢复

冷启动延迟 5 秒扫存储会话:直接扫 `$DSH_HOME/sessions` 取最近 `freshMs` 内写过的候选(上千个文件 stat 一遍是百毫秒级,候选通常只有几个),再按日志规模从小到大逐个判定。拿不到归档集合时本轮不恢复,下一轮重试。

正常结束的回合:有可见回答(含 done)就跳过;没有可见回答时,本回合最近 10 条消息里的 `present` 也算结案;仍没有且写过文件,补 present 提醒(关闭 `enforceClosure` 后不补),否则按空回合处理。未闭合、`interrupted`、`disposed` / `legacy` 取消不看 done / present,一律恢复中断。子会话(origin 或旧格式 parentSession+depth)、已归档、用户主动取消同样排除。已被客户端打开物化的会话只有正在跑回合才排除:空闲的照常补恢复消息,这是"浏览器重连后没人续跑"的唯一兜底。剩余会话物化后补一条恢复消息,每轮最多 `scanLimit` 个。

重启前已进入宿主 durable inbox 的排队消息是例外:它们不会自动唤醒 agent。扫描重放 `agent/inbox/spliced` 投影,`next-turn` 全部、`next-step` 中真人插话计为待处理输入;有排队消息的会话即使已 done / present 也恢复,用户主动取消除外。恢复消息只写「继续」,必须插队发送(`agent.steer` 进 next-step),不追加到排队队列尾部、不重排或丢弃队列。

`goal` 在进程重启后会被宿主 disarm,`resumeGoals` 开启时对 `active` 且 `disarmed` 的 goal 重新武装。被宿主 pre-step 拒绝打成 `blocked`(`blockedReason.code = prompt-rejected`)的目标同样是基础设施动作而不是模型的决定,一并重新武装;其他阻塞码视为模型或人的判断,不接管。

启动扫描不常驻轮询:目录快照完整可读时一轮即止(近期没有会话被写过就是常态结果);持久层或全量回退给出空列表时按 1s→60s 指数退避重试,直到列出会话或超出 `freshMs` 总窗口;快照不完整(部分子项读失败)时同样重试到窗口耗尽,不因已列出若干会话而收工。单会话读取/物化失败只回退该会话并标本轮未完成,下一轮重试;扫描在途时插件卸载会中止旧代,不再补发消息;设置重建会撤销旧代去重登记,观察在途由新代重扫,resume 已物化的 agent 由新代补投恢复消息;新代已进入 stat/list 等待后旧代才收敛的 agent 也会在候选循环消费,不会被 live 短路或误判收工。重复扫描日志按分钟降频。

## 配置

见 `src/config.mjs` 的 `DEFAULTS`;全部字段可在 profile 条目 `config` 中覆盖。语义要点:

- `paused`:全局刹车,置 true 后所有恢复停止
- `enforceClosure`:默认开启;关闭后正常结束的回合不再要求 `TASK_DONE` / `TASK_BLOCKED` 或 `present`,也不补结案提醒,系统提示词不变
- `resumeGoals`:默认开启,与宿主“重启后 disarm”的默认相反,这是本插件有意的行为差异;同时覆盖被宿主预检拒绝打成 `blocked` 的目标
- `resumePausedGoals`:默认关闭,暂停是人的决定
- `classify`:默认关闭,所有 `error` 都会重试(受 `maxConsecutive` 封顶);开启后只跳过请求结构类永久错误(上下文超限、`INVALID_ARGS`、`NO_ADAPTER`、`MISSING_CREDENTIAL`、prompt 变量缺失)。鉴权、余额、模型不存在、401/403 等上游级错误始终重试:中转服务后面可能还有别的上游,换一条通道就可能成功

## 设置面板

配置卡片挂在插件管理页的包详情里(`plugins.bundle.config`,key 为包名),写的是宿主 `settings` 服务(profile 条目 `config` 的 volatile 字段),保存即时重建恢复引擎,不需要重启。

面板字段:总开关、结案强制、等待时间、冷却、最大连续次数、重启恢复、空回合恢复、断网暂停、错误分类,以及六段补发文案:出错后、中断后、dsh 重启后、空回合、输出截断、未结案提醒。其余字段(退避倍数、扫描窗口等)仍走 `DEFAULTS` 与 profile 配置。

`restartText` 是冷启动扫描专用文案(默认「继续,dsh已重启」),与实时路径的中断文案 `continueTextInterrupted` 互相独立:进程重启后"dsh 已重启"是唯一能解释现状的信息。截断、空回合与结案提醒各有专项文案,不并入重启文案;排队消息只补一个「继续」。

宿主路由 `GET/POST /api/keep-working/config` 供面板读写;`GET` 同时返回默认值,供「恢复默认」使用。

## 与 dsh-client-auto-continue 的关系

本包接管其宿主侧全部职责,装上后可卸载对方。未实现的部分:浏览器通知、会话级模式开关、循环护栏、子会话唤醒根会话。两包同时启用会出现同一回合被推两次。

## 开发

```bash
node --test "test/*.test.mjs"
```

判定、分类、探测、调度、扫描均可单测,不依赖宿主进程。

## dsh 版本兼容

宿主 API 面:`agents`、`systemPrompt`、`sessionQuery`(实时判定用 `observeSession` 观察切面)、`workspaceRegistry`、`goals`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`。

缺 `agents`、`systemPrompt` 或 `sessionQuery` 时插件干净停用(不注册任何服务与提示词)。`@deepseek-ai/dsh-llm` 动态导入失败时整体停用并留日志。

当前实测版本见 `dsh.compatibility.dshReleases`;manifest 声明 `dsh.hostMin: 0.2.2-rc.1`,低于该代际的宿主不装载(0.2.1 的 `observeSession` 观察切面不可用)。
