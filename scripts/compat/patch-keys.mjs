// cordis.patch.yml 键集契约对表(纯静态,零宿主启动)。
// 契约语义来自官方(dsh-web-app/cordis.patch.yml 注释):patch 整体替换目标行 config,
// 覆写方必须逐键重述——官方键集 ⊆ 覆写键集且仅预期值翻转 = PASS。
// 用法:node scripts/compat/patch-keys.mjs <闭包根> [packagesDir] [out.json]
//   闭包根含 node_modules/@deepseek-ai(如 .compat/<v>/dsh-host);DRIFT 存在时退出码 1。
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// js-yaml 为 dsh-shell-select 的 devDep(未提升根):经该包 package.json 解析
const yamlStatic = createRequire(fileURLToPath(new URL('../../packages/dsh-shell-select/package.json', import.meta.url)))('js-yaml')

// !!js 标签本地同形 Type:tag 必须写完整 URI(tag:yaml.org,2002:js)——文档简写
// !!js 展开后按完整 URI 匹配,字面 '!!js' 永不命中(shell-select preset-drift 同款,CI 假绿教训)
const LOCAL_SCHEMA = yamlStatic.JSON_SCHEMA.extend(new yamlStatic.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data['__jsExpr'],
}))

const loadDoc = (p) => yamlStatic.load(readFileSync(p, 'utf8'), { schema: LOCAL_SCHEMA })

// 文档形态 = 裸数组。两种行声明:自具行 `- insert: true, id, ...` 与
// 多行 insert 块 `- insert: [行...]`;覆写行无 insert 字段
const rowsOf = (p) => {
  const doc = loadDoc(p)
  return (Array.isArray(doc) ? doc : [doc]).flatMap((op) => {
    if (Array.isArray(op?.insert)) return op.insert.map((row) => ({ isInsert: true, row }))
    return [{ isInsert: op?.insert === true, row: op }]
  })
}

const rowsWithId = (p) => rowsOf(p).filter(({ row }) => row && typeof row === 'object' && row.id)

export function patchKeys({ closureDir, packagesDir, profileDir = null }) {
  const nsDir = join(closureDir, 'node_modules', '@deepseek-ai')
  const official = new Map()
  const officialDuplicates = []
  for (const pkg of readdirSync(nsDir)) {
    const dir = join(nsDir, pkg)
    const rels = ['cordis.patch.yml', ...(existsSync(join(dir, 'presets'))
      ? readdirSync(join(dir, 'presets')).filter((f) => f.endsWith('.patch.yml')).map((f) => `presets/${f}`)
      : [])]
    for (const rel of rels.filter((rel) => existsSync(join(dir, rel)))) {
      for (const { row } of rowsWithId(join(dir, rel))) {
        // 官方行 id 重复 = 契约歧义(Map.set 后者静默覆盖会让对表锚定错行),显式记账
        if (official.has(row.id)) officialDuplicates.push({ id: row.id, kept: official.get(row.id), dropped: { pkg, rel } })
        official.set(row.id, { pkg, rel, row })
      }
    }
  }

  const verdicts = readdirSync(packagesDir).sort().flatMap((pkg) => {
    const p = join(packagesDir, pkg, 'cordis.patch.yml')
    if (!existsSync(p)) return [{ pkg, verdict: 'NO_PATCH' }]
    return rowsWithId(p).map(({ isInsert, row }) => {
      if (isInsert) {
        // insert 行 id 撞车既有条目(含官方行):宿主 applyPatches 对 insert 目标要求
        // group 语义,撞车即未定义行为;0.1.5 实爆表明 insert 面是从无校验的爆点面
        if (official.has(row.id)) return { pkg, verdict: 'DRIFT', rowId: row.id, reason: `insert id 撞车官方行: ${row.id}` }
        // insert 行 name 字段 = loader entry 导入目标(可含子路径)。运行期解析根是
        // 引用方包自身依赖树(0.1.5-rc.3 boot.log 实锤:彼时注册表缺包 → 宿主硬崩),
        // 静态脚本无法复现注册表历史 → 引用存在性只作信息字段 refCheck,不计入 DRIFT:
        //   closure/profile/packages 命中其一即 'ok',全不命中 'none'(提示人工核对依赖树)
        const ref = typeof row.name === 'string' && row.name !== '' ? row.name : null
        let refCheck = null
        if (ref !== null) {
          const segments = ref.split('/').filter(Boolean)
          const pkgRoot = ref.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
          const roots = [
            ['closure', join(nsDir, ...pkgRoot.split('/'))],
            ['profile', profileDir ? join(profileDir, 'node_modules', ...pkgRoot.split('/')) : null],
            ['packages', join(packagesDir, pkgRoot.replace('@mzzsfy/', ''))],
          ].filter(([, p]) => p !== null && existsSync(p))
          refCheck = { ref: pkgRoot, resolvableIn: roots.length > 0 ? roots[0][0] : 'none' }
        }
        return { pkg, verdict: 'INSERT_ONLY', rowId: row.id, ...(refCheck ? { refCheck } : {}) }
      }
      const off = official.get(row.id)
      if (!off) return { pkg, verdict: 'DRIFT', rowId: row.id, reason: '官方无此行 id(patch: entry not found)' }
      const offKeys = Object.keys(off.row.config ?? {})
      const myKeys = Object.keys(row.config ?? {})
      const missing = offKeys.filter((k) => !myKeys.includes(k))
      const extra = myKeys.filter((k) => !offKeys.includes(k))
      if (missing.length + extra.length) return { pkg, verdict: 'DRIFT', rowId: row.id, officialSource: `${off.pkg}/${off.rel}`, missing, extra }
      const valueChanged = offKeys.filter((k) => JSON.stringify(off.row.config[k]) !== JSON.stringify(row.config[k]))
      const nameGuard = row.name === off.row.name
      return {
        pkg,
        verdict: nameGuard ? 'PASS' : 'WARN',
        rowId: row.id,
        officialSource: `${off.pkg}/${off.rel}`,
        valueChanged,
        ...(nameGuard ? {} : { note: '覆写未携带 name 防御:官方行改名前 id 撞车会误写他方行' }),
      }
    })
  })
  const drift = verdicts.filter((v) => v.verdict === 'DRIFT').length
  const warns = verdicts.filter((v) => v.verdict === 'WARN').length
  return { verdicts, drift, warns, officialDuplicates }
}

function main() {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const [closureDir, packagesDir = fileURLToPath(new URL('../../packages', import.meta.url)), outPath] = argv.filter((a) => a !== '--strict')
  if (!closureDir || !existsSync(join(closureDir, 'node_modules', '@deepseek-ai'))) {
    console.error('[patch-keys] 用法: patch-keys.mjs <闭包根含 node_modules/@deepseek-ai> [packagesDir] [out.json] [--strict]')
    process.exitCode = 2
    return
  }
  const profileDirDefault = join(closureDir, '..', 'home', 'profiles', 'web')
  const { verdicts, drift, warns, officialDuplicates } = patchKeys({ closureDir, packagesDir, profileDir: existsSync(profileDirDefault) ? profileDirDefault : null })
  const result = { closureDir, drift, warns, officialDuplicates, verdicts }
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(result, null, 2))
  }
  console.log(JSON.stringify(result, null, 2))
  // 默认仅 drift 拦截;--strict 档把 WARN(覆写缺 name 防御)与官方 id 重复一并拦截
  process.exitCode = drift || (strict && (warns > 0 || officialDuplicates.length > 0)) ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
