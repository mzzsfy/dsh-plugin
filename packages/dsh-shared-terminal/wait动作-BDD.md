# wait 动作 BDD

`terminal` 工具新增 `wait` 动作:阻塞等待指定文本出现在终端屏幕(read 的 active viewport),带超时与终端退出短路。参照 dsh-better-sidebar `terminal_wait_for`,适配共享终端的 viewport 快照模型(无 transcript,滚出屏幕即不可见)。

## 请求形状

```json
{ "action": "wait", "terminal_id": "…", "text": "Build successful", "timeout_ms": 30000 }
```

- `terminal_id`、`text` 必填;`text` 为待等待子串,大小写敏感逐字匹配,非空
- `timeout_ms` 可选,默认 10000,合法域 [100, 55000](上限 = 工具超时 60s − 5s 返回余量),越界拒绝 `INVALID_TIMEOUT`

## 场景

### W1 文本已在屏幕,立即 found

- Given 终端屏幕文本已包含 needle
- When 执行 wait
- Then 返回 `kind:"found"`,携带 `elapsed_ms` 与当前屏幕快照(`text/lines/truncated/state/sequence`),不等待

### W2 文本稍后出现,轮询后 found

- Given 屏幕第 N 次轮询才出现 needle
- When 执行 wait
- Then 每隔轮询间隔读一次屏幕,命中即返回 `kind:"found"`,屏幕快照为命中时刻

### W3 needle 未出现,超时 timeout

- Given 超时内 needle 始终未出现且终端保持 running
- When 执行 wait
- Then 返回 `kind:"timeout"`,携带 `timeout_ms` 回显与最后一次屏幕快照

### W4 终端退出,exited 短路

- Given 轮询中 readScreen 返回 `state:"exited"` 或 `"failed"`
- When 执行 wait
- Then 即使该轮屏幕已含 needle 也返回 `kind:"exited"`(退出优先),携带屏幕快照

### W5 参数闭合

- When text 为空串 / 含未知字段 / terminal_id 无效
- Then 拒绝 `INVALID_ARGS`
- When timeout_ms 非整数或越界
- Then 拒绝 `INVALID_TIMEOUT`

### W6 协作取消

- Given 等待进行中回合被取消(exec.signal abort)
- Then 等待中止,返回 `TERMINAL_ERROR`(宿主同时以取消收敛该工具调用)

### W7 终端中途不可用

- Given 等待中 readScreen 抛 `terminal/unavailable`(终端被关闭)
- Then 返回 `TERMINAL_UNAVAILABLE`,不吞错继续空转

## 手动打断(SK,0.4.0 起)

对齐 dsh-better-sidebar 交互:等待期间用户可跳过本轮等待而不打断回合,工具卡片提示正在等什么并提供「跳过等待」按钮。

### SK1 用户跳过,wait 立即返回

- Given wait 等待中(needle 未出现,未超时)
- When 用户点「跳过等待」,client POST `/api/shared-terminal/wait/skip` `{sessionId, terminalId}`
- Then 宿主端同键全部 pending wait 被 abort,wait 返回 `kind:"skipped"` 携带当前屏幕快照,AI 得以继续

### SK2 幂等

- Given 无 in-flight wait
- When POST skip
- Then `{ok:true, skipped:0}`,无副作用

### SK3 命中优先

- Given skip 与 needle 出现在同一轮询轮
- When 两者同时可判定
- Then 返回 `found`(命中不被 skip 吞掉)

### SK4 回合取消优先级不变

- Given 回合已取消
- When wait
- Then 维持 W6 语义,skip 通道不改变协作取消行为

### SK5 卸载收敛

- Given 插件 dispose 时有 pending wait
- Then 全部 pending 被 abort,注册表清空

### SK6 路由闭合

- When 跨源 Origin / 非 POST / 缺 sessionId 或 terminalId
- Then 分别 403 / 405 / 400

### SK7 卡片交互(client)

- Given wait 运行中,卡片 summary 显示等待子串(替代「执行中」)并提供「跳过等待」按钮
- When 点击,POST skip;结果 `kind:"skipped"` 落卡显示「已跳过」徽章
- 非 wait 动作不出现该按钮;请求失败在卡片内显示错误徽章

## 结果 schema(单闭合分支并入 oneOf)

`ok/terminal_id/kind(enum found|timeout|exited|skipped)/text/lines/truncated/state/sequence` 为公共必填字段,`elapsed_ms`(found)/`timeout_ms`(timeout)按 kind 出现;`ok:false` 错误分支(`error{code,message}`)共用同一 oneOf。

## 工具卡片(client)

- 动作名:等待屏幕文本 / Wait for screen text
- 摘要 = needle;徽章 = kind(已出现/超时/已退出/已跳过)
- 展开 = 屏幕快照(空屏显示兜底提示,与 read 同构)
- 运行中 = summary 显示 needle + 「跳过等待」按钮(交互时序见 SK7)
