# 性能基准

改性能前先有基线：`scripts/perf/bench.mjs` 提供可复现的微基准，测量各包热路径单次调用成本。没有基线数据的"变快了"不算证据，也不接受。

## 用法

```bash
node scripts/perf/bench.mjs                     # 跑全部用例,人读表格
node scripts/perf/bench.mjs --only usage        # 只跑名字含该片段的用例
node scripts/perf/bench.mjs --json .work/perf-base.json    # 落基线
node scripts/perf/bench.mjs --compare .work/perf-base.json # 比对,劣化超阈值非零退出
```

比对阈值（`bench.mjs` 内常量）：中位数劣化超过 15% 判回归并以非零码退出；低于 85% 才在报告里标为改善。

## 测量约定

- 单轮批量计时、多轮取样报中位数，预热轮不计数；方差大于 10% 先关后台任务再测。
- 用例输入规模来自真实数据面快照（`scripts/perf/scale.mjs`），不读生产目录。规模变化后重跑统计并更新常量。
- 用例不写盘、不出网、不依赖时钟：时间锚点与随机序列都固定种子，同一输入可跨会话比对。
- DOM 与浏览器侧成本无法在 node 内测，涉及 client 的结论必须标"需测量"，不写推测数字。

## 已收录用例

| 用例 | 覆盖 | 输入规模 |
|---|---|---|
| `usage-dash/aggregateRange-M/H/D` | 用量面板三粒度聚合 | 2223 桶行 |
| `bug-perf/slimList-782` | 会话列表投影裁剪（含透传对照） | 782 会话 |
| `boss/queryBoard-1000` | 任务看板全量投影 | 1000 任务 |
| `boss/projectTaskDetail-1000` | 逐任务详情投影 | 1000 任务 |
| `stock/sessionStateOf` | 交易时段判定（单次刷新逐笔调用） | 100 笔 / 2 时区 |

## 新增用例

在 `scripts/perf/cases/` 加文件，导出 `cases` 数组，每项为 `{ name, description, scale, iterations, setup, run }`（异步用 `runAsync`）。`name` 用 `<包>/<场景>` 形式，是比对基线的键，改名等于丢弃历史数据。

## 判据

单次调用成本要结合触发频率判断，不是绝对值越小越好：

- 落在用户交互路径上（打开面板、翻页、发送消息）的单次成本超过 50ms 才构成可感知卡顿。
- 周期任务看"单次成本 × 频率"占单核的比例，超过 1% 才值得改。
- 一次性启动成本单独看，不并入稳态指标。

测量到的热点与处置结论记在任务记录里，不写进本文件；本文件只管怎么测。
