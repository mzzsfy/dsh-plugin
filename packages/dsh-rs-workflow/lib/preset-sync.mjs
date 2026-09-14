/**
 * preset-sync — 释放与移除 agent preset(两类释放物,同一权威):
 *
 *   1. collab 内置协作模式:包内 preset/rs-workflow → <dsh-home>/.agent-presets/rs-workflow
 *      (syncPreset,启动时幂等同步)。
 *   2. 用户流程模板模式:设置中的模板经 releaseFlowTemplate 释放为 rs-<flowId>
 *      (看板「释放为模式」按钮 / rs_workflow_template save release:true 触发),
 *      产物 = preset.yml + agent.cordis.yml(生成) + flow.json5 + 来源标记。
 *
 * 所有权防线:目标目录存在但 marker 缺失或归属他人时拒绝覆盖。换入式原子替换:
 * 旧目录先 rename 备份,新目录入位成功才删备份,失败尽力还原(还原也失败改 orphan
 * 前缀保留待人工处置),绝不静默销毁。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaKeysFor, parseVersion as parseVersionCompat } from './persona-compat.mjs'
import { validateFlow } from './flows.mjs'
import JSON5 from 'json5'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_SRC = join(PKG_ROOT, 'preset', 'rs-workflow')
const USER_PRESET_DIR = '.agent-presets'
const PRESET_ID = 'rs-workflow'
const FLOW_PRESET_PREFIX = 'rs-'
const MARKER_NAME = '.dsh-rs-workflow-source.json'
const PACKAGE_NAME = '@mzzsfy/dsh-rs-workflow'

/** dsh home:CLI 配置层可显式指定,插件环境只见 $DSH_HOME;空串视同未设 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim().length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 释放目标绝对路径(诊断用:home 错位时可直接从日志/测试定位) */
export function presetDest() {
  return join(dshHome(), USER_PRESET_DIR, PRESET_ID)
}

/** 流程模板模式的释放目录 */
export function flowPresetDest(flowId) {
  return join(dshHome(), USER_PRESET_DIR, FLOW_PRESET_PREFIX + flowId)
}

// 版本读取容错:package.json 恰逢包管理器替换窗口或损坏时不让包整体加载失败,
// marker 的 version 字段恒有确定语义(缺失/非字符串归一 unknown)
let PKG_VERSION = 'unknown'
try {
  const parsed = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
  if (typeof parsed === 'string' && parsed.length > 0) PKG_VERSION = parsed
} catch { /* 保留 unknown */ }

/** 源目录内容指纹:文件名集合 + 逐文件 size 与 mtime 的聚合。粒度足够感知
 *  同版本内容改动与产物残缺,不引入 hash 依赖 */
function sourceFingerprint() {
  const parts = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) walk(full, relPath)
      else parts.push(`${relPath}:${st.size}:${st.mtimeMs}`)
    }
  }
  walk(PRESET_SRC, '')
  return parts.sort().join('|')
}

