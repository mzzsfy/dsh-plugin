// 兼容性判定链的纯判定归约:run.mjs / browser-probe.mjs 与
// tests/compat-judges.test.mjs 同源引用。合成输入断言「假绿输入必须 false」,
// 锁 M1(汇总恒真)/M2(上游留档放松)/M3(activation 折叠)/M4-M5(串漂移)变异类。
import { WORKSPACE_TEXT, FAIL_BANNER, IMPORT_FAIL_RE, UPSTREAM_PATHS } from './compat-criteria.mjs'

// 渲染判定:页面文本须含工作台文案且无行级加载失败横幅(browser-probe ok 的本体)
export function judgeProbeText(text) {
  return WORKSPACE_TEXT.test(text) && !text.includes(FAIL_BANNER)
}

// activation 快照判定:全 live 且 findings 0(语义 = run.mjs:207/:649 的精确形态,
// findingsCount 缺失即 false,禁止 ?? 折叠)
export function judgeActivationSnapshot(snapshot) {
  return snapshot !== null && snapshot !== undefined
    && snapshot.liveAll === true && snapshot.findingsCount === 0
}

// 上游留档判定:任一请求行命中对话通道前缀(ambient GET /models 不算)。
// 阈值锁死为「命中 UPSTREAM_PATHS 之一」,放松为 lines.length>0 即假绿(M2)
export function judgeUpstreamSeen(lines) {
  return lines.some((l) => UPSTREAM_PATHS.some((p) => typeof l?.path === 'string' && l.path.includes(p)))
}

// LLM 链路判定:provider 注册 + 真实对话驱动 + 上游取证三项全真(:633,truthy 语义同原链)
export function judgeLlm(llm) {
  return Boolean(llm !== null && llm !== undefined
    && llm.providerRegistered && llm.chatDriven && llm.upstreamSeen)
}

// 行级加载失败提取:任何命中失败字样的行即失败。包名前置过滤会漏检官方包崩因
// (0.1.5 实爆行含 @deepseek-ai/dsh-agent-preset,不在 @mzzsfy 名单);已知良性串
// 经 allowlist 显式豁免
export function judgeImportFailures(lines, allowlist = []) {
  return lines.filter((line) => IMPORT_FAIL_RE.test(line) && !allowlist.some((pattern) => line.includes(pattern)))
}

// 终局判定(:647-649):crash-only 三项;full 六项
export function judgeFinal({ crashOnly, page, browserOk, activation, llm, importFailures }) {
  const importsClean = importFailures.length === 0
  if (crashOnly === true) return page === true && browserOk === true && importsClean
  return page === true && judgeActivationSnapshot(activation) && browserOk === true
    && judgeLlm(llm) && importsClean
}
