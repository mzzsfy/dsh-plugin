// L3 包级断言表:基线步骤沿用 .compat/version-watch/l3-plan/steps.json 的 19 包判据,
// 9 个目标包另加编号格 checks(定义见 scripts/compat/l3-checks.md 与各包兼容性测试.md)。
// checks 只做只读断言:选择器命中/文本/计数、只读 API 2xx + 字段、页面内只读求值、截图。
export const L3_BASE = {
  'dsh-auto-trust-all': {
    open: null,
    apis: [],
    textHits: [],
    // 首页 FloatingTicker 抛 useFloatingTrend 未定义,来源为宿主打包产物而非本包;登记为跨包噪声
    consoleNoiseText: ['useFloatingTrend is not defined'],
    note: '无 UI;#3-#14 需伪造 Host(curl.exe)与宿主日志,cookie 从页面上下文带',
  },
  'dsh-boss-simulator': {
    open: { settings: false, clickText: '公司管理' },
    apis: [{ name: 'board', path: '/api/boss-simulator/board' }],
    textHits: ['公司管理', '新建任务'],
  },
  'dsh-bug-perf': {
    open: null,
    apis: [{ name: 'config', path: '/api/dsh-bug-perf/config' }],
    textHits: [],
    evals: [{
      name: 'features',
      expr: "({ restartCoalesce: window.__dshBugPerf?.features?.restartCoalesce?.installed ?? null, terminalWatchdog: window.__dshBugPerf?.features?.terminalWatchdog?.installed ?? null, socketKeepAlive: window.__dshBugPerf?.features?.socketKeepAlive?.installed ?? null })",
    }],
  },
  'dsh-context-manager': {
    open: { settings: true, section: '内置插件' },
    apis: [
      { name: 'history-enabled', path: '/api/context/history-enabled' },
      { name: 'history-button-enabled', path: '/api/context/history-button-enabled' },
    ],
    counts: { '.cx-switch': null },
    textHits: ['对话增强'],
  },
  'dsh-cron-board': {
    open: { settings: false, clickText: '定时任务' },
    apis: [
      { name: 'status', path: '/api/cron-board/status' },
      { name: 'jobs', path: '/api/cron-board/jobs' },
    ],
    textHits: ['定时任务', '新建任务'],
  },
  'dsh-llm-pi-gateway': {
    open: null,
    apis: [],
    textHits: [],
    note: '上游装饰面需真实 LLM 请求,包内无只读 HTTP 面',
  },
  'dsh-maintain': {
    open: { settings: true, section: '版本与运维' },
    panelSel: '.dm-panel',
    counts: { '.dm-btn': null, 'input.dm-input': null },
    apis: [{ name: 'status', path: '/api/maintain/status' }],
    textHits: ['版本与运维', '更新内容', '重启宿主'],
  },
  'dsh-keep-working': {
    open: null,
    apis: [{ name: 'config', path: '/api/keep-working/config' }],
    counts: { 'style[data-plugin="@mzzsfy/dsh-keep-working"]': 1 },
    textHits: [],
    note: 'L3 主体为提示词注入/恢复链路,需真实模型与冷启动夹具',
  },
  'dsh-session-manager': {
    open: { settings: true, section: '会话归档' },
    panelSel: '.sm-panel',
    apis: [
      { name: 'status', path: '/api/session-manager/status' },
      { name: 'auto-archive', path: '/api/session-manager/auto-archive' },
      { name: 'deleted', path: '/api/session-manager/deleted' },
    ],
    textHits: ['自动归档', '已删除'],
    // 负例探针(400/405/404)本身是断言对象,其 4xx 资源错误不计入 console 失败
    negativeProbeUrls: ['/api/session-manager/auto-archive', '/api/session-manager/deleted', '/api/session-manager/list-slim'],
  },
  'dsh-settings-nav-icons': {
    open: { settings: true },
    counts: {
      '.VOzbGW_navLabel': null,
      'svg[data-navic]': null,
      'style[data-plugin="@mzzsfy/dsh-settings-nav-icons"]': 1,
    },
    apis: [],
    textHits: ['设置'],
  },
  'dsh-shared-terminal': {
    open: null,
    apis: [],
    textHits: ['接管输入'],
    note: 'L3 主体在终端会话内,机检只覆盖页面与样式装载',
  },
  'dsh-shell-select': {
    open: { settings: true, section: 'Shell 管理' },
    apis: [
      { name: 'config', path: '/api/shell-select/config' },
      { name: 'guard-status', path: '/api/shell-select/guard-status' },
    ],
    textHits: [],
  },
  'dsh-stock-assistant': {
    open: { settings: false, clickText: '股票' },
    apis: [{ name: 'snapshot', path: '/api/stock-assistant/snapshot' }],
    counts: { 'style[data-plugin="@mzzsfy/dsh-stock-assistant"]': 1 },
    textHits: ['股票'],
  },
  'dsh-think-expand': {
    open: null,
    apis: [],
    textHits: [],
    evals: [{
      name: 'sentinel',
      expr: "({ slot: window[Symbol.for('@mzzsfy/dsh-think-expand')] !== undefined, scroll: !!document.querySelector('[data-conversation-scroll]'), thinkRows: document.querySelectorAll('[data-variant=\"think\"]').length })",
    }],
    note: '思考行断言需含思考内容的历史会话样本',
  },
  'dsh-tool-gate': {
    open: { settings: true, section: '工具门' },
    apis: [{ name: 'state', path: '/api/tool-gate/state' }],
    textHits: ['工具门'],
  },
  'dsh-tunnel': {
    open: { settings: false, clickText: '隧道' },
    apis: [{ name: 'status', path: '/api/tunnel/status' }],
    textHits: ['隧道'],
    note: '全链路转发/WS upgrade 需真实公网域名与 cloudflared',
  },
  'dsh-turn-notify': {
    open: { settings: true, section: '消息通知' },
    panelSel: '.tn-panel',
    apis: [{ name: 'config', path: '/api/turn-notify/config' }],
    textHits: ['提醒方式', '通知规则', '音效', '外部推送'],
  },
  'dsh-usage-dash': {
    open: { settings: true, section: '使用统计' },
    panelSel: '.ud-panel',
    counts: { '.ud-card-label': 6 },
    apis: [{
      name: 'status',
      method: 'POST',
      path: '/api/usage-dash/status',
      body: {},
      expect: {
        status: 200,
        fields: {
          ok: true,
          'value.running': { type: 'boolean' },
          'value.total': { type: 'number' },
          'value.done': { type: 'number' },
          'value.skippedSessions': { type: 'number' },
          'value.recordFailures': { type: 'number' },
          'value.log': { type: 'array' },
          'value.backup': { notNull: true },
        },
      },
    }],
    textHits: ['Tokens', '会话数量', '请求数量', '最常用模型', '命中率', '活跃天数'],
    customApis: [{
      name: 'range',
      customPath: '/api/usage-dash/range',
      expr: "(async () => { const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); const res = await fetch('/api/usage-dash/range', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: d(29), to: d(0) }) }); const j = await res.json().catch(() => null); const need = ['tokens', 'sessions', 'requests', 'turns', 'cacheHit', 'cacheMiss', 'activeDays', 'topModel', 'daily', 'models', 'providers']; return { status: res.status, ok: j?.ok === true, keys: j?.value ? Object.keys(j.value) : [], missing: j?.value ? need.filter((k) => !(k in j.value)) : need } })()",
    }],
  },
  'dsh-usage-panel': {
    open: { settings: true, section: '账号余额' },
    panelSel: '.up-panel',
    apis: [
      { name: 'accounts', path: '/api/usage-panel/accounts' },
      { name: 'settings', path: '/api/usage-panel/settings' },
      { name: 'notifications', path: '/api/usage-panel/notifications' },
    ],
    textHits: ['账号余额', '添加账号', '全部刷新'],
  },
}