/** 读 marker;缺失或损坏返回 null(损坏与缺失同义:无法证明归属) */
function readMarker(dest) {
  const markerPath = join(dest, MARKER_NAME)
  if (!existsSync(markerPath)) return null
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

/** 宿主版本解析:env 优先,其次从宿主入口 argv[1] 向上找 @deepseek-ai/dsh
 *  的 package.json。真实宿主进程不设 dshVersion 环境变量(0.1.5-rc.1 实测
 *  marker 恒 unknown),argv 回退是旧宿主兼容唯一可靠来源;找不到归 unknown */
export function hostVersion(argv1 = process.argv[1]) {
  const fromEnv = process.env.dshVersion
  if (fromEnv && parseVersionCompat(fromEnv) !== null) return fromEnv
  try {
    let dir = argv1 ? dirname(argv1) : ''
    for (let i = 0; i < 6 && dir; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
        } catch { /* 损坏的 package.json 继续向上 */ }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* argv 异常归 unknown */ }
  return 'unknown'
}

/** 释放产物形态指纹:源内容 + 宿主版本档(persona 键名随之变化)。
 *  版本档变化即触发重写,跨版本切换宿主后释放目录随之改写。 */
function releaseFingerprint() {
  return `${sourceFingerprint()}#dsh:${hostVersion()}`
}

/** collab 内置完整性清单:任一缺失即视为残缺,走重写自愈(与 PRESET_SRC 产物对齐) */
const MANAGED_FILES = [
  'preset.yml',
  'agent.cordis.yml',
]

/** 同步释放 collab 模式;返回 'created' | 'updated' | 'unchanged' | 'skipped-foreign' */
export function syncPreset() {
  if (!existsSync(PRESET_SRC)) throw new Error(`包内 preset 缺失: ${PRESET_SRC}`)
  const dest = presetDest()
  // staging 残留清理与快慢路径无关:硬崩溃后仅 rewrite 清理会让残留长期滞留
  cleanStaleStaging(dirname(dest))
  if (!existsSync(dest)) return rewrite(dest, false)
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return 'skipped-foreign'
  // 释放产物形态指纹一致即视为最新(源内容 + 宿主版本档):
  // 双副本 root 交替不再触发整目录重写,仅 marker.root 归属不同时原地改写 marker
  if (marker.fingerprint === releaseFingerprint() && isComplete(dest)) {
    if (marker.root !== PKG_ROOT) {
      writeFileSync(join(dest, MARKER_NAME), JSON.stringify({ ...marker, root: PKG_ROOT }, null, 2) + '\n')
    }
    return 'unchanged'
  }
  return rewrite(dest, true)
}

/** 完整性校验:受管文件任一缺失即残缺 */
function isComplete(dest) {
  return MANAGED_FILES.every((rel) => existsSync(join(dest, rel)))
}

/** 已确认归属本包后的重写。换入式原子替换:旧目录先 rename 到备份名,新目录
 *  rename 入位成功后才删备份;换入失败时尽力还原,还原也失败则把旧副本改名为
 *  orphan 前缀(不匹配清理规则,永不被自动删除)并告警,绝不静默销毁。 */
function rewrite(dest, existed) {
  return atomicReplace(dest, existed, join(stagingOf(dest), 'out'), (out) => {
    cpSync(PRESET_SRC, out, { recursive: true })
    rewritePersonaKeys(join(out, 'agent.cordis.yml'))
    writeFileSync(join(out, MARKER_NAME), JSON.stringify({
      package: PACKAGE_NAME,
      kind: 'collab',
      version: PKG_VERSION,
      root: PKG_ROOT,
      fingerprint: releaseFingerprint(),
    }, null, 2) + '\n')
  })
}

function stagingOf(dest) {
  const parent = dirname(dest)
  // mkdtemp 只创建末级目录,父链先建好(首次释放时 .agent-presets 可能不存在)
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, '.rs-workflow-staging-'))
}

/** 原子换入公共体:build(out) 组装 staging 目录,换入失败尽力还原 */
function atomicReplace(dest, existed, staging, build) {
  mkdirSync(staging, { recursive: true })
  const backup = join(dirname(dest), `.rs-workflow-old-${Date.now()}`)
  let orphan = null
  try {
    build(staging)
    const hasDest = existsSync(dest)
    if (hasDest) renameSync(dest, backup)
    try {
      renameSync(staging, dest)
    } catch (error) {
      if (hasDest) {
        try {
          renameSync(backup, dest)
        } catch (restoreError) {
          // dest 缺失且旧副本留存:改用清理规则不匹配的 orphan 前缀,保留待人工处置
          orphan = join(dirname(backup), `.rs-workflow-orphan-${Date.now()}`)
          try {
            renameSync(backup, orphan)
          } catch {
            orphan = backup
          }
          console.warn(`[rs-workflow] preset 换入失败且还原失败,旧目录保留在 ${orphan}(不会被自动清理,需人工处置)`)
        }
      }
      throw error
    }
  } finally {
    rmSync(dirname(staging), { recursive: true, force: true })
    if (orphan === null) rmSync(backup, { recursive: true, force: true })
  }
  return existed ? 'updated' : 'created'
}

/** persona 行键名按宿主版本改写(见 persona-compat.mjs):仓库源码恒为新版
 *  prefix/suffix 形态,旧宿主(text required)释放时回退改写 */
function rewritePersonaKeys(agentYamlPath) {
  if (!existsSync(agentYamlPath)) return
  const raw = readFileSync(agentYamlPath, 'utf8')
  const converted = personaKeysFor(hostVersion(), raw)
  if (converted !== raw) {
    writeFileSync(agentYamlPath, converted)
  }
}

/** 清理硬崩溃残留的 staging/备份目录(前缀为本包独占,直接删安全);避免预设扫描把它们当 broken preset 展示 */
function cleanStaleStaging(parentDir) {
  let entries = []
  try {
    entries = readdirSync(parentDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.rs-workflow-staging-') || name.startsWith('.rs-workflow-old-')) {
      rmSync(join(parentDir, name), { recursive: true, force: true })
    }
  }
}

/** 删除 collab 内置释放 preset(仅供维护脚本/手工调用,插件生命周期内不触发)。
 *  返回三态:'removed' 已删 | 'missing' 目录不存在 | 'foreign' 外来目录拒绝删除 */
export function removePreset() {
  const dest = presetDest()
  if (!existsSync(dest)) return 'missing'
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return 'foreign'
  rmSync(dest, { recursive: true, force: true })
  cleanStaleStaging(dirname(dest))
  return 'removed'
}

