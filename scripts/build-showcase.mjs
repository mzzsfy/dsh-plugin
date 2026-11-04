// 商店展示效果单文档生成:图标内联 + 截图 base64,产出 docs/商店展示效果.html。
// 幂等:重跑覆盖;截图目录新增文件后重跑即纳入。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICON_MAP } from './catalog-manifest.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const shotsRoot = join(repo, 'assets/screenshots')
const outPath = join(repo, 'docs/商店展示效果.html')

// 每包一句话展示;与根 README 一览表的功能列对应,单文档为浏览形态故精简
const DESC = {
  'dsh-usage-panel': '账号余额与额度面板:七类 provider 定时查询、趋势图、阈值通知',
  'dsh-usage-dash': '用量统计:三粒度 token 统计、26 周热力图、回合费用芯片',
  'dsh-maintain': '版本与运维:自动发现新版本、A/B 一键升级、安全重启',
  'dsh-think-expand': '流式思考自动展开:始终显示最新思考',
  'dsh-turn-notify': '回合事件通知:声音/弹窗/页内/webhook/IM 多通道',
  'dsh-session-manager': '会话生命周期:超期自动归档、归档面板、误归档防抖',
  'dsh-rs-workflow': '若水工作流:模板一键释放为 Agent 预设组合',
  'dsh-llm-pi-gateway': 'PiAiAdapter 会话标记增强(纯 host)',
  'dsh-settings-nav-icons': '设置导航与市场卡片语义图标',
  'dsh-auto-trust-all': '动态信任所有到达 Host(纯 host)',
  'dsh-shared-terminal': '共享交互式终端:AI 与用户共用 Session 终端',
  'dsh-stock-assistant': '股票工作台:八市场自选/搜索/K线,免注册数据源',
  'dsh-cron-board': '定时任务看板:cron 调度脚本与会话任务,环境变量集中管理',
  'dsh-common-tools': '公共依赖库:WS 总线与 toast(非插件)',
  'dsh-context-manager': '对话增强:历史输入浮层、插话撤回、对话分叉',
  'dsh-boss-simulator': '公司管理模拟器:派任务给自治部门,只接受汇报',
  'dsh-shell-select': 'Windows Shell 接管:多客户端可配置,deny 黑名单',
  'dsh-tool-gate': '全局工具白名单延迟加载',
  'dsh-tunnel': '路径穿透隧道:/p/ 子路径与子域名反代,AI 三工具自管',
}

const SHOT_LABEL = {
  board: '主面板',
  settings: '设置分区',
  'settings-card': '设置折叠卡',
  session: '会话终端',
  'plugin-list': '插件列表头像槽',
  'plugins-page': '插件页',
  discover: '市场页',
}

let iconCards = ''
for (const [pkg, glyph] of Object.entries(ICON_MAP)) {
  const svg = readFileSync(join(repo, 'assets/icons', `${pkg}.svg`), 'utf8').replace('<svg ', '<svg width="48" height="48" ')
  iconCards += `<div class=icon-card><div class=icon-box>${svg}</div><div class=icon-name>${pkg.replace('dsh-', '')}</div><div class=icon-glyph>${glyph}</div></div>`
}

let shotSections = ''
for (const dir of readdirSync(shotsRoot).sort()) {
  // 隐藏目录(.thumbnails 等)与隐藏文件不入展示面
  if (dir.startsWith('.')) continue
  const dirPath = join(shotsRoot, dir)
  if (!statSync(dirPath).isDirectory()) continue
  const files = readdirSync(dirPath).filter((f) => !f.startsWith('.') && f.endsWith('.png'))
  if (files.length === 0) continue
  const desc = DESC[dir] ?? ''
  shotSections += `<h2>${dir}</h2><p class=desc>${desc}</p><div class=shots>`
  for (const file of files) {
    const b64 = readFileSync(join(dirPath, file), 'base64')
    const label = SHOT_LABEL[file.replace('.png', '')] ?? file.replace('.png', '').replaceAll('-', ' ')
    shotSections += `<figure><img src="data:image/png;base64,${b64}" loading=lazy><figcaption>${label}</figcaption></figure>`
  }
  shotSections += '</div>'
}

const style = [
  'body{font-family:system-ui,"微软雅黑",sans-serif;max-width:1280px;margin:0 auto;padding:32px;background:#f6f7f9;color:#1a1a1a}',
  'h1{font-size:24px}h2{margin-top:40px;font-size:18px;border-left:4px solid #4a7dff;padding-left:10px}',
  '.desc{color:#666;margin-top:-8px}',
  '.grid{display:flex;flex-wrap:wrap;gap:16px}',
  '.icon-card{width:110px;text-align:center;background:#fff;border:1px solid #e2e5ea;border-radius:12px;padding:14px 6px}',
  '.icon-box{width:48px;height:48px;margin:0 auto 8px;color:#1f6dff}',
  '.icon-name{font-size:12px;font-weight:600}.icon-glyph{font-size:11px;color:#999}',
  '.shots{display:grid;grid-template-columns:1fr;gap:20px}',
  'figure{margin:0;background:#fff;border:1px solid #e2e5ea;border-radius:12px;overflow:hidden}',
  'img{width:100%;display:block}figcaption{padding:8px 14px;font-size:13px;color:#555;border-top:1px solid #eee}',
  '.note{background:#eef3ff;border:1px solid #cdd9ff;border-radius:10px;padding:12px 16px;font-size:14px;line-height:1.7}',
  'code{background:#eef0f3;padding:2px 6px;border-radius:4px;font-size:13px}',
].join('')

const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>dsh-plugin 商店展示效果</title><style>${style}</style>` +
  '<h1>dsh-plugin 商店展示效果</h1>' +
  '<div class=note>自建市场索引 <b>@mzzsfy/dsh-plugin-catalog</b>:在 DSH 设置 → Plugins → Discover → Index sources 加入 <code>https://cdn.jsdelivr.net/npm/@mzzsfy/dsh-plugin-catalog/index.json</code>,列表卡片即显示下方语义图标(48px);截图展示于 awesome-dsh-plugin.com 与 dshmarket 详情页。全部 19 包图标与各界面截图均来自隔离环境实测。</div>' +
  '<h2 style="margin-top:32px">商店图标(19 包)</h2><p class=desc>glyph 名与插件设置页图标声明一致;tunnel 取 zap 避免与 llm-pi-gateway 撞形</p>' +
  `<div class=grid>${iconCards}</div>${shotSections}` +
  '<p style="margin-top:48px;color:#999;font-size:12px">生成于 2026-11-03 · 图标数据源 scripts/catalog-manifest.mjs · 截图 assets/screenshots/ · 重新生成:node scripts/build-showcase.mjs</p></html>'

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, html)
console.log(`docs/商店展示效果.html: ${Math.round(html.length / 1024)}KB, ${Object.keys(ICON_MAP).length} icons`)
