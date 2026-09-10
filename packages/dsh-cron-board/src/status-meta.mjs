// status-meta:运行状态五态+中断的展示元数据(core 侧单一事实源)。
// client.js LOGIC 段镜像此表,parity 测试锁定(双实现同源规约)。

export const STATUS_META = {
  success: { label: '成功', tone: 'ok' },
  fail: { label: '失败', tone: 'bad' },
  timeout: { label: '超时', tone: 'warn' },
  skipped: { label: '跳过', tone: 'mute' },
  interrupted: { label: '中断', tone: 'mute' },
  running: { label: '运行中', tone: 'run' },
}

export const TRIGGER_META = {
  cron: { label: '定时' },
  manual: { label: '手动' },
}
