# @mzzsfy/dsh-turn-notify

DeepSeek Harness 设置页插件:回合完成通知——host 单源决策,声音 / 系统弹窗 / webhook / IM 四通道,同一浏览器 profile 多窗口仅一份发声。

设计文档见 [docs/design/dsh-turn-notify-weixin.md](../../docs/design/dsh-turn-notify-weixin.md)。

## 功能

- 回合事件分类:host 观察 `session/event`(`turn/end` 六状态与 `ask_user_question` tool/call)与 `approval/request` waterfall(observe-only,`next()` 立即放行),按六分类开关(完成 / 出错 / 被中断 / 等待审批 / AI 提问 / 达到上限)产生通知单元。
- webhook:host 直发(标签页全关也送达),Slack-compatible `{text}` + 结构化字段,超时 10 秒不重试;设置面板内配置 URL,测试按钮返回真实投递结果。
- IM 投递:安装 [@xmanrui/dsh-im](https://www.npmjs.com/package/@xmanrui/dsh-im) 后自动启用,面板可从其已保存投递目标中多选(支持微信等九渠道),勾选即自动保存;支持绑定多个 bot,已绑 bot 以标签展示,点标签直接加载该 bot 目录,× 一键取消注册(移除该 bot 全部目标);触发逻辑与 webhook 完全一致(同文本、同分类开关、fire-and-forget 不重试);目标的新建与平台测试仍在 dsh-im 设置页完成,此处仅选择;测试按钮逐目标返回真实结果。
- 设置面板:webhook URL(凭据只写,不回显)、六分类开关、碎轮过滤、子代理豁免均在面板配置(host settings 持久化,热生效);音效管理与授权入口同面板;client 激活即轮询,不依赖面板打开。
- 发声通道:页内提示与系统弹窗各自独立开关(本机偏好);聚焦静默仅压声音与系统弹窗;用户行动空闲满 5 分钟视为离开,聚焦也全通道齐发;系统弹窗须浏览器授权,想弹未授权时降级标题闪烁。
- 写路由安全:config / mapping / upload / test-webhook / test-im / sound 改名与删除均带同源守卫(Origin 与 Host 不符即 403),JSON 写入另校验 content-type,阻断跨站 drive-by 改写;webhookUrl schema 标记 secret,任何接口不回传原文。已知边界:同源守卫不防 DNS rebinding(Origin 与 Host 相等即放行),该暴露面属 host webserver 全部 /api 路由的存量问题,应在 host 层统一解决而非逐插件补丁。
- 多窗口去重:投影(内存环形 20 条,60 秒过期)供各窗口约 2 秒轮询;localStorage 写后读回认领锁(30 秒过期接管,完成标记防迟到窗口重复发声)。
- 发声形态:聚焦窗口仅页内 toast(可关);失焦 + Notification 授权走声音 + 系统弹窗;HTTP 非回环(非 secure context)诚实降级 toast + 标题闪烁。
- 声音:Web Audio 程序合成 8 种内置音(零音频文件、零系统依赖),支持上传自定义音效(host 存储 `~/.dsh/dsh-turn-notify/sounds/`,扩展名 + decodeAudioData 双重校验,单文件 2MB / 总量 10MB);可多选文件,待保存列表逐个试听、逐个保存,不保存不落盘;已上传音效支持重命名(文件即 id,分类映射引用自动迁移,重名 / 内置音色名 / 非法字符 / 名称超 64 字符拒绝);通知会话标题取首个用户文本,超 60 字符按码点截断。
- 过滤:`minTurnDurationMs`(默认 5 秒)仅作用于 turn/end 类;`rootsOnly` 子代理会话默认豁免;`suppressSubagentWake` 子代理完成唤醒的父会话回合默认静默(仅 completed 类)。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-turn-notify
```

发布前开发安装(拷贝进 store,行为与 registry 安装一致):

```sh
dsh plugin --profile web add file:./packages/dsh-turn-notify
```

## 设置(settings.yaml 与面板等价,热加载)

面板(设置 > 消息通知 > 通知配置)与 settings.yaml 读写同一命名空间;webhookUrl 属凭据,面板只写不回显,yaml 直改仍可。yaml 形态:

```yaml
turn-notify:
  webhookUrl: ''                  # Slack-compatible webhook 目标,留空禁用
  minTurnDurationMs: 5000         # 回合最短时长过滤,毫秒
  rootsOnly: true                 # 子代理会话不通知
  suppressSubagentWake: true      # 子代理完成唤醒的父会话回合不通知(仅 completed)
  enabled:                        # 六分类独立开关
    completed: true
    error: true
    interrupted: true
    approval: true
    ask: true
    max-tokens: true
  soundMapping:                   # 每分类音效映射,空为内置默认,值为内置音名或上传音效 id;面板内每行可试听当前生效音效
    completed: ''
  imTargets:                      # dsh-im 投递目标,空数组禁用;botId/targetId 从 dsh-im 设置页复制
    - botId: wx_xxx
      targetId: owner
```

音量、聚焦静默、降级标题闪烁等本机偏好在设置面板内保存于浏览器 localStorage。

## 已知取舍

- 标签页全关时仅 webhook 与 IM 投递送达(声音与弹窗的浏览器前提)。
- IM 投递依赖 dsh-im 的 bot 在线,离线时该次通知弃置不补发;`{sent:true}` 仅为平台受理。
- 跨浏览器 profile 各自发声(localStorage 认领锁可见范围即 profile)。
- 系统弹窗在 HTTP 非回环下永久降级,HTTPS 化后自动恢复;Windows 下还受系统通知设置与专注助手约束,弹窗授权入口与权限状态见面板。
- 轮询认领引入约 2 秒发声延迟。

## 开发

```
cd packages/dsh-turn-notify && npm test
```
