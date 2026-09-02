# @mzzsfy/dsh-think-expand

DeepSeek Harness 纯前端插件:流式输出思考时自动展开最新一条思考行,免去每次手点。

## 行为

| 场景 | 行为 |
|---|---|
| 流式思考行出现(`data-state="running"`) | 自动展开该行 |
| 新思考行出现 | 收起上一条由插件展开的行,展开新行 |
| 用户手动展开任意行 | 插件收起自己展开的行,此后不再干预该手动行 |
| 用户手动收起插件展开的行 | 视为已读,本轮不再展开,直到下一条新思考行 |
| 流式结束(`running` → `ok`) | 保留最后一条展开状态 |
| 历史会话 | 行均为 `ok`,不自动展开 |
| 设置页开关关闭 | 断开监听,收起全部由插件展开的行,清空标记 |
| 卸载插件 | 无持久副作用,重载页面即恢复官方默认行为 |

同一时刻至多一条思考行处于展开状态;不做行数裁剪,不改写思考正文与官方折叠组件结构。

## 实现要点

- Think 行识别:官方 ReasoningRow 根节点字面量属性 `[data-variant="think"]` + `data-state`,折叠头 `[data-disclosure-row]`,滚动容器 `[data-conversation-scroll]`;识别失败即不干预。
- 展开/收起模拟点击折叠头(按 `aria-expanded` 判定),与官方组件状态机一致,不直改 DOM 内部状态,不写任何 DOM 属性。
- 行标识 = 展开时 `.thinkBody` 正文哈希,标记载体为模块级 Map,流式追加按已见文本前缀匹配;随页面生命周期存活,不持久化。
- 设置开关存 localStorage(键 `dsh-think-expand:settings`,默认开),面板挂设置页 `settings.section` 槽位。
- 纯逻辑层(行分类、展开决策、标记存活性)在 `src/logic.mjs`,`src/client.js` 内嵌同源实现,`node --test` 以同一套 BDD 场景对两份实现做 parity 验证。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-think-expand
```

重启 dsh 后设置页出现"思考自动展开"开关(默认开),流式会话即生效。

## 升级 / 卸载

```sh
dsh plugin --profile web add @mzzsfy/dsh-think-expand      # 升级到最新发布版本
dsh plugin --profile web remove @mzzsfy/dsh-think-expand   # 卸载
```

插件无 Host 端状态、无持久化副作用,卸载后重载页面即恢复官方默认行为。

## 测试

```sh
pnpm --dir packages/dsh-think-expand test
# 或
node --test packages/dsh-think-expand/test/*.test.mjs
```

覆盖:哈希确定性、八条 BDD 行为场景、批量 running 降级、识别失败降级、开关清理、双实现 parity、client.js 语法检查。

## License

MIT
