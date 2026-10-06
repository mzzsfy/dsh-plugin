// 探针谓词与判定值表(纯常量模块,无 CLI 副作用):run.mjs 与
// tests/l3-probe-fixture.test.mjs 同源引用,fixture 自测防选择器/哨兵漂移静默失效
// 宿主 0.2.0 起无可用 provider 时 DeepSeekOnboardingDialog 自动弹出,输入框
// autoFocus 抢占焦点且 appRoot 置 inert:探针的 type 会整段落进 API Key 输入框,
// 中文消息触发「密钥格式错误」字段校验,发话被吞(FIND-020-1 伪影根因)。
// 每轮 type 前先关弹窗,type 后校验 composer 实际持有文本
export const dismissOnboardingEval = `(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => (d.getAttribute('aria-label') ?? '').includes('API Key'));
  if (!dialog) {
    // 拆义(轮 3 收敛缺口③):无弹窗必须携带正信号(composer 在场 = 扫描确实活着
    // 且应用可交互);弹窗与 composer 双缺是 infra 异常,不得混入合法清空值
    const composer = document.querySelector('[contenteditable="true"]');
    return composer ? 'dialog-absent' : 'scan-inconclusive';
  }
  const later = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后配置');
  if (!later) return 'later-not-found';
  later.click();
  return 'dismissed';
})()`
export const verifyTypedEval = `(() => {
  const ce = document.querySelector('[contenteditable="true"]');
  return JSON.stringify({ composerText: ce?.textContent ?? 'missing' });
})()`
// 新建会话:aria-label 与可见文本并集匹配(先拼串后 includes;禁止「串+布尔」恒真形态)
export const newSessionEval = `(() => {
  const hit = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('aria-label') ?? '') + ' ' + b.textContent).includes('新建会话'))
  if (!hit) return 'new-session-not-found'
  hit.click()
  return 'clicked'
})()`
// 弹窗已清判定值表:dismiss 结果落在表内才允许发话判定继续(FIND-020-1 门);
// scan-inconclusive(双缺)故意不在表内——判定端必须红
export const ONBOARDING_CLEARED_VALUES = ['dialog-absent', 'dismissed']
