# @mzzsfy/dsh-turn-notify

DeepSeek Harness 设置页插件:回合完成通知——host 单源决策,声音 / 系统弹窗 / webhook 三通道,同一浏览器 profile 多窗口仅一份发声。

设计文档见 [docs/design/dsh-turn-notify.md](../../docs/design/dsh-turn-notify.md)。

## 功能

- 回合事件分类:host 观察 `session/event`(`turn/end` 六状态与 `ask_user_question` tool/call)与 `approval/request` waterfall(observe-only,`next()` 立即放行),按六分类开关(完成 / 出错 / 被中断 / 等待审批 / AI 提问 / 达到上限)产生通知单元。
- webhook:host 直发(标签页全关也送达),Slack-compatible `{text}` + 结构化字段,超时 10 秒不重试,失败吞错。
- 多窗口去重:投影(内存环形 20 条,60 秒过期)供各窗口约 2 秒轮询;localStorage 写后读回认领锁(30 秒过期接管,完成标记防迟到窗口重复发声)。
- 发声形态:聚焦窗口仅页内 toast(可关);失焦 + Notification 授权走声音 + 系统弹窗;HTTP 非回环(非 secure context)诚实降级 toast + 标题闪烁。
- 声音:Web Audio 程序合成 8 种内置音(零音频文件、零系统依赖),支持上传自定义音效(host 存储 `~/.dsh/dsh-turn-notify/sounds/`,扩展名 + decodeAudioData 双重校验,hash 重命名,单文件 2MB / 总量 10MB)。
- 过滤:`minTurnDurationMs`(默认 5 秒)仅作用于 turn/end 类;`rootsOnly` 子代理会话默认豁免。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-turn-notify
```

发布前开发安装(拷贝进 store,行为与 registry 安装一致):

```sh
dsh plugin --profile web add file:./packages/dsh-turn-notify
```

## 设置(settings.yaml,热加载)

```yaml
turn-notify:
  webhookUrl: ''                  # Slack-compatible webhook 目标,留空禁用
  minTurnDurationMs: 5000         # 回合最短时长过滤,毫秒
  rootsOnly: true                 # 子代理会话不通知
  enabled:                        # 六分类独立开关
    completed: true
    error: true
    interrupted: true
    approval: true
    ask: true
    max-tokens: true
  soundMapping:                   # 每分类音效映射,空为内置默认,值为内置音名或上传音效 id
    completed: ''
```

音量、聚焦静默、降级标题闪烁等本机偏好在设置面板内保存于浏览器 localStorage。

## 已知取舍

- 标签页全关时仅 webhook 送达(声音与弹窗的浏览器前提)。
- 跨浏览器 profile 各自发声(localStorage 认领锁可见范围即 profile)。
- 系统弹窗在 HTTP 非回环下永久降级,HTTPS 化后自动恢复。
- 轮询认领引入约 2 秒发声延迟。

## 开发

```
cd packages/dsh-turn-notify && npm test
```
