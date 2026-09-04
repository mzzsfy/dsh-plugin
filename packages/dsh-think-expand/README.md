# @mzzsfy/dsh-think-expand

DeepSeek Harness 插件:流式输出思考时自动展开最新一条思考行,免去每次手点。

## 行为

| 场景 | 行为 |
|---|---|
| 流式思考行出现(`data-state="running"`) | 自动展开该行 |
| 新思考行出现 | 收起上一条由插件展开的行,展开新行 |
| 用户手动展开任意行 | 插件收起自己展开的行,此后不再干预该手动行 |
| 用户手动收起插件展开的行 | 视为已读,本轮不再展开,直到下一条新思考行 |
| 流式结束(`running` → `ok`) | 保留最后一条展开状态 |
| 打开会话 / 刷新页面 / 切换会话 | 最后一条思考行自动展开,其余保持收起 |
| 自动展开后用户手动收起 | 不再重展开,直到下次打开或切换会话 |
| 用户手动展开较旧行 | 手动意图优先,插件不展开最后一条 |
| 卸载插件 | 无持久副作用,重载页面即恢复官方默认行为 |

无任何设置项,安装即自动生效;同一时刻至多一条思考行处于展开状态;不做行数裁剪,不改写思考正文与官方折叠组件结构。

## 实现要点

- Think 行识别:官方 ReasoningRow 根节点字面量属性 `[data-variant="think"]` + `data-state`,折叠头 `[data-disclosure-row]`,滚动容器 `[data-conversation-scroll]`;正文容器按 `thinkBody` 类名子串匹配(CSS Modules 哈希带前缀);识别失败即不干预。
- 展开/收起模拟点击折叠头(按 `aria-expanded` 判定),与官方组件状态机一致,不直改 DOM 内部状态,不写任何 DOM 属性。
- 行标识 = 展开时正文哈希,标记载体为模块级 Map,流式追加按已见文本前缀匹配;client 端插件展开过的行另以元素 WeakSet 记账(会话切换重置),供决策层区分手动展开,不写 DOM 属性;全部标记随页面生命周期存活,不持久化。body 哨兵观察器常驻 document.body 监视容器身份变化(会话切换),非流式期间仅容器子树变更触发扫描。
- 纯逻辑层(行分类、展开决策、标记存活性)在 `src/logic.mjs`,`src/client.js` 内嵌同源实现,`node --test` 以同一套 BDD 场景对两份实现做 parity 验证。
- Host 半区 `src/index.js` 为空壳,profile 行仅用于让 client 模块系统发现本包的 dsh.client 声明。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-think-expand
```

重启 dsh 后流式会话即生效,无任何配置。

## 升级 / 卸载

```sh
dsh plugin --profile web add @mzzsfy/dsh-think-expand      # 升级到最新发布版本
dsh plugin --profile web remove @mzzsfy/dsh-think-expand   # 卸载
```

插件 Host 半区为空壳,无任何 Host 端状态;卸载后重载页面即恢复官方默认行为。旧版本开关的 localStorage 键与 settings 字段残留均不影响任何行为。

## 测试

```sh
pnpm --dir packages/dsh-think-expand test
# 或
node --test packages/dsh-think-expand/test/*.test.mjs
```

覆盖:哈希确定性、上表全部行为场景、批量 running 降级、识别失败降级、空正文降级、双实现 parity、client.js 语法检查。

## License

MIT