// 目标包编号格断言:每项 steps 的步骤名必须全局唯一(前缀 c<id>-)
export const L3_CHECKS = {
  'dsh-bug-perf': [
    {
      id: 1,
      label: 'GET config 九节在场 + 关键默认值',
      steps: [{
        name: 'c1-config',
        http: {
          path: '/api/dsh-bug-perf/config',
          expect: {
            status: 200,
            fields: {
              'config.configVersion': 2,
              'config.restartCoalesce.enabled': true,
              'config.terminalWatchdog.enabled': true,
              'config.terminalCoalesce.enabled': true,
              'config.socketKeepAlive.enabled': true,
              'config.stuckSession.enabled': true,
              'config.jobStreamLimit.enabled': true,
              'config.sessionWindow.enabled': true,
              'config.listSlim.enabled': true,
              'config.diag.enabled': false,
            },
            present: [
              'config.restartCoalesce',
              'config.terminalWatchdog',
              'config.terminalCoalesce',
              'config.socketKeepAlive',
              'config.stuckSession',
              'config.jobStreamLimit',
              'config.sessionWindow',
              'config.listSlim',
              'config.diag',
            ],
          },
        },
      }],
    },
    {
      id: '3,4',
      label: 'features.restartCoalesce/terminalWatchdog 安装态',
      steps: [{
        name: 'c3-features',
        eval: `(async () => {
  const snap = () => {
    const f = window.__dshBugPerf?.features ?? {};
    return {
      report: window.__dshBugPerf !== undefined,
      restartCoalesce: f.restartCoalesce ?? null,
      terminalWatchdog: f.terminalWatchdog ?? null,
      socketKeepAlive: f.socketKeepAlive ?? null,
      stuckSession: f.stuckSession ?? null,
      jobStreamLimit: f.jobStreamLimit ? { installed: f.jobStreamLimit.installed } : null,
      featureKeys: Object.keys(f),
    };
  };
  for (let i = 0; i < 20; i += 1) {
    const s = snap();
    if (s.restartCoalesce?.installed === true && (s.terminalWatchdog?.installed === true || s.terminalWatchdog?.reason === 'waiting for webTerminals')) return { ...s, settled: true, waitedMs: i * 250 };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ...snap(), settled: false };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c3-features')?.value
        const tw = v?.terminalWatchdog
        const ok = v?.settled === true && v?.restartCoalesce?.installed === true && v?.socketKeepAlive?.installed === true && (tw?.installed === true || tw?.reason === 'waiting for webTerminals')
        return { ok, expected: 'settled + restartCoalesce.installed + socketKeepAlive.installed + terminalWatchdog(installed|waiting)', actual: v }
      },
    },
    {
      id: 13,
      label: 'socketKeepAlive 安装态与 WebSocket 构造器替换',
      steps: [{
        name: 'c13-keepalive',
        eval: `(() => ({
  installed: window.__dshBugPerf?.features?.socketKeepAlive?.installed ?? null,
  wsName: window.WebSocket?.name ?? null,
  marker: window.WebSocket?.[Symbol.for('@mzzsfy/dsh-bug-perf/socket-keepalive')] === window.WebSocket,
}))()`,
        expect: { fields: { installed: { equals: true }, wsName: { equals: 'KeepAliveSocket' }, marker: { equals: true } } },
      }],
    },
    {
      id: 36,
      label: '插件详情卡:九节/10 开关/16 数字输入,无独立导航项',
      steps: [{
        name: 'c36-card',
        eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const navClick = (text) => {
    const all = [...document.querySelectorAll('button,[role=button],[role=menuitem],[role=tab]')];
    const hit = all.find((el) => (el.textContent || '').trim() === text || (el.getAttribute('aria-label') || '') === text);
    if (!hit) return false;
    hit.click();
    return true;
  };
  if (!document.querySelector('[data-plugin-package="@mzzsfy/dsh-bug-perf"]')) {
    navClick('插件');
    for (let i = 0; i < 20; i += 1) {
      if (document.querySelector('[data-plugin-package="@mzzsfy/dsh-bug-perf"]')) break;
      await sleep(500);
    }
  }
  const li = document.querySelector('[data-plugin-package="@mzzsfy/dsh-bug-perf"]');
  if (!li) return { ok: false, stage: 'package-card-missing' };
  const openBtn = li.querySelector('button[aria-label^="查看"]') || li.querySelector('button[aria-label]') || li.querySelector('button');
  if (!openBtn) return { ok: false, stage: 'open-button-missing' };
  openBtn.click();
  await sleep(2500);
  const detail = document.querySelector('[data-plugin-detail="@mzzsfy/dsh-bug-perf"]');
  if (!detail) return { ok: false, stage: 'detail-missing' };
  if (!detail.querySelector('.bp-section')) {
    const header = detail.querySelector('.bp-card__header');
    if (header) { header.click(); await sleep(1500); }
  }
  return {
    ok: true,
    stage: 'done',
    card: detail.querySelectorAll('.bp-card').length,
    name: detail.querySelector('.bp-card__name')?.textContent ?? null,
    sections: detail.querySelectorAll('.bp-section').length,
    switches: detail.querySelectorAll('.bp-switch input[type=checkbox]').length,
    inputs: detail.querySelectorAll('input.bp-input[type=number]').length,
    style: document.querySelectorAll('style[data-plugin="@mzzsfy/dsh-bug-perf"][data-style="settings"]').length,
    navHasTitle: [...document.querySelectorAll('[class*="navLabel"]')].some((el) => (el.textContent || '').trim() === '缺陷兜底与性能补丁'),
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c36-card')?.value
        const ok = v?.ok === true && v.card === 1 && v.name === '缺陷兜底与性能补丁' && v.sections === 9 && v.switches === 10 && v.inputs === 16 && v.style === 1 && v.navHasTitle === false
        return { ok, expected: '卡片1/名称/九节/10开关/16数值/样式1/无独立导航项', actual: v }
      },
    },
    {
      id: 40,
      label: '设置卡样式:圆角随 token/开关 34x19/无裸 hex/无 var fallback',
      steps: [{
        name: 'c40-style',
        eval: `(() => {
  const card = document.querySelector('.bp-card');
  if (card === null) return { ok: false, stage: 'card-missing' };
  const track = document.querySelector('.bp-switch__track');
  const style = document.querySelector('style[data-plugin="@mzzsfy/dsh-bug-perf"][data-style="settings"]');
  const css = style?.textContent ?? '';
  const cs = getComputedStyle(card);
  const rect = track?.getBoundingClientRect();
  return {
    ok: true,
    radius: cs.borderRadius,
    radiusToken: getComputedStyle(document.documentElement).getPropertyValue('--dsw-radius-md').trim(),
    switchSize: rect === undefined ? null : [Math.round(rect.width), Math.round(rect.height)],
    hasHex: /#[0-9a-fA-F]{3,8}\\b/.test(css),
    hasVarFallback: /var\\([^)]*,/.test(css),
    hasAlias: (css.match(/--dsw-alias-[a-z-]+/g) ?? []).length,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c40-style')?.value
        const ok = v?.ok === true && v.radius === v.radiusToken && Array.isArray(v.switchSize) && v.switchSize[0] === 34 && v.switchSize[1] === 19 && v.hasHex === false && v.hasVarFallback === false && v.hasAlias > 0
        return { ok, expected: 'radius==token + [34,19] + 无裸hex + 无var fallback + alias>0', actual: v }
      },
    },
  ],

  'dsh-usage-dash': [
    {
      id: 4,
      label: '页面文本命中六项卡标题',
      steps: [{
        name: 'c4-text',
        assert: { selector: 'body', text: ['Tokens', '会话数量', '请求数量', '最常用模型', '命中率', '活跃天数'] },
      }],
    },
    {
      id: 5,
      label: '六卡数量与逐字标签(空数据占位)',
      steps: [
        { name: 'c5-labels', assert: { selector: '.ud-card-label', exactTexts: ['Tokens 用量', '会话数量', '请求数量', '最常用模型', '平均缓存命中率', '活跃天数'] } },
        { name: 'c5-cards', assert: { selector: '.ud-card', count: 6 } },
        { name: 'c5-values', assert: { selector: '.ud-card-value', minCount: 5 } },
      ],
    },
    {
      id: 6,
      label: 'POST range 200 + 12 字段在场',
      steps: [{
        name: 'c6-range',
        eval: `(async () => {
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const res = await fetch('/api/usage-dash/range', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: d(29), to: d(0) }) });
  const j = await res.json().catch(() => null);
  const need = ['tokens', 'sessions', 'requests', 'turns', 'cacheHit', 'cacheMiss', 'activeDays', 'topModel', 'daily', 'models', 'providers'];
  return { status: res.status, ok: j?.ok === true, missing: j?.value ? need.filter((k) => !(k in j.value)) : need };
})()`,
        expect: { fields: { status: { equals: 200 }, ok: { equals: true }, missing: { equals: [] } } },
      }],
    },
    {
      id: 7,
      label: 'POST status 200 + 8 字段形态',
      steps: [{
        name: 'c7-status',
        http: {
          path: '/api/usage-dash/status',
          method: 'POST',
          body: {},
          expect: {
            status: 200,
            fields: {
              ok: true,
              'value.running': { type: 'boolean' },
              'value.total': { type: 'number' },
              'value.done': { type: 'number' },
              'value.skippedSessions': { type: 'number' },
              'value.recordFailures': { type: 'number' },
              'value.log': { type: 'array' },
              'value.backup': { notNull: true },
            },
          },
        },
      }],
    },
    {
      id: 11,
      label: '空数据:无错误块 + 空态文案 + 六卡占位',
      steps: [
        { name: 'c11-error', assert: { selector: '.ud-error', count: 0 } },
        { name: 'c11-empty', assert: { selector: '.ud-empty', minCount: 1, text: '当前时间范围内暂无用量数据' } },
        {
          name: 'c11-values',
          eval: `(() => [...document.querySelectorAll('.ud-card')].map((c) => (c.querySelector('.ud-card-value') ?? c.querySelector('.ud-card-name'))?.textContent ?? null))()`,
          expect: { type: 'array' },
        },
      ],
      judge: (byName) => {
        const v = byName.get('c11-values')?.value
        const ok = Array.isArray(v) && v.length === 6 && v.every((x) => typeof x === 'string' && x.length > 0)
        return { ok, expected: '六卡值节点均为非空字符串(空环境为 0/—;本次宿主已产生用量)', actual: v }
      },
    },
    {
      id: 17,
      label: '扫描异常日志折叠:重建/回退 disabled 与 title,无日志不渲染',
      steps: [{
        name: 'c17-fold',
        eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = document.querySelector('.ud-status-fold');
  if (!btn) return { ok: false, stage: 'fold-missing' };
  if (btn.getAttribute('aria-expanded') !== 'true') { btn.click(); await sleep(600); }
  const buttons = [...document.querySelectorAll('.ud-detail-foot button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, title: b.getAttribute('title') }));
  return { ok: true, detail: document.querySelectorAll('.ud-detail').length, buttons, log: document.querySelectorAll('.ud-log').length };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c17-fold')?.value
        const back = v?.buttons?.find((b) => b.text.includes('回退'))
        const ok = v?.ok === true && v.detail === 1 && Array.isArray(v.buttons) && v.buttons.length === 2 && v.buttons[0].text === '重建' && back?.disabled === true && back?.title === '无可用回退点(重建时自动生成)' && v.log === 0
        return { ok, expected: 'detail=1 + [重建,回退数据(disabled+固定title)] + 无 .ud-log', actual: v }
      },
    },
    {
      id: 18,
      label: '重建按钮两段式确认 + 3s 自动解除 + 折叠',
      steps: [
        {
          name: 'c18-arm',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('.ud-detail-foot button')].find((b) => b.textContent.trim() === '重建');
  if (!btn || btn.disabled) return { ok: false, stage: 'rebuild-missing-or-disabled' };
  btn.click();
  await sleep(400);
  return { ok: true, text: btn.textContent.trim() };
})()`,
        },
        { name: 'c18-wait', wait: 3200 },
        {
          name: 'c18-after',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const buttons = [...document.querySelectorAll('.ud-detail-foot button')].map((b) => b.textContent.trim());
  const fold = document.querySelector('.ud-status-fold');
  if (fold && fold.getAttribute('aria-expanded') === 'true') { fold.click(); await sleep(500); }
  return { ok: true, buttons, afterTexts: [...document.querySelectorAll('.ud-detail-foot button')].map((b) => b.textContent.trim()), detail: document.querySelectorAll('.ud-detail').length };
})()`,
        },
      ],
      judge: (byName) => {
        const arm = byName.get('c18-arm')?.value
        const after = byName.get('c18-after')?.value
        const ok = arm?.ok === true && arm.text === '确认重建' && Array.isArray(after?.afterTexts) && !after.afterTexts.includes('确认重建') && after.detail === 0
        return { ok, expected: '首点变「确认重建」→ 3s 后解除 → 折叠后 detail=0', actual: { arm, after } }
      },
    },
    {
      id: 19,
      label: '四张成本卡标题/顺序/折叠/摘要 + 首装全关',
      steps: [{
        name: 'c19-folds',
        eval: `(() => {
  const folds = [...document.querySelectorAll('.ud-panel .ud-fold')].map((f) => ({
    title: f.querySelector('.ud-fold-title')?.textContent ?? null,
    expanded: f.querySelector('.ud-fold-head')?.getAttribute('aria-expanded') ?? null,
    summary: f.querySelector('.ud-fold-summary')?.textContent ?? '',
  }));
  return {
    titles: folds.map((f) => f.title),
    collapsed: folds.slice(2).map((f) => f.expanded),
    summaries: folds.slice(2).map((f) => f.summary),
    guardOff: (document.querySelector('.ud-guard-status-item')?.textContent ?? '').includes('未启用,不拦截请求'),
    sentinelOff: (document.querySelector('.ud-sentinel-note')?.textContent ?? '').includes('异常哨兵已关闭'),
    guardItems: document.querySelectorAll('.ud-guard-status-item').length,
    whatif: document.querySelectorAll('.ud-whatif').length,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c19-folds')?.value
        const expectTitles = ['显示与增强', '定价规则', '用量摘要', '成本护栏', '异常哨兵', '省钱沙盘']
        const ok = JSON.stringify(v?.titles) === JSON.stringify(expectTitles) && Array.isArray(v?.collapsed) && v.collapsed.every((x) => x === 'false') && v.guardOff === true && v.sentinelOff === true && v.guardItems === 1 && v.whatif === 0
        return { ok, expected: '六折顺序正确 + 四折收起 + 护栏/哨兵关闭态 + 无限额仅一条 + 沙盘未启用', actual: v }
      },
    },
  ],

  'dsh-maintain': [
    {
      id: 4,
      label: '面板 dm- 元素计数 >= 50',
      steps: [
        { name: 'c4-wait', wait: 2500 },
        { name: 'c4-count', assert: { selector: '[class*="dm-"]', minCount: 50 } },
      ],
    },
    {
      id: 5,
      label: '默认态控件盘点(按钮/危险按钮/输入/链接/下拉)',
      steps: [{
        name: 'c5-controls',
        eval: `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const texts = [...document.querySelectorAll('.dm-btn')].map((b) => b.textContent.trim());
  return {
    btn: texts.length,
    texts,
    danger: q('.dm-btn--danger'),
    inputs: q('input.dm-input'),
    selects: q('select.dm-select'),
    links: q('a.dm-link'),
    href: document.querySelector('a.dm-link')?.getAttribute('href') ?? null,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c5-controls')?.value
        const need = ['更新内容', '刷新', '安装', '保存', '重启宿主']
        const ok = v?.btn >= 6 && need.every((t) => v.texts.includes(t)) && v.danger === 1 && v.inputs === 2 && v.links === 1 && (v.selects === 0 || v.selects === 1)
        return { ok, expected: 'btn>=6 含 更新内容/刷新/安装/保存/重启宿主 + danger=1 + inputs=2 + links=1 + selects∈{0,1}', actual: v }
      },
    },
    {
      id: 6,
      label: '当前版本行「运行 X / 已装 Y」',
      steps: [{
        name: 'c6-version',
        eval: `(async () => {
  for (let i = 0; i < 30; i += 1) {
    if (document.querySelector('.dm-head__title')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const row = [...document.querySelectorAll('.dm-field')].find((f) => f.querySelector('.dm-field__label')?.textContent === '当前版本');
  const text = row?.querySelector('.dm-field__control')?.textContent ?? '';
  return { found: row !== undefined, text, ok: /运行 .+ \\/ 已装 /.test(text), parts: (text.match(/^运行 (\\S+) \\/ 已装 (\\S+)/) ?? []).slice(1) };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c6-version')?.value
        const ok = v?.found === true && v.ok === true && Array.isArray(v.parts) && v.parts.length === 2
        return { ok, expected: '运行 <版本|未知> / 已装 <版本|未知>', actual: v }
      },
    },
    {
      id: 7,
      label: '版本徽章三态文案与语义类',
      steps: [{
        name: 'c7-badge',
        eval: `(() => {
  const row = [...document.querySelectorAll('.dm-field')].find((f) => f.querySelector('.dm-field__label')?.textContent === '当前版本');
  const b = row?.querySelector('.dm-badge');
  return b ? { text: b.textContent, cls: b.className } : { text: null, cls: null };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c7-badge')?.value
        const text = v?.text ?? ''
        const ok = /^(有新版本 .+|已是最新|未知:.+)$/.test(text) && (text.startsWith('有新版本') ? v.cls.includes('dm-badge--new') : text === '已是最新' ? v.cls.includes('dm-badge--ok') : true)
        return { ok, expected: '有新版本 X | 已是最新 | 未知:<原因> 且语义类匹配', actual: v }
      },
    },
    {
      id: 8,
      label: '追踪通道 select 或「通道表未就绪」兜底',
      steps: [{
        name: 'c8-channel',
        eval: `(async () => {
  const st = await (await fetch('/api/maintain/status')).json();
  const tags = st?.tags ?? null;
  const row = [...document.querySelectorAll('.dm-field')].find((f) => f.querySelector('.dm-field__label')?.textContent === '追踪通道');
  const sel = row?.querySelector('select.dm-select') ?? null;
  const options = sel ? [...sel.options].map((o) => o.textContent) : null;
  const meta = row ? [...row.querySelectorAll('.dm-meta')].map((e) => e.textContent) : [];
  return { tagsNull: tags === null, select: sel !== null, value: sel?.value ?? null, options, meta, channel: st?.channel ?? null };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c8-channel')?.value
        const okSelect = v?.select === true && Array.isArray(v.options) && v.options.length >= 1 && v.options.some((o) => o.includes('latest')) && v.value === v.channel
        const okFallback = v?.select === false && Array.isArray(v.meta) && v.meta.some((m) => m.includes('latest(通道表未就绪)'))
        return { ok: v?.tagsNull ? okFallback : okSelect, expected: v?.tagsNull ? 'select 缺失 + latest(通道表未就绪)' : 'select 在场 + 含 latest + value==channel', actual: v }
      },
    },
    {
      id: 9,
      label: '「上次检查」meta 与错误 note 并存关系',
      steps: [{
        name: 'c9-checked',
        eval: `(async () => {
  const st = await (await fetch('/api/maintain/status')).json();
  const meta = [...document.querySelectorAll('.dm-meta')].map((e) => e.textContent).filter((t) => t.startsWith('上次检查'));
  const err = document.querySelector('.dm-note.dm-note--error');
  return { meta, err: err?.textContent ?? null, checkError: st?.checkError ?? null, checkedAt: st?.checkedAt ?? null };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c9-checked')?.value
        const hasMeta = v?.meta?.length === 1 && /^上次检查 \d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(v.meta[0])
        const needErr = typeof v?.checkError === 'string' && v.checkError.length > 0
        const ok = hasMeta && (needErr ? typeof v.err === 'string' && v.err.length > 0 : true)
        return { ok, expected: '「上次检查 M/D HH:MM」必在;checkError 非空时错误 note 必在', actual: v }
      },
    },
    {
      id: 10,
      label: 'npm 版本页链接 href/target/text',
      steps: [{
        name: 'c10-link',
        assert: {
          selector: 'a.dm-link',
          count: 1,
          attr: { name: 'href', equals: 'https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions' },
          text: 'npm 版本页',
        },
      }],
    },
    {
      id: 11,
      label: '设置卡位于重启卡之后 + 两个保存按钮 + 无升级命令',
      steps: [{
        name: 'c11-order',
        eval: `(() => {
  const cards = [...document.querySelectorAll('.dm-card')];
  const titles = cards.map((c) => c.querySelector('.dm-card__title')?.textContent ?? null);
  return {
    titles,
    setAfterRestart: titles.indexOf('设置') > titles.indexOf('重启') && titles.includes('设置'),
    save: [...document.querySelectorAll('.dm-btn')].filter((b) => b.textContent.trim() === '保存').length,
    legacy: (document.querySelector('.dm-panel')?.innerText ?? '').includes('升级命令'),
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c11-order')?.value
        const ok = v?.setAfterRestart === true && v.save === 2 && v.legacy === false
        return { ok, expected: '设置卡在重启卡之后 + 保存按钮 2 + 无「升级命令」', actual: v }
      },
    },
    {
      id: 12,
      label: '两处 placeholder + 单位 + 白名单可编辑',
      steps: [{
        name: 'c12-fields',
        eval: `(() => {
  const rows = [...document.querySelectorAll('.dm-field')].map((f) => ({
    label: f.querySelector('.dm-field__label')?.textContent ?? null,
    ph: f.querySelector('input.dm-input')?.placeholder ?? null,
    unit: f.querySelector('.dm-unit')?.textContent ?? null,
    hint: [...f.querySelectorAll('.dm-field__hint')].map((h) => h.textContent).join('|'),
    boxes: f.querySelectorAll('.dm-whitelist__item input').length,
  }));
  return rows.filter((r) => ['轮询间隔', '镜像地址', '安全模式白名单'].includes(r.label));
})()`,
      }],
      judge: (byName) => {
        const rows = byName.get('c12-fields')?.value ?? []
        const interval = rows.find((r) => r.label === '轮询间隔')
        const mirror = rows.find((r) => r.label === '镜像地址')
        const white = rows.find((r) => r.label === '安全模式白名单')
        const ok = interval?.ph === '21600' && interval.unit === '秒' && interval.hint.includes('0 表示仅手动检查') && interval.hint.includes('最小生效粒度 60 秒') && mirror?.ph === 'https://registry.npmjs.org' && white?.boxes >= 1 && white.hint.includes('不能绕过插件兼容检查')
        return { ok, expected: '轮询间隔 21600/秒/两条 hint + 镜像 registry + 白名单 >=1 且 hint', actual: rows }
      },
    },
    {
      id: 13,
      label: '重启卡三要素(标题/按钮/说明)',
      steps: [{
        name: 'c13-restart',
        eval: `(() => {
  const card = [...document.querySelectorAll('.dm-card')].find((c) => c.querySelector('.dm-card__title')?.textContent === '重启');
  const b = card?.querySelector('.dm-btn--danger');
  return {
    title: card?.querySelector('.dm-card__title')?.textContent ?? null,
    text: b?.textContent.trim() ?? null,
    disabled: b?.disabled ?? null,
    body: card?.innerText ?? '',
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c13-restart')?.value
        const ok = v?.title === '重启' && ['重启宿主', '确认重启'].includes(v.text) && v.disabled === false && v.body.includes('进程管理器') && v.body.includes('退出码 75') && v.body.includes('自动继续')
        return { ok, expected: '标题「重启」+ 重启宿主按钮可用 + 说明含 进程管理器/退出码 75/自动继续', actual: v }
      },
    },
    {
      id: 14,
      label: '全页含 刷新/安装/重启宿主 且无「暂不可用/尚未实现」',
      steps: [{
        name: 'c14-text',
        assert: { selector: '.dm-panel', text: ['刷新', '安装', '重启宿主'], textNot: ['暂不可用', '尚未实现'] },
      }],
    },
    {
      id: 15,
      label: '安装按钮可用性与 title 与 channelLatest 联动',
      steps: [{
        name: 'c15-install',
        eval: `(async () => {
  const st = await (await fetch('/api/maintain/status')).json();
  const b = [...document.querySelectorAll('.dm-btn')].find((x) => ['安装', '安装中…'].includes(x.textContent.trim()));
  return {
    text: b?.textContent.trim() ?? null,
    disabled: b?.disabled ?? null,
    title: b?.getAttribute('title') ?? null,
    channelLatest: st?.channelLatest ?? null,
    channelLatestValid: st?.channelLatestValid ?? null,
    running: st?.upgrade?.running ?? null,
    restarting: st?.restarting ?? null,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c15-install')?.value
        let ok = false
        let expected = ''
        if (v?.running === true || v?.restarting === true) {
          expected = 'running/restarting 时 disabled'
          ok = v.disabled === true
        } else if (!v?.channelLatest) {
          expected = 'channelLatest 空 → disabled + title 通道最新版未知'
          ok = v.disabled === true && v.title === '通道最新版未知,请先检查更新'
        } else if (v?.channelLatestValid === false) {
          expected = 'channelLatest 非法 → disabled + title 不是合法版本'
          ok = v.disabled === true && v.title === '通道最新版不是合法版本,请先检查更新'
        } else {
          expected = 'channelLatest 就绪 → enabled + 无 title'
          ok = v.disabled === false && v.title === null
        }
        return { ok, expected, actual: v }
      },
    },
    {
      id: 17,
      label: '更新内容按钮形态与通道表就绪联动',
      steps: [{
        name: 'c17-notes',
        eval: `(async () => {
  const b = [...document.querySelectorAll('.dm-btn')].find((x) => x.textContent.trim() === '更新内容');
  const sel = document.querySelector('select.dm-select');
  return {
    present: b !== undefined,
    disabled: b?.disabled ?? null,
    title: b?.getAttribute('title') ?? null,
    hasSelect: sel !== null,
    fallback: (document.querySelector('.dm-panel')?.innerText ?? '').includes('(通道表未就绪)'),
    annotated: sel ? [...sel.options].some((o) => o.textContent.includes('不在通道表中')) : false,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c17-notes')?.value
        const ready = v?.hasSelect === true && v.fallback === false
        const ok = v?.present === true && typeof v.title === 'string' && v.title.startsWith('查看 ') && (ready ? v.disabled === false : v.disabled === true)
        return { ok, expected: '按钮在场 + title「查看 <版本> 的更新内容」;通道就绪可点/未就绪禁用', actual: v }
      },
    },
  ],

  'dsh-session-manager': [
    {
      id: 2,
      label: '会话树 treeitem 数量 > 0',
      steps: [{ name: 'c2-tree', eval: `(() => ({ treeitem: document.querySelectorAll('[role="treeitem"]').length, tree: document.querySelectorAll('[role="tree"]').length }))()` }],
      judge: (byName) => {
        const v = byName.get('c2-tree')?.value
        return { ok: v?.treeitem > 0, expected: 'treeitem > 0', actual: v }
      },
    },
    {
      id: 3,
      label: '样式元素 data-plugin 恰 1',
      steps: [{ name: 'c3-style', assert: { selector: 'style[data-plugin="@mzzsfy/dsh-session-manager"]', count: 1 } }],
    },
    {
      id: 4,
      label: '归档面板骨架/字体/空态/无搜索与计数行',
      steps: [{
        name: 'c4-panel',
        eval: `(() => {
  const panel = document.querySelector('.sm-panel');
  if (!panel) return { panel: false };
  const title = document.querySelector('.sm-title');
  const desc = document.querySelector('.sm-desc');
  return {
    panel: true,
    title: title?.textContent ?? null,
    titleFont: title ? getComputedStyle(title).fontSize + '/' + getComputedStyle(title).fontWeight : null,
    desc: desc?.textContent ?? null,
    descFont: desc ? getComputedStyle(desc).fontSize : null,
    search: document.querySelectorAll('.sm-search').length,
    meta: document.querySelectorAll('.sm-meta').length,
    rows: document.querySelectorAll('.sm-row--archive').length,
    emptyText: document.querySelector('.sm-empty')?.firstElementChild?.textContent?.trim() ?? null,
    emptyHint: document.querySelector('.sm-empty__hint')?.textContent ?? null,
    deleted: document.querySelectorAll('.sm-deleted').length,
    cfg: document.querySelectorAll('.sm-cfg').length,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c4-panel')?.value
        const ok = v?.panel === true && v.title === '会话归档' && v.titleFont === '18px/600' && v.desc === '恢复放回会话列表;删除移入系统回收站(无回收站环境移入插件回收区),可经「已删除」区找回。' && v.descFont === '13px' && v.search === 0 && v.meta === 0 && ((v.emptyText === '还没有归档的会话' && v.emptyHint === '会话归档后集中显示在这里') || (v.emptyText === '归档状态读取中…' && v.emptyHint === '等待宿主归档快照就绪')) && v.deleted === 0 && v.cfg === 1
        return { ok, expected: '面板/标题 18px600/说明 13px/空态成对/无搜索与计数行/已删除不渲染/配置行在场', actual: v }
      },
    },
    {
      id: 5,
      label: 'GET auto-archive 默认 7 天 / 24 小时',
      steps: [{
        name: 'c5-auto',
        http: {
          path: '/api/session-manager/auto-archive',
          expect: { status: 200, fields: { days: { equals: 7 }, intervalHours: { equals: 24 } } },
        },
      }],
    },
    {
      id: 6,
      label: '自动归档配置行:两数字输入/尾注/title',
      steps: [{
        name: 'c6-cfg',
        eval: `(() => {
  const cfg = document.querySelector('.sm-cfg');
  if (!cfg) return { cfg: false };
  const inputs = [...cfg.querySelectorAll('input')];
  const labels = [...cfg.querySelectorAll('label')];
  return {
    cfg: true,
    inputCount: inputs.length,
    signatures: inputs.map((i) => i.type + ':' + i.min + ':' + i.step),
    values: inputs.map((i) => i.value),
    labelTexts: labels.map((l) => l.innerText.replace(/\\s+/g, ' ').trim()),
    labelTitles: labels.map((l) => l.title),
    overviewTitle: cfg.querySelector('span[title]')?.title ?? null,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c6-cfg')?.value
        const ok = v?.cfg === true && v.inputCount === 2 && JSON.stringify(v.signatures) === JSON.stringify(['number:0:1', 'number:0:1']) && v.labelTexts[0]?.includes('阈值') && v.labelTexts[0]?.includes('天未活跃(0 关闭)') && v.labelTexts[1]?.includes('检查周期') && v.labelTexts[1]?.includes('小时(0 关闭)') && v.labelTitles[0]?.includes('会话超过该天数未活跃') && v.labelTitles[1]?.includes('周期检查的间隔小时数') && v.overviewTitle?.includes('超过阈值天数未活跃')
        return { ok, expected: '两个 number:0:1 输入 + 阈值/检查周期文案 + 三条 title', actual: v }
      },
    },
    {
      id: 7,
      label: '阈值清空失焦:toast + 回滚 + 零 POST',
      steps: [
        {
          name: 'c7-hook',
          eval: `(() => {
  window.__smProbe = { posts: [], toasts: [] };
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : String((input && input.url) || '');
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (url.indexOf('/api/session-manager/') >= 0 && method !== 'GET') window.__smProbe.posts.push(method + ' ' + url);
    return orig.apply(this, arguments);
  };
  setInterval(() => {
    document.querySelectorAll('.dsh-toast__text').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && window.__smProbe.toasts.indexOf(t) < 0) window.__smProbe.toasts.push(t);
    });
  }, 100);
  return true;
})()`,
        },
        {
          name: 'c7-clear',
          eval: `(() => {
  const input = document.querySelectorAll('.sm-cfg__field input')[0];
  if (!input) return { ok: false, reason: 'no-cfg-input' };
  const before = input.value;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  input.focus();
  setValue.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const shown = input.value;
  input.blur();
  return { ok: true, before, shown };
})()`,
        },
        { name: 'c7-wait', wait: 800 },
        {
          name: 'c7-read',
          eval: `(() => ({
  posts: window.__smProbe?.posts ?? [],
  toasts: window.__smProbe?.toasts ?? [],
  values: [...document.querySelectorAll('.sm-cfg__field input')].map((i) => i.value),
}))()`,
        },
      ],
      judge: (byName) => {
        const clear = byName.get('c7-clear')?.value
        const read = byName.get('c7-read')?.value
        const ok = clear?.ok === true && clear.shown === '' && read?.posts?.length === 0 && read.toasts.includes('自动归档配置须为非负整数') && read.values[0] === clear.before
        return { ok, expected: '清空后失焦:零写请求 + toast「自动归档配置须为非负整数」+ 值回滚到已提交值', actual: { clear, read } }
      },
    },
    {
      id: 8,
      label: 'POST auto-archive {} → 400 且配置不变',
      steps: [
        {
          name: 'c8-post',
          http: {
            path: '/api/session-manager/auto-archive',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            expect: { status: 400, fields: { error: { equals: '缺少可更新的配置字段' } } },
          },
        },
        {
          name: 'c8-get',
          http: {
            path: '/api/session-manager/auto-archive',
            expect: { status: 200, fields: { days: { equals: 7 }, intervalHours: { equals: 24 } } },
          },
        },
      ],
    },
    {
      id: 9,
      label: 'status.periodic.running 与降级提示联动',
      steps: [
        {
          name: 'c9-status',
          http: { path: '/api/session-manager/status', expect: { status: 200, fields: { 'periodic.running': { type: 'boolean' } } } },
        },
        {
          name: 'c9-hint',
          eval: `(() => ({ hint: (document.querySelector('.sm-toolbar')?.innerText ?? '').includes('周期评估未运行') }))()`,
        },
      ],
      judge: (byName) => {
        const running = byName.get('c9-status')?.value?.body?.periodic?.running
        const hint = byName.get('c9-hint')?.value?.hint
        return { ok: hint === (running === false), expected: 'hint === (running === false)', actual: { running, hint } }
      },
    },
    {
      id: 10,
      label: 'deleted:GET 空台账 / POST 405 / 缺 content-type 400',
      steps: [
        { name: 'c10-get', http: { path: '/api/session-manager/deleted', expect: { status: 200, fields: { deleted: { type: 'array', length: 0 } } } } },
        { name: 'c10-405', http: { path: '/api/session-manager/deleted', method: 'POST', headers: { 'content-type': 'application/json' }, expect: { status: 405, fields: { error: { equals: 'method not allowed' } } } } },
        { name: 'c10-400', http: { path: '/api/session-manager/deleted', method: 'POST', expect: { status: 400, fields: { error: { equals: 'content-type 须为 application/json' } } } } },
      ],
    },
    {
      id: 11,
      label: '空台账时「已删除」区不渲染',
      steps: [
        { name: 'c11-deleted', assert: { selector: '.sm-deleted', count: 0 } },
        { name: 'c11-title', assert: { selector: '.sm-deleted .sm-card__title', count: 0 } },
      ],
    },
    {
      id: 17,
      label: '已移除的 list-slim 端点返回 404',
      steps: [{ name: 'c17-404', http: { path: '/api/session-manager/list-slim', expect: { status: 404 } } }],
    },
  ],

  'dsh-settings-nav-icons': [
    {
      id: 2,
      label: 'navLabel 与 navCell 计数一致且 >0',
      steps: [{
        name: 'c2-labels',
        eval: `(async () => {
  const waitStable = async () => {
    let last = -2;
    for (let i = 0; i < 40; i += 1) {
      const n = document.querySelectorAll('svg[data-navic]').length;
      if (n === last && n > 0) return n;
      last = n;
      await new Promise((r) => setTimeout(r, 300));
    }
    return last;
  };
  window.__l3WaitStable = waitStable;
  await waitStable();
  const hashLabels = document.querySelectorAll('.VOzbGW_navLabel').length;
  const hashCells = document.querySelectorAll('button.VOzbGW_navCell').length;
  const suffixCells = document.querySelectorAll('button[class*="_navCell"]').length;
  return { hashLabels, hashCells, suffixCells, equal: hashLabels === hashCells && hashCells === suffixCells, drift: suffixCells > 0 && hashCells === 0 };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c2-labels')?.value
        return { ok: v?.hashLabels === v?.suffixCells && v?.suffixCells > 0, expected: 'navLabel === navCell > 0', actual: v }
      },
    },
    {
      id: 3,
      label: 'svg[data-navic] 数 === 记账单元格数,无残留齿轮',
      steps: [
        { name: 'c3-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c3-taken',
        eval: `(() => {
  const GEAR_PATHS = ['M14.0861', 'M13.0107 7.79377'];
  const gearish = (svg) => {
    if (svg === null) return false;
    if (svg.querySelector('use[href^="#dsw-icon-settings-outline"]') !== null) return true;
    return [...svg.querySelectorAll('path')].some((p) => GEAR_PATHS.some((x) => (p.getAttribute('d') ?? '').startsWith(x)));
  };
  const cells = [...document.querySelectorAll('button[class*="_navCell"]')];
  const primary = (cell) => cell.querySelector('svg');
  const taken = cells.filter((c) => (primary(c)?.dataset.navic ?? '') !== '');
  const residual = cells.filter((c) => {
    const svg = primary(c);
    return svg !== null && (svg.dataset.navic ?? '') === '' && gearish(svg);
  }).map((c) => (c.querySelector('.VOzbGW_navLabel') ?? c.querySelector('span[class*="_navLabel"]'))?.textContent?.trim() ?? null);
  return {
    labels: document.querySelectorAll('.VOzbGW_navLabel').length,
    suffixCells: cells.length,
    navicSvgs: document.querySelectorAll('svg[data-navic]').length,
    takenCells: taken.length,
    residualGear: residual.length,
    residual,
    inert1: document.querySelectorAll('[data-navic="1"]').length,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c3-taken')?.value
        const ok = v?.takenCells > 0 && v.navicSvgs === v.takenCells && v.residualGear === 0
        return { ok, expected: 'navicSvgs === takenCells > 0 且 residualGear=0(无未接管齿轮格)', actual: v }
      },
    },
    {
      id: 4,
      label: 'navCell 三向计数相等(防哈希漂移)',
      steps: [{
        name: 'c4-drift',
        eval: `(async () => {
  const waitStable = async () => {
    let last = -2;
    for (let i = 0; i < 40; i += 1) {
      const n = document.querySelectorAll('svg[data-navic]').length;
      if (n === last && n > 0) return n;
      last = n;
      await new Promise((r) => setTimeout(r, 300));
    }
    return last;
  };
  window.__l3WaitStable = waitStable;
  await waitStable();
  const hashLabels = document.querySelectorAll('.VOzbGW_navLabel').length;
  const hashCells = document.querySelectorAll('button.VOzbGW_navCell').length;
  const suffixCells = document.querySelectorAll('button[class*="_navCell"]').length;
  return { hashLabels, hashCells, suffixCells, equal: hashLabels === hashCells && hashCells === suffixCells, drift: suffixCells > 0 && hashCells === 0 };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c4-drift')?.value
        return { ok: v?.equal === true && v.drift === false && v.suffixCells > 0, expected: 'hashLabels === hashCells === suffixCells', actual: v }
      },
    },
    {
      id: 5,
      label: 'svg[data-navic] 与所在格 label 逐项一致',
      steps: [
        { name: 'c5-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c5-pairs',
        eval: `(() => [...document.querySelectorAll('svg[data-navic]')].map((el) => {
  const cell = el.closest('button.VOzbGW_navCell') ?? el.closest('button[class*="_navCell"]');
  const labelEl = cell === null ? null : (cell.querySelector('.VOzbGW_navLabel') ?? cell.querySelector('span[class*="_navLabel"]'));
  const label = labelEl === null ? null : labelEl.textContent.trim();
  return { navic: el.dataset.navic, label, ok: label !== null && label !== '' && el.dataset.navic === label };
}))()`,
      }],
      judge: (byName) => {
        const v = byName.get('c5-pairs')?.value
        const ok = Array.isArray(v) && v.length > 0 && v.every((x) => x.ok === true)
        return { ok, expected: '每枚 svg[data-navic] 的 dataset.navic === 所在格 label', actual: v }
      },
    },
    {
      id: 6,
      label: '已接管 svg 无 <use>/齿轮路径残留且 innerHTML 非空',
      steps: [
        { name: 'c6-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c6-inner',
        eval: `(() => [...document.querySelectorAll('svg[data-navic]')].map((el) => ({
  navic: el.dataset.navic,
  htmlLen: el.innerHTML.length,
  useAll: el.querySelectorAll('use').length,
  gearUse: el.querySelectorAll('use[href^="#dsw-icon-settings-outline"]').length,
  gearPath: [...el.querySelectorAll('path')].filter((p) => ['M14.0861', 'M13.0107 7.79377'].some((x) => (p.getAttribute('d') ?? '').startsWith(x))).length,
})))()`,
      }],
      judge: (byName) => {
        const v = byName.get('c6-inner')?.value
        const ok = Array.isArray(v) && v.length > 0 && v.every((x) => x.htmlLen > 0 && x.useAll === 0 && x.gearUse === 0 && x.gearPath === 0)
        return { ok, expected: '每枚已接管 svg:innerHTML>0 且无 use/齿轮 path', actual: v }
      },
    },
    {
      id: 7,
      label: '[data-navic="1"] 计数为 0 且每枚记账 svg 居格首',
      steps: [
        { name: 'c7-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c7-primary',
        eval: `(() => {
  const bad = [...document.querySelectorAll('svg[data-navic]')].filter((el) => {
    const cell = el.closest('button.VOzbGW_navCell') ?? el.closest('button[class*="_navCell"]');
    return cell === null ? true : cell.querySelectorAll('svg')[0] !== el;
  }).map((el) => el.dataset.navic);
  return { inert1: document.querySelectorAll('[data-navic="1"]').length, notPrimary: bad, total: document.querySelectorAll('svg[data-navic]').length };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c7-primary')?.value
        const ok = v?.inert1 === 0 && Array.isArray(v.notPrimary) && v.notPrimary.length === 0 && v.total > 0
        return { ok, expected: 'inert1=0 + notPrimary=[]', actual: v }
      },
    },
    {
      id: 9,
      label: '样式文本逐字等于滚动常量',
      steps: [{
        name: 'c9-css',
        eval: `(() => {
  const nodes = [...document.querySelectorAll('style[data-plugin="@mzzsfy/dsh-settings-nav-icons"]')];
  const CSS = '@media (min-width:768px){.VOzbGW_navList{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin}}';
  return { count: nodes.length, exact: nodes.length === 1 && nodes[0].textContent === CSS, text: nodes[0]?.textContent ?? null };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c9-css')?.value
        return { ok: v?.exact === true, expected: 'style.textContent 逐字等于常量', actual: v }
      },
    },
    {
      id: 10,
      label: 'navList 滚动容器计算样式(overflowY/flex/scrollbar)',
      steps: [{
        name: 'c10-css',
        eval: `(() => {
  const el = document.querySelector('.VOzbGW_navList') ?? document.querySelector('div[class*="navList"]') ?? document.querySelector('[class*="navList"]');
  if (el === null) return { found: false };
  const cs = getComputedStyle(el);
  return { found: true, overflowY: cs.overflowY, flexGrow: cs.flexGrow, flexBasis: cs.flexBasis, scrollbarWidth: cs.scrollbarWidth, wide: matchMedia('(min-width:768px)').matches };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c10-css')?.value
        const ok = v?.found === true && v.overflowY === 'auto' && v.flexGrow === '1' && v.scrollbarWidth === 'thin' && v.wide === true
        return { ok, expected: 'overflowY=auto + flexGrow=1 + scrollbarWidth=thin + 宽视口', actual: v }
      },
    },
    {
      id: 11,
      label: '__navicIcons.register 为函数,队列被替换为直通桩',
      steps: [
        { name: 'c11-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c11-api',
        eval: `(() => ({
  api: typeof window.__navicIcons?.register,
  queueIsArray: Array.isArray(window.__navicIconQueue),
  queuePush: typeof window.__navicIconQueue?.push,
  declaredKeys: Object.keys(window.__navicIconDeclarations ?? {}),
}))()`,
      }],
      judge: (byName) => {
        const v = byName.get('c11-api')?.value
        const ok = v?.api === 'function' && v?.queueIsArray === false && v?.queuePush === 'function'
        return { ok, expected: 'register=function + queue 非数组 + push=function', actual: v }
      },
    },
    {
      id: 14,
      label: '注册不存在键不改变任何已记账图标',
      steps: [
        { name: 'c14-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c14-unknown',
        eval: `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const snap = () => [...document.querySelectorAll('svg[data-navic]')].map((el) => el.dataset.navic + '=' + el.innerHTML);
  const before = snap();
  window.__navicIcons.register({ '不存在的分区Z': 'bell' });
  await frame();
  const after = snap();
  return {
    same: before.length === after.length && before.every((v, i) => v === after[i]),
    count: before.length,
    noCellForNewKey: document.querySelectorAll('svg[data-navic="不存在的分区Z"]').length === 0,
    declHasKey: Object.prototype.hasOwnProperty.call(window.__navicIconDeclarations ?? {}, '不存在的分区Z'),
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c14-unknown')?.value
        const ok = v?.same === true && v?.count > 0 && v.noCellForNewKey === true && v.declHasKey === true
        return { ok, expected: '已记账图标全部不变 + 无新格 + 声明仍记录', actual: v }
      },
    },
    {
      id: 12,
      label: 'register 改写图标/记账保留/别名等价组(动态取首个记账格)',
      steps: [
        { name: 'c12-stable', eval: 'window.__l3WaitStable ? window.__l3WaitStable() : new Promise((r) => setTimeout(r, 2000))' },
        {
        name: 'c12-register',
        eval: `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const el0 = document.querySelector('svg[data-navic]');
  if (el0 === null) return { ok: false, stage: 'no-navic-svg' };
  const key = el0.dataset.navic;
  window.__l3navicKey = key;
  window.__l3navicBase = el0.innerHTML;
  window.__navicIcons.register({ [key]: 'bell' });
  await frame();
  const after = document.querySelector('svg[data-navic]');
  const first = after?.querySelector('path')?.getAttribute('d') ?? null;
  const direct = {
    key,
    navic: after?.dataset.navic ?? null,
    bellHead: first !== null && first.startsWith('M8 2.2'),
    changed: (after?.innerHTML ?? null) !== window.__l3navicBase,
    persistHasKey: Object.prototype.hasOwnProperty.call(window.__navicIconDeclarations ?? {}, key),
  };
  const aliasTested = key === '通用设置';
  let aliasBell = null;
  let aliasNavic = null;
  if (aliasTested) {
    window.__navicIcons.register({ General: 'bell' });
    await frame();
    const a = document.querySelector('svg[data-navic="' + key + '"]');
    aliasBell = (a?.querySelector('path')?.getAttribute('d') ?? '').startsWith('M8 2.2');
    aliasNavic = a?.dataset.navic ?? null;
  }
  return { ok: true, key, direct, aliasTested, aliasBell, aliasNavic };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c12-register')?.value
        const ok = v?.ok === true && v.direct?.key === v.key && v.direct?.navic === v.key && v.direct?.bellHead === true && v.direct?.changed === true && v.direct?.persistHasKey === true && (v.aliasTested ? v.aliasBell === true && v.aliasNavic === v.key : true)
        return { ok, expected: '声明 bell 后内容改写且 data-navic 保留、持久层有键;别名组可用时同步改写', actual: v }
      },
    },
    {
      id: 13,
      label: '五类非法载荷拒收回滚,合法渐变接受,无外部请求',
      steps: [{
        name: 'c13-guard',
        eval: `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const key = window.__l3navicKey;
  if (!key) return { ok: false, stage: 'no-navic-key' };
  const read = () => document.querySelector('svg[data-navic="' + key + '"]');
  const baseEl = read();
  const base = baseEl === null ? null : baseEl.innerHTML;
  const bad = [
    '<svg onload="x"></svg>',
    '<svg><path style="background:url(https://evil.example/x)" d="M0 0L1 1"/></svg>',
    '<svg><path fill="url(https://evil.example/p.svg#g)" d="M0 0L1 1"/></svg>',
    '<svg><path xlink:href="https://evil.example/x" d="M0 0L1 1"/></svg>',
    '<svg><animate attributeName="href" values="javascript:x"/><path d="M0 0L1 1"/></svg>',
  ];
  const rejected = [];
  for (const payload of bad) {
    window.__navicIcons.register({ [key]: payload });
    await frame();
    const el = read();
    const html = el?.innerHTML ?? '';
    rejected.push({ rolledBack: html === base, dirty: html.includes('onload') || html.includes('evil.example') || html.includes('<animate'), navic: el?.dataset.navic ?? null });
  }
  const legal = '<svg><defs><linearGradient id="myGradient"><stop offset="0" stop-color="#0AF"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><path fill="url(#myGradient)" d="M0 0L1 1"/></svg>';
  window.__navicIcons.register({ [key]: legal });
  await frame();
  const el = read();
  return {
    rejected,
    accepted: (el?.innerHTML ?? '').includes('id="myGradient"'),
    gradTag: el !== null && el.querySelector('linearGradient') !== null,
    fill: el?.querySelector('path')?.getAttribute('fill') ?? null,
    navic: el?.dataset.navic ?? null,
    external: performance.getEntriesByType('resource').map((e) => e.name).filter((u) => !u.startsWith(location.origin) && !u.startsWith('data:') && !u.startsWith('blob:')),
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c13-guard')?.value
        const allRejected = Array.isArray(v?.rejected) && v.rejected.length === 5 && v.rejected.every((x) => x.rolledBack === true && x.dirty === false && x.navic !== null)
        const accepted = v?.accepted === true && v.gradTag === true && v.fill === 'url(#myGradient)' && v.navic !== null && Array.isArray(v.external) && v.external.length === 0
        return { ok: allRejected && accepted, expected: '5 类非法回滚且 data-navic 保留 + 合法渐变被接受 + 期间无外部资源请求', actual: v }
      },
    },
    {
      id: 8,
      label: '样式元素恰 1 且刷新后仍为 1(最后执行,reload 会关设置)',
      steps: [
        {
          name: 'c8-style',
          eval: `(() => ({ count: document.querySelectorAll('style[data-plugin="@mzzsfy/dsh-settings-nav-icons"]').length }))()`,
        },
        { name: 'c8-reload', reload: true },
        { name: 'c8-wait', wait: 3000 },
        {
          name: 'c8-style-after',
          eval: `(() => ({ count: document.querySelectorAll('style[data-plugin="@mzzsfy/dsh-settings-nav-icons"]').length }))()`,
        },
      ],
      judge: (byName) => {
        const before = byName.get('c8-style')?.value
        const after = byName.get('c8-style-after')?.value
        return { ok: before?.count === 1 && after?.count === 1, expected: '刷新前后均恰 1', actual: { before, after } }
      },
    },
  ],

  'dsh-turn-notify': [
    {
      id: 2,
      label: '面板/四 tab 顺序/默认选中/切 tab 不写配置',
      steps: [{
        name: 'c2-tabs',
        eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = document.querySelector('.tn-panel');
  if (!panel) return { panel: false };
  const tabs = () => [...document.querySelectorAll('.tn-tabs [role="tab"]')];
  const s0 = await (await fetch('/api/turn-notify/config')).json();
  const labels = tabs().map((t) => t.textContent.trim());
  const selected = tabs().filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent.trim());
  for (const t of tabs()) { t.click(); await sleep(600); }
  const s1 = await (await fetch('/api/turn-notify/config')).json();
  document.querySelector('[aria-controls="tn-panel-方式"]')?.click();
  await sleep(600);
  return { panel: true, labels, selected, hint: panel.querySelector('.tn-head__hint')?.textContent ?? null, cfgSame: JSON.stringify(s0) === JSON.stringify(s1) };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c2-tabs')?.value
        const ok = v?.panel === true && JSON.stringify(v.labels) === JSON.stringify(['提醒方式', '通知规则', '音效', '外部推送']) && JSON.stringify(v.selected) === JSON.stringify(['提醒方式']) && v.hint === '开关与选项自动保存。悬停选项查看说明。' && v.cfgSame === true
        return { ok, expected: '四 tab 顺序 + 默认提醒方式 + hint 文案 + 切 tab 前后 config 一致', actual: v }
      },
    },
    {
      id: 3,
      label: '提醒方式控件齐备 + 5 样式 + 试听/预览紧邻',
      steps: [{
        name: 'c3-controls',
        eval: `(() => {
  const q = (s) => document.querySelector(s);
  const st = q('select[aria-label="页内提示样式"]');
  const row = (label) => [...document.querySelectorAll('.tn-field__label')].find((n) => n.textContent.trim() === label)?.parentElement?.querySelector('.tn-field__control');
  return {
    ctl: {
      sound: q('input[aria-label="播放通知提示音"]') !== null,
      volume: q('input[aria-label="通知音量"]') !== null,
      toast: q('input[aria-label="显示页内通知"]') !== null,
      style: st !== null,
      page: q('input[aria-label="页内提示音"]') !== null,
      sys: q('input[aria-label="显示系统通知"]') !== null,
    },
    styles: st ? [...st.options].map((o) => o.textContent.trim()) : [],
    styleVal: st?.value ?? null,
    adj: {
      sound: row('通知提示音')?.querySelector('button[aria-label="试听提示音"]') !== null,
      style: row('通知样式')?.querySelector('button[aria-label="预览样式"]') !== null,
      page: row('页内提示音')?.querySelector('button[aria-label="试听页内音"]') !== null,
    },
    volOut: q('.tn-field__control output')?.textContent ?? null,
    buttons: [...document.querySelectorAll('.tn-panel button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c3-controls')?.value
        const ok = Object.values(v?.ctl ?? {}).every(Boolean) && JSON.stringify(v?.styles) === JSON.stringify(['标准浮条', '主题卡片', '极简细条', '状态强调', '倒计时']) && Object.values(v?.adj ?? {}).every(Boolean) && v.volOut === '60%'
        return { ok, expected: '六控件 + 五样式 + 三试听/预览 + 音量输出 60%', actual: v }
      },
    },
    {
      id: 7,
      label: '侧边栏状态卡:两开关 + 标记值 + 说明 + CSS 标记',
      steps: [{
        name: 'c7-status',
        eval: `(async () => {
  const c = await (await fetch('/api/turn-notify/config')).json();
  const hl = document.querySelector('input[aria-label="通知会话闪烁"]');
  const fr = document.querySelector('input[aria-label="工作区运行标记"]');
  const css = [...document.querySelectorAll('style[data-plugin="@mzzsfy/dsh-turn-notify"]')].map((s) => s.textContent).join('\\n');
  const field = fr?.closest('.tn-field');
  return {
    hl: hl?.checked ?? null,
    fr: fr?.checked ?? null,
    cfg: c?.folderRunningEnabled ?? null,
    meta: (field?.innerText ?? '').includes('所有浏览器') && (field?.innerText ?? '').includes('刷新后生效'),
    cssCount: document.querySelectorAll('style[data-plugin="@mzzsfy/dsh-turn-notify"]').length,
    cssFlag: css.includes('data-tn-folder-running'),
    marked: document.querySelectorAll('[data-tn-folder-running]').length,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c7-status')?.value
        const ok = v?.hl === true && v?.fr === true && v.cfg !== false && v.meta === true && v.cssCount >= 1 && v.cssFlag === true && v.marked === 0
        return { ok, expected: '闪烁默认开 + 标记值=config.folderRunningEnabled + 说明含 所有浏览器/刷新后生效 + CSS 标记 + 空环境无标记节点', actual: v }
      },
    },
    {
      id: 8,
      label: '权限 default 分支:未开启提示 + 申请按钮 + 测试可用',
      steps: [{
        name: 'c8-perm',
        eval: `(() => {
  const perm = typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;
  const btn = (name) => document.querySelector('button[aria-label="' + name + '"]');
  return {
    perm,
    alerts: [...document.querySelectorAll('.tn-field__alert')].map((e) => [e.textContent.trim(), e.getAttribute('title')]),
    request: btn('申请通知权限') !== null,
    test: btn('测试系统通知') ? { present: true, disabled: btn('测试系统通知').disabled } : null,
    sys: document.querySelector('input[aria-label="显示系统通知"]')?.checked ?? null,
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c8-perm')?.value
        const ok = v?.perm === 'default' && v.alerts.length === 1 && v.alerts[0][0] === '未开启系统通知' && v.request === true && v.test?.present === true && v.test.disabled === false && v.sys === true
        return { ok, expected: 'Notification.permission=default 分支的提示/申请按钮/测试可用/系统通知默认开', actual: v }
      },
    },
    {
      id: 5,
      label: '规则 tab:六事件 chip 顺序与选中态 + 高级过滤三项',
      steps: [
        {
          name: 'c5-open',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('[role="tab"][aria-controls="tn-panel-规则"]')?.click();
  await sleep(2500);
  return true;
})()`,
        },
        {
          name: 'c5-pills',
          eval: `(async () => {
  const c = await (await fetch('/api/turn-notify/config')).json();
  const pills = [...document.querySelectorAll('.tn-pill')];
  const sel = document.querySelector('select[aria-label="最短执行时长"]');
  const cb = (name) => {
    const el = document.querySelector('input[aria-label="' + name + '"]');
    return el ? { on: el.checked, inAdv: el.closest('details') !== null } : null;
  };
  return {
    labels: pills.map((p) => p.textContent.trim()),
    pressed: pills.map((p) => p.getAttribute('aria-pressed')),
    on: document.querySelectorAll('.tn-pill.tn-pill--on').length,
    enabled: c?.enabled ?? null,
    minVal: sel?.value ?? null,
    opts: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
    roots: cb('仅通知主会话'),
    wake: cb('减少委托过程通知'),
    summaries: [...document.querySelectorAll('.tn-panel details summary')].map((s) => s.textContent.trim()),
    focus: cb('专注时减少打扰'),
  };
})()`,
        },
      ],
      judge: (byName) => {
        const v = byName.get('c5-pills')?.value
        const labels = ['任务完成', '任务出错', '异常中断', '等待审批', 'AI 提问', '回复被截断']
        const ok = JSON.stringify(v?.labels) === JSON.stringify(labels) && Array.isArray(v?.pressed) && v.pressed.every((p) => p === 'true') && v.on === 6 && Object.values(v?.enabled ?? {}).every((x) => x === true) && v.minVal === '5000' && v.opts.includes('不过滤') && v.opts.includes('少于 5 秒不通知') && v.roots?.on === true && v.roots.inAdv === true && v.wake?.on === true && v.focus?.on === true
        return { ok, expected: '六 chip 顺序/全亮 + config.enabled 全 true + min=5000 + 高级过滤两开关在 details 内 + 专注时减少打扰开', actual: v }
      },
    },
    {
      id: 6,
      label: '两处专注开关位置与平台默认(保留无声系统通知)',
      steps: [
        {
          name: 'c6-open-rule',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('[role="tab"][aria-controls="tn-panel-规则"]')?.click();
  await sleep(1200);
  return true;
})()`,
        },
        {
          name: 'c6-rule',
          eval: `(() => {
  const el = document.querySelector('input[aria-label="专注时减少打扰"]');
  return { on: el?.checked ?? null, card: el?.closest('.tn-card')?.querySelector('.tn-card__title')?.textContent ?? null };
})()`,
        },
        {
          name: 'c6-open-way',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('[role="tab"][aria-controls="tn-panel-方式"]')?.click();
  await sleep(1200);
  return true;
})()`,
        },
        {
          name: 'c6-way',
          eval: `(() => {
  const platform = document.documentElement.dataset.platform ?? null;
  const win = document.querySelector('input[aria-label="专注时保留无声系统通知"]');
  return {
    platform,
    on: win?.checked ?? null,
    card: win?.closest('.tn-card')?.querySelector('.tn-card__title')?.textContent ?? null,
    stored: localStorage.getItem('turn-notify:foreground-system'),
    protocol: location.protocol,
    expect: platform === 'darwin',
  };
})()`,
        },
      ],
      judge: (byName) => {
        const rule = byName.get('c6-rule')?.value
        const way = byName.get('c6-way')?.value
        const ok = rule?.card === '使用页面时' && rule.on === true && way?.on === way?.expect && way.stored === null && way.card === '浏览器提醒' && way.protocol === 'http:'
        return { ok, expected: '「专注时减少打扰」在「使用页面时」卡且默认开;「保留无声系统通知」在「浏览器提醒」卡且默认随平台;未存偏好', actual: { rule, way } }
      },
    },
    {
      id: 9,
      label: '音效 tab:六事件 select + 页内六项 + 音效库',
      steps: [
        {
          name: 'c9-open',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('[role="tab"][aria-controls="tn-panel-音效"]')?.click();
  await sleep(2500);
  return true;
})()`,
        },
        {
          name: 'c9-sounds',
          eval: `(async () => {
  const L = ['任务完成', '任务出错', '异常中断', '等待审批', 'AI 提问', '回复被截断'];
  const s = (name) => document.querySelector('select[aria-label="' + name + '"]');
  const lib = await (await fetch('/api/turn-notify/sounds')).json();
  const ev = L.map((n) => s(n + '音效'));
  const pg = L.map((n) => s(n + '页内音效'));
  const o = (x) => x ? [...x.options].map((y) => y.textContent.trim()) : null;
  const file = document.querySelector('input[type="file"][aria-label="添加音效"]');
  return {
    ev: ev.filter(Boolean).length,
    pg: pg.filter(Boolean).length,
    selects: document.querySelectorAll('.tn-select').length,
    evOpts: o(ev[0]),
    pgOpts: o(pg[0]),
    local: document.querySelector('input[aria-label="仅此浏览器使用独立音效"]') !== null,
    file: file ? [file.getAttribute('accept'), file.multiple] : null,
    titles: [...document.querySelectorAll('.tn-card__title')].map((n) => n.textContent.trim()),
    empty: (document.querySelector('.tn-panel')?.innerText ?? '').includes('暂无上传音效'),
    previews: [...document.querySelectorAll('.tn-btn')].filter((b) => (b.getAttribute('aria-label') || '').startsWith('试听')).length,
    lib: (lib?.sounds ?? []).length,
  };
})()`,
        },
      ],
      judge: (byName) => {
        const v = byName.get('c9-sounds')?.value
        const ok = v?.ev === 6 && v.pg === 6 && v.selects === 12 && v.evOpts?.[0] === '内置默认' && v.evOpts.length === 9 && v.pgOpts?.[0] === '沿用通知音效' && JSON.stringify(v.file) === JSON.stringify(['.wav,.mp3,.ogg', true]) && v.titles.includes('事件音效') && v.titles.includes('音效库') && v.empty === true && v.previews === 12 + v.lib
        return { ok, expected: '6+6 select(共 12) + 选项文案 + 独立音效开关 + file accept/multiple + 音效库空态 + 12 试听按钮', actual: v }
      },
    },
    {
      id: 4,
      label: 'webhook:输入/保存/测试在场 + 失焦不自动保存 + 无效禁测',
      steps: [
        {
          name: 'c4-open',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('[role="tab"][aria-controls="tn-panel-推送"]')?.click();
  await sleep(2500);
  return true;
})()`,
        },
        {
          name: 'c4-state',
          eval: `(() => {
  const btn = (n) => document.querySelector('button[aria-label="' + n + '"]');
  return {
    input: document.querySelector('input[aria-label="webhook URL"]') !== null,
    save: btn('保存地址') !== null,
    test: btn('测试推送') !== null,
    clear: btn('清除') !== null,
    clearDisabled: btn('清除')?.disabled ?? null,
    testDisabled: btn('测试推送')?.disabled ?? null,
    saveDisabled: btn('保存地址')?.disabled ?? null,
    status: document.querySelector('.tn-card [role="status"]')?.textContent.trim() ?? null,
  };
})()`,
        },
        { name: 'c4-type', type: { selector: 'input[aria-label="webhook URL"]', text: 'https://example.invalid/hook' } },
        { name: 'c4-tab', press: 'Tab' },
        {
          name: 'c4-after',
          eval: `(async () => {
  const c = await (await fetch('/api/turn-notify/config')).json();
  const btn = (n) => document.querySelector('button[aria-label="' + n + '"]');
  return { w: c?.webhookUrl ?? null, saveDisabled: btn('保存地址')?.disabled ?? null, testDisabled: btn('测试推送')?.disabled ?? null, status: document.querySelector('.tn-card [role="status"]')?.textContent.trim() ?? null };
})()`,
        },
      ],
      judge: (byName) => {
        const s = byName.get('c4-state')?.value
        const a = byName.get('c4-after')?.value
        const ok = s?.input === true && s.save === true && s.test === true && s.clear === true && s.clearDisabled === true && s.testDisabled === true && s.saveDisabled === true && s.status === '未配置' && a?.w === '' && a.saveDisabled === false && a.testDisabled === true && a.status === '地址未保存，请先保存再测试'
        return { ok, expected: '四控件在场 + 空态三按钮均禁 + 失焦后 config 未变/保存可点/测试仍禁/状态提示', actual: { s, a } }
      },
    },
    {
      id: 10,
      label: 'IM 不可用分支:说明与禁用相关操作 + 四 tab 不变',
      steps: [{
        name: 'c10-im',
        eval: `(async () => {
  const c = await (await fetch('/api/turn-notify/config')).json();
  const P = document.querySelector('.tn-panel');
  const t = P?.innerText ?? '';
  return {
    imAvailable: c?.imAvailable ?? null,
    titles: [...P.querySelectorAll('.tn-card__title')].map((n) => n.textContent.trim()),
    toggle: P.querySelector('input[aria-label="启用聊天推送"]') !== null,
    testIm: P.querySelector('button[aria-label="测试聊天推送"]') !== null,
    loadTargets: [...P.querySelectorAll('button')].some((b) => b.textContent.trim() === '获取接收对象'),
    botId: P.querySelector('input[placeholder="从设置页 IM机器人 卡片复制 Bot ID"]') !== null,
    hint: t.includes('聊天推送依赖') && t.includes('@xmanrui/dsh-im'),
    href: P.querySelector('a.tn-link')?.getAttribute('href') ?? null,
    tabs: P.querySelectorAll('.tn-tabs [role="tab"]').length,
    buttons: [...P.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
  };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c10-im')?.value
        const ok = v?.imAvailable === false && v.titles.includes('webhook') && v.titles.includes('聊天推送（IM）') && v.toggle === false && v.testIm === false && v.loadTargets === false && v.botId === false && v.hint === true && v.href === 'https://www.npmjs.com/package/@xmanrui/dsh-im' && v.tabs === 4
        return { ok, expected: 'imAvailable=false 分支:仅说明与链接,无开关/测试/获取对象/BotID,四 tab 不变', actual: v }
      },
    },
    {
      id: 11,
      label: '测试入口盘点:方式 5 / 推送 3 / 音效 12,无独立测试 tab',
      steps: [],
      judge: (byName) => {
        const c2 = byName.get('c2-tabs')?.value
        const c3 = byName.get('c3-controls')?.value
        const c9 = byName.get('c9-sounds')?.value
        const c10 = byName.get('c10-im')?.value
        const needWay = ['试听提示音', '预览样式', '试听页内音', '测试系统通知', '测试桌面通知']
        const needPush = ['保存地址', '测试推送', '清除']
        const ok = needWay.every((n) => c3?.buttons?.includes(n)) && needPush.every((n) => c10?.buttons?.includes(n)) && c9?.previews === 12 + c9?.lib && !c2?.labels?.includes('测试')
        return { ok, expected: '方式 5 入口 + 推送 3 入口 + 音效试听 12 + tab 集合无「测试」', actual: { way: c3?.buttons, push: c10?.buttons, previews: c9?.previews } }
      },
    },
  ],

  'dsh-keep-working': [
    {
      id: 'S2-S7',
      label: '配置面板可导航 + config 形态(不计入 51 条行为断言)',
      steps: [
        {
          name: 'ckw-nav',
          eval: `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickText = (text) => {
    const el = [...document.querySelectorAll('button,[role=button]')].find((b) => (b.textContent || '').trim() === text || (b.getAttribute('aria-label') || '') === text);
    if (!el) return false;
    el.click();
    return true;
  };
  if (!document.querySelector('[data-plugin-package="@mzzsfy/dsh-keep-working"]')) {
    clickText('插件');
    for (let i = 0; i < 20; i += 1) {
      if (document.querySelector('[data-plugin-package="@mzzsfy/dsh-keep-working"]')) break;
      await sleep(500);
    }
  }
  const li = document.querySelector('[data-plugin-package="@mzzsfy/dsh-keep-working"]');
  if (!li) return { ok: false, stage: 'package-card-missing' };
  (li.querySelector('button[aria-label^="查看"]') || li.querySelector('button[aria-label]') || li.querySelector('button'))?.click();
  await sleep(2500);
  const detail = document.querySelector('[data-plugin-detail="@mzzsfy/dsh-keep-working"]');
  if (!detail) return { ok: false, stage: 'detail-missing' };
  for (let i = 0; i < 15; i += 1) {
    if (detail.querySelector('.kw-card')) break;
    await sleep(200);
  }
  const panel = detail.querySelector('.kw-panel');
  return {
    ok: true,
    stage: 'done',
    panel: panel !== null,
    cards: detail.querySelectorAll('.kw-card').length,
    switches: detail.querySelectorAll('.kw-switch input[type=checkbox]').length,
    numbers: detail.querySelectorAll('input.kw-number').length,
    textareas: detail.querySelectorAll('textarea.kw-textarea').length,
    buttons: detail.querySelectorAll('.kw-btn').length,
    units: detail.querySelectorAll('span.kw-unit').length,
  };
})()`,
        },
        {
          name: 'ckw-config',
          eval: `(async () => {
  const res = await fetch('/api/keep-working/config');
  const j = await res.json();
  const need = ['graceMs', 'cooldownMs', 'maxConsecutive', 'backoffFactor', 'backoffMaxMs', 'scanLimit', 'freshMs', 'offlineCheckMs', 'scanOnBoot', 'resumeGoals', 'resumePausedGoals', 'resumeSilentTurns', 'pauseWhenOffline', 'classify', 'enforceClosure', 'paused', 'retryableErrorPatterns', 'continueText', 'continueTextMaxTokens', 'continueTextSilent', 'continueTextInterrupted', 'restartText', 'closureText'];
  const value = j?.value ?? {};
  const defaults = j?.defaults ?? {};
  return {
    status: res.status,
    ok: j?.ok === true,
    missing: need.filter((k) => !(k in value)),
    defaultsKeys: Object.keys(defaults),
    defaultsSubset: Object.keys(defaults).every((k) => k in value && typeof defaults[k] === typeof value[k]),
  };
})()`,
        },
      ],
      judge: (byName) => {
        const nav = byName.get('ckw-nav')?.value
        const cfg = byName.get('ckw-config')?.value
        const navOk = nav?.ok === true && nav.panel === true && nav.cards === 4 && nav.switches === 6 && nav.numbers === 3 && nav.textareas === 6 && nav.buttons === 2 && nav.units === 3
        const cfgOk = cfg?.status === 200 && cfg.ok === true && cfg.missing.length === 0 && cfg.defaultsSubset === true
        return { ok: navOk && cfgOk, expected: '三跳导航后 .kw-panel 与 4/6/3/6/2/3 计数 + config 23 键 + defaults 子集', actual: { nav, cfg } }
      },
    },
  ],

  'dsh-shell-select': [
    {
      id: 4,
      label: '自动探测三客户端可用徽标与解析路径',
      steps: [{
        name: 'c4-entries',
        eval: `(() => {
  const rows = [...document.querySelectorAll('.sls-entry')].map((r) => {
    const head = r.querySelector('.sls-entry__head');
    const badge = head?.querySelector('.sls-badge');
    return { text: (head?.innerText ?? '').replace(/\\s+/g, ' ').trim(), badge: badge?.textContent.trim() ?? null, title: badge?.getAttribute('title') ?? null, cls: badge?.className ?? null };
  });
  return { rows, total: document.querySelectorAll('.sls-entry').length };
})()`,
      }],
      judge: (byName) => {
        const v = byName.get('c4-entries')?.value
        const api = byName.get('api-config')?.value?.body?.resolved?.shells ?? []
        const rowsOk = v?.total === 3 && v.rows.every((r) => r.badge === '可用' && /^解析路径:.+/.test(r.title ?? '') && (r.cls ?? '').includes('sls-badge--ok'))
        const apiOk = api.length === 3 && api.every((s) => s.available === true && typeof s.path === 'string' && s.path.length > 0)
        return { ok: rowsOk && apiOk, expected: '3 行均「可用」+ title「解析路径:…」+ API resolved 三条 available=true 且有 path', actual: { rows: v?.rows, api } }
      },
    },
  ],

  'dsh-auto-trust-all': [
    {
      id: 1,
      label: 'boot 横幅:动态信任已启用 + 镜像 webRuntime 缺席',
      steps: [{ name: 'c1-boot', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } }],
      judge: (byName) => {
        const text = byName.get('c1-boot')?.value ?? ''
        const ok = String(text).includes('动态信任已启用') && String(text).includes('镜像 webRuntime 缺席')
        return { ok, expected: 'boot.log 含「动态信任已启用」与「镜像 webRuntime 缺席」', actual: String(text).slice(-600) }
      },
    },
    {
      id: 3,
      label: 'Host 信任探针返回 200 + JSON activation',
      steps: [{
        name: 'c3-probe',
        curl: { host: 'probe.l3a.evil.test', path: '/dsh-market/installed', expect: { status: 200, fields: { activation: { notNull: true } } } },
      }],
    },
    {
      id: 4,
      label: '同域名重复探针只登记一次',
      steps: [
        { name: 'c4-first', curl: { host: 'probe.l3b.evil.test', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c4-second', curl: { host: 'probe.l3b.evil.test', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c4-wait', wait: 600 },
        { name: 'c4-log', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } },
      ],
      judge: (byName) => {
        const text = String(byName.get('c4-log')?.value ?? '')
        const count = (text.match(/registered host probe\.l3b\.evil\.test/g) ?? []).length
        return { ok: count === 1, expected: 'registered host probe.l3b.evil.test 出现 1 次', actual: { count, tail: text.slice(-400) } }
      },
    },
    {
      id: 5,
      label: 'Referer 探针 200 且登记',
      steps: [
        { name: 'c5-probe', curl: { host: 'probe.l3c.evil.test', path: '/dsh-market/installed', referer: 'http://probe.l3c.evil.test/', expect: { status: 200 } } },
        { name: 'c5-wait', wait: 600 },
        { name: 'c5-log', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } },
      ],
      judge: (byName) => {
        const text = String(byName.get('c5-log')?.value ?? '')
        return { ok: text.includes('registered host probe.l3c.evil.test'), expected: 'registered host probe.l3c.evil.test 出现', actual: text.slice(-400) }
      },
    },
    {
      id: 6,
      label: 'Host/Origin/Referer 三头探针 200 且登记',
      steps: [
        { name: 'c6-probe', curl: { host: 'probe.l3d.evil.test', path: '/dsh-market/installed', origin: 'http://probe.l3d.evil.test', referer: 'http://probe.l3d.evil.test/', expect: { status: 200 } } },
        { name: 'c6-wait', wait: 600 },
        { name: 'c6-log', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } },
      ],
      judge: (byName) => {
        const text = String(byName.get('c6-log')?.value ?? '')
        return { ok: text.includes('registered host probe.l3d.evil.test'), expected: 'registered host probe.l3d.evil.test 出现', actual: text.slice(-400) }
      },
    },
    {
      id: 7,
      label: '主机名大小写与端口归一后不重复登记',
      steps: [
        { name: 'c7-first', curl: { host: 'probe.l3f.evil.test', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c7-second', curl: { host: 'Probe.L3F.Evil.Test:8443', path: '/dsh-market/installed', origin: 'http://Probe.L3F.Evil.Test:8443', expect: { status: 200 } } },
        { name: 'c7-wait', wait: 600 },
        { name: 'c7-log', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } },
      ],
      judge: (byName) => {
        const text = String(byName.get('c7-log')?.value ?? '')
        const count = (text.match(/registered host probe\.l3f\.evil\.test/g) ?? []).length
        return { ok: count === 1, expected: '归一后 registered host probe.l3f.evil.test 仍为 1 次', actual: { count, tail: text.slice(-400) } }
      },
    },
    {
      id: 8,
      label: '仅 Host 探针 200 且登记',
      steps: [
        { name: 'c8-probe', curl: { host: 'probe.l3e.evil.test', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c8-wait', wait: 600 },
        { name: 'c8-log', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } },
      ],
      judge: (byName) => {
        const text = String(byName.get('c8-log')?.value ?? '')
        return { ok: text.includes('registered host probe.l3e.evil.test'), expected: 'registered host probe.l3e.evil.test 出现', actual: text.slice(-400) }
      },
    },
    {
      id: 11,
      label: '回环三形态不登记,子域名登记',
      steps: [
        { name: 'c11-localhost', curl: { host: 'localhost', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c11-ipv4', curl: { host: '127.0.0.1', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c11-ipv6', curl: { host: '[::1]', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c11-sub', curl: { host: 'sub.l3.evil.test', path: '/dsh-market/installed', expect: { status: 200 } } },
        { name: 'c11-wait', wait: 600 },
        { name: 'c11-log', log: { file: '.compat/0.2.2-rc.5/boot.log', tail: 400 } },
      ],
      judge: (byName) => {
        const text = String(byName.get('c11-log')?.value ?? '')
        const sub = text.includes('registered host sub.l3.evil.test')
        const loopback = ['registered host localhost', 'registered host 127.0.0.1', 'registered host [::1]'].filter((s) => text.includes(s))
        return { ok: sub && loopback.length === 0, expected: '子域名出现 registered;回环三形态均不出现', actual: { sub, loopback, tail: text.slice(-400) } }
      },
    },
  ],
}

// 入口导航:设置按钮 → 设置分区 / 侧栏入口。全部用 DOM click(React 合成事件)
const openEntry = (cfg) => `(async () => {
  const cfg = ${JSON.stringify(cfg)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findClickable = (needle, exact) => {
    const all = [...document.querySelectorAll('button,a,[role=button],[role=menuitem],[role=tab],li,span,div')];
    for (const el of all) {
      const t = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const hit = exact ? t === needle : (aria.includes(needle) || title.includes(needle) || t === needle);
      if (!hit) continue;
      return el.closest('button,a,[role=button],[role=menuitem],[role=tab]') || el;
    }
    return null;
  };
  const click = async (el, waitMs) => {
    el.scrollIntoView?.({ block: 'center' });
    el.click();
    await sleep(waitMs);
  };
  const out = { settings: false, section: false, entry: null };
  if (!cfg) return out;
  if (cfg.settings) {
    let opened = false;
    const direct = [...document.querySelectorAll('button,[role=button]')].find((el) => (el.getAttribute('aria-label') || '').includes('设置') || (el.getAttribute('title') || '').includes('设置'));
    if (direct) { await click(direct, 1800); opened = true }
    if (!opened) {
      // 设置入口在账号菜单内:先展开菜单再点“设置”项
      const trigger = document.querySelector('button[class*="trigger"]');
      if (trigger) {
        await click(trigger, 900);
        const item = [...document.querySelectorAll('[role=menuitem]')].find((el) => (el.textContent || '').includes('设置'));
        if (item) { await click(item, 1800); opened = true }
      }
    }
    out.settings = opened;
  }
  if (cfg.section) {
    const nav = [...document.querySelectorAll('[class*="navLabel"]')].find((el) => (el.textContent || '').trim() === cfg.section);
    const sec = nav?.closest('button,[role=button],[role=menuitem],[role=tab]') ?? nav ?? findClickable(cfg.section, true) ?? findClickable(cfg.section, false);
    if (sec) { await click(sec, 2200); out.section = true }
  }
  if (cfg.clickText) {
    const ent = findClickable(cfg.clickText, false);
    if (ent) { await click(ent, 2500); out.entry = cfg.clickText }
  }
  return out;
})()`

// 面板扫描:选择器存在性 + 元素计数 + 文案命中 + 失败横幅
const panelScan = (cfg) => `(() => {
  const cfg = ${JSON.stringify(cfg)};
  const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
  const counts = {};
  for (const [sel, expect] of Object.entries(cfg.counts || {})) counts[sel] = { value: document.querySelectorAll(sel).length, expect };
  const textHits = {};
  for (const kw of cfg.textHits || []) textHits[kw] = body.includes(kw);
  return { panel: cfg.panelSel ? !!document.querySelector(cfg.panelSel) : null, counts, textHits, failBanner: body.includes('Failed to load plugins'), textLen: body.length, sample: body.slice(0, 240) };
})()`

// 激活面:/dsh-market/installed 取本包 state 与 diagnostics findings
const activationEval = (pkg) => `(async () => {
  const res = await fetch('/dsh-market/installed');
  const data = await res.json();
  const activation = data.activation ?? {};
  const findings = data.diagnostics?.findings ?? [];
  const mine = Object.entries(activation).filter(([name]) => name.includes(${JSON.stringify(pkg)})).map(([name, v]) => [name, v?.state ?? null]);
  return { status: res.status, mine, findingsCount: findings.length, findingsSample: findings.slice(0, 2) };
})()`

export function buildSteps(pkg, { workDir }) {
  const cfg = L3_BASE[pkg]
  if (!cfg) throw new Error(`未知 L3 包: ${pkg}`)
  const checks = L3_CHECKS[pkg] ?? []
  const scanCfg = { panelSel: cfg.panelSel ?? null, counts: cfg.counts ?? {}, textHits: cfg.textHits ?? [] }
  return [
    { name: 'open-entry', eval: openEntry(cfg.open ?? null) },
    { name: 'panel-scan', eval: panelScan(scanCfg) },
    { name: 'activation', eval: activationEval(pkg) },
    ...(cfg.apis ?? []).map((api) => ({
      name: `api-${api.name}`,
      http: {
        path: api.path,
        method: api.method ?? 'GET',
        ...(api.body === undefined ? {} : { body: api.body }),
        ...(api.expect === undefined ? {} : { expect: api.expect }),
      },
    })),
    ...(cfg.customApis ?? []).map((api) => ({ name: `api-${api.name}`, eval: api.expr })),
    ...(cfg.evals ?? []).map((e) => ({ name: e.name, eval: e.expr })),
    ...checks.flatMap((check) => check.steps),
    { name: 'shot', shot: `${workDir}/l3-${pkg}.png` },
  ]
}

// checks 判定:整项所有步骤通过才算该编号格已验;失败取首个失败步骤的归因
export function judgeChecks(pkg, results) {
  const byName = new Map(results.map((result) => [result.name, result]))
  return (L3_CHECKS[pkg] ?? []).map((check) => {
    const missing = check.steps.filter((step) => !byName.has(step.name)).map((step) => step.name)
    if (missing.length > 0) return { id: check.id, label: check.label, ok: false, error: `步骤缺失: ${missing.join(', ')}` }
    if (check.judge) return { id: check.id, label: check.label, ...check.judge(byName) }
    const failed = check.steps.map((step) => byName.get(step.name)).find((result) => !result.ok)
    return failed
      ? { id: check.id, label: check.label, ok: false, error: failed.error, expected: failed.expected, actual: failed.actual }
      : { id: check.id, label: check.label, ok: true }
  })
}