// ── 流程模板模式释放(设置模板 → rs-<id> 模式目录) ────────────────────────────

/** 生成的流程模式组合。takeover 行在 delegation 组内(与 workflowEngine 同 isolate
 *  realm);flowFile 经组合 baseUrl 锚定到释放目录内的 flow.json5。 */
function flowAgentYaml() {
  return `# 由 @mzzsfy/dsh-rs-workflow 释放的流程工作流模式(勿手改:重新释放即覆盖)。
# 形态 = standard 工具行集 + takeover 行(pre-step 引擎接管,见包 lib/takeover.mjs)。
# 子代理(每步执行者)继承本组合全部工具行。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      你是"若水工作流"流程模式会话代理,由 {{model}} 模型驱动。
      本模式的一切用户请求都由若水流程引擎接管执行(pre-step 拦截,你收不到任务原文)。
      你唯一可能被调用working的场景:流程运行期间用户追加消息。此时只做简短答疑,
      不执行任何交付操作,不尝试启动或修改工作流,回答完即止。
    suffix: Your working directory is {{cwd}}.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell ───────────────────────────────────────────────────────────────────

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── filesystem ──────────────────────────────────────────────────────────────

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

# ── background jobs ────────────────────────────────────────────────────────

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

# ── skills ──────────────────────────────────────────────────────────────────

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# ── web ─────────────────────────────────────────────────────────────────────

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000

# ── compaction ──────────────────────────────────────────────────────────────

- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024

# ── delegation and workflows ────────────────────────────────────────────────

# workflowEngine 是预设私有服务,所有触达它的行共享一个 entry-local realm。
# takeover 行也在组内:pre-step 拦截用户消息并经 workflowEngine 启动编排。
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable

    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

    - id: rs-workflow-takeover
      name: '@mzzsfy/dsh-rs-workflow'
      config:
        role: takeover
        kind: flow
        flowFile: !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('flow.json5', baseUrl))"

# ── remaining model-facing rows ─────────────────────────────────────────────

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

# 运行看板上报工具:流程步骤子代理可选软上报(失败即弃,不影响编排)
- id: rs-workflow-report
  name: '@mzzsfy/dsh-rs-workflow'
  config:
    role: report
`
}

/** 释放流程模板为模式。传 entry = {id,label,description,json5};
 *  校验失败抛错(调用方 toast 给用户)。返回 'created' | 'updated'。 */
export function releaseFlowTemplate(entry) {
  const flowId = typeof entry?.id === 'string' ? entry.id.trim() : ''
  if (!/^[a-z][a-z0-9-]*$/.test(flowId)) throw new Error(`流程 id 非法: ${flowId}`)
  // 释放前重新校验定义(设置里可能被外部改坏)
  const flow = JSON5.parse(entry.json5)
  const errors = validateFlow(flow)
  if (errors.length > 0) throw new Error('流程模板校验失败:\n- ' + errors.join('\n- '))
  const dest = flowPresetDest(flowId)
  cleanStaleStaging(dirname(dest))
  const existed = existsSync(dest)
  if (existed) {
    const marker = readMarker(dest)
    if (marker === null || marker.package !== PACKAGE_NAME) throw new Error(`目标目录归属他人,拒绝覆盖: ${dest}`)
  }
  return atomicReplace(dest, existed, join(stagingOf(dest), 'out'), (out) => {
    writeFileSync(join(out, 'flow.json5'), entry.json5, 'utf8')
    writeFileSync(join(out, 'preset.yml'), `name: 若水·${entry.label || flowId}\ndescription: >-\n  ${String(entry.description || '').replace(/\s*\n\s*/g, ' ').slice(0, 200) || '流程工作流模板'}\n`, 'utf8')
    writeFileSync(join(out, 'agent.cordis.yml'), flowAgentYaml(), 'utf8')
    writeFileSync(join(out, MARKER_NAME), JSON.stringify({
      package: PACKAGE_NAME,
      kind: 'flow',
      flowId,
      version: PKG_VERSION,
      root: PKG_ROOT,
      fingerprint: templateFingerprint(entry.json5),
    }, null, 2) + '\n')
  })
}

/** 撤下流程模板模式。返回 'removed' | 'missing' | 'foreign' */
export function unreleaseFlowTemplate(flowId) {
  const dest = flowPresetDest(String(flowId || '').trim())
  if (!existsSync(dest)) return 'missing'
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return 'foreign'
  rmSync(dest, { recursive: true, force: true })
  cleanStaleStaging(dirname(dest))
  return 'removed'
}

/** 模板内容指纹:同 id 重释放时内容不变即无实质更新(原子换入照常,幂等) */
function templateFingerprint(json5Text) {
  return `flow#${Buffer.byteLength(json5Text, 'utf8')}#dsh:${hostVersion()}`
}
