// 基准输入规模:取自本机真实数据面(2026-11-11 只读统计),固定为常量使基准可离线复现。
// 规模变化后重跑统计并更新此处,不读取生产目录。
// 统计命令:会话目录数 = find ~/.dsh/sessions -maxdepth 2 -name 'session-*' -type d | wc -l
export const SCALE = {
  // 会话目录数
  sessions: 782,
  // usage_stats 桶行数(M 分钟 / H 小时 / D 天)
  usageMinutes: 1232,
  usageHours: 669,
  usageDays: 322,
  // usage_stats 会话索引行数
  usageSessionRows: 307,
  // 看板任务数
  boardTasks: 1000,
  // 单次行情刷新判定的证券数
  quotesPerRefresh: 100,
}
