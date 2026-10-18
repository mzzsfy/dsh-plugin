import { readFile, writeFile, mkdir, realpath, lstat, readlink, symlink, unlink, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, relative, dirname, sep, isAbsolute } from 'node:path'

const PACKAGE_NAME = '@deepseek-ai/dsh'
const LINK_NAME = 'dsh_link'
const PACKAGE_PARTS = ['node_modules', '@deepseek-ai', 'dsh']
const samePath = (a, b, platform = process.platform) => platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

async function optionalStat(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function linkMatches(layout, target) {
  try {
    const info = await optionalStat(layout.link)
    return Boolean(target && info?.isSymbolicLink() && samePath(await realpath(layout.link), target, layout.platform))
  } catch {
    return false
  }
}


async function assertRealDirectory(path) {
  const info = await optionalStat(path)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('必须为真实目录，不能是链接: ' + path)
}

export async function createLayout({ prefix, originalPackage, platform = process.platform }) {
  const canonicalPrefix = await realpath(prefix)
  const canonicalPackage = await realpath(originalPackage)
  const expected = platform === 'win32'
    ? join(canonicalPrefix, ...PACKAGE_PARTS)
    : join(canonicalPrefix, 'lib', ...PACKAGE_PARTS)
  if (!samePath(canonicalPackage, expected)) throw new Error('不支持的全局安装布局: ' + canonicalPackage)
  const manifest = JSON.parse(await readFile(join(canonicalPackage, 'package.json'), 'utf8'))
  const bin = manifest.bin?.dsh
  if (manifest.name !== PACKAGE_NAME || typeof bin !== 'string' || !bin || isAbsolute(bin) || bin.includes('\\') || bin.split('/').some(p => p === '..' || p === '.' || !p)) {
    throw new Error('DSH bin入口无效')
  }
  const root = join(canonicalPrefix, '.dsh-maintain')
  await assertRealDirectory(root)
  const layout = {
    prefix: canonicalPrefix, originalPackage: canonicalPackage, platform, bin,
    root, a: join(root, 'install-a'), b: join(root, 'install-b'),
    link: join(canonicalPackage, LINK_NAME),
    entryPaths: platform === 'win32'
      ? ['dsh', 'dsh.cmd', 'dsh.ps1'].map(n => join(canonicalPrefix, n))
      : [join(canonicalPrefix, 'bin', 'dsh')],
  }
  return Object.freeze(layout)
}

async function selectedPackage(layout) {
  const info = await optionalStat(layout.link)
  if (!info) return null
  if (!info.isSymbolicLink()) throw new Error('dsh_link不是预期目录链接: ' + layout.link)
  const target = await realpath(layout.link)
  if (![layout.a, layout.b].some(slot => samePath(target, join(slot, ...PACKAGE_PARTS)))) throw new Error('dsh_link指向未知安装目录')
  return target
}

export async function readSelectedVersion(layout) {
  const pkg = await selectedPackage(layout)
  if (!pkg) return null
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  if (manifest.name !== PACKAGE_NAME) throw new Error('链接目标不是DSH')
  return manifest.version
}

async function entryChanges(layout) {
  const originalBin = join(layout.originalPackage, layout.bin)
  const managedBin = join(layout.link, layout.bin)
  const changes = []
  for (const path of layout.entryPaths) {
    const info = await optionalStat(path)
    if (!info) continue
    if (layout.platform !== 'win32') {
      if (!info.isSymbolicLink()) throw new Error('未知npm命令入口，必须是symlink: ' + path)
      const before = await readlink(path)
      const target = resolve(dirname(path), before)
      if (!samePath(target, originalBin) && !samePath(target, managedBin)) throw new Error('未知npm入口目标: ' + path)
      changes.push({ path, kind: 'symlink', before, after: relative(dirname(path), managedBin), managed: samePath(target, managedBin) })
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('未知npm shim入口: ' + path)
    const before = await readFile(path, 'utf8')
    const oldSuffix = 'node_modules/@deepseek-ai/dsh/' + layout.bin
    const newSuffix = 'node_modules/@deepseek-ai/dsh/' + LINK_NAME + '/' + layout.bin
    const normalized = before.replaceAll('\\', '/')
    const hasOld = normalized.includes(oldSuffix)
    const hasNew = normalized.includes(newSuffix)
    if ((!hasOld && !hasNew) || (hasOld && hasNew)) throw new Error('未知或混合npm shim入口: ' + path)
    if (hasNew) {
      changes.push({ path, kind: 'file', before, after: before, mode: info.mode, managed: true })
      continue
    }
    const after = before.replaceAll(oldSuffix, newSuffix).replaceAll(oldSuffix.replaceAll('/', '\\'), newSuffix.replaceAll('/', '\\'))
    if (after === before) throw new Error('无法改写npm shim入口: ' + path)
    changes.push({ path, kind: 'file', before, after, mode: info.mode, managed: false })
  }
  if (!changes.length) throw new Error('未发现npm dsh命令入口')
  if (layout.platform === 'win32' && !changes.some(c => c.path.endsWith('.cmd'))) throw new Error('缺少npm cmd入口')
  if (changes.some(c => c.managed) && changes.some(c => !c.managed)) throw new Error('命令入口接管状态不一致')
  return changes
}

export async function selectInactiveSlot(layout, runningPackage) {
  await assertRealDirectory(layout.root)
  const running = await realpath(runningPackage)
  const selected = await selectedPackage(layout)
  const entries = await entryChanges(layout)
  const managed = entries.every(c => c.managed)
  if (samePath(running, layout.originalPackage)) {
    if (managed) throw new Error('命令已切换但旧宿主未退出，运行路径不一致')
    return selected && samePath(selected, join(layout.a, ...PACKAGE_PARTS)) ? layout.b : layout.a
  }
  if (!managed || !selected || !samePath(running, selected)) throw new Error('运行路径、入口与链接不一致')
  return samePath(running, join(layout.a, ...PACKAGE_PARTS)) ? layout.b : layout.a
}

async function assertSlotTree(slot) {
  await assertRealDirectory(slot)
  for (const path of [join(slot, 'node_modules'), join(slot, 'node_modules', '@deepseek-ai'), join(slot, ...PACKAGE_PARTS)]) {
    const info = await optionalStat(path)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('安装树路径不能是链接或非目录: ' + path)
  }
}

async function removeOwnedTree(path, boundary, platform) {
  const root = resolve(boundary)
  const target = resolve(path)
  const separator = platform === 'win32' ? '\\' : sep
  if (target !== root && !(platform === 'win32' ? target.toLowerCase().startsWith((root + separator).toLowerCase()) : target.startsWith(root + separator))) throw new Error('清理路径越界: ' + target)
  const info = await optionalStat(target)
  if (!info) return
  if (info.isSymbolicLink()) {
    await unlink(target)
    return
  }
  await rm(target, { recursive: info.isDirectory(), force: true })
}

export async function clearInactiveSlot(layout, slot, runningPackage, { activePackages = [] } = {}) {
  if (![layout.a, layout.b].some(p => samePath(p, slot))) throw new Error('禁止清理未知目录')
  await assertRealDirectory(layout.root)
  await assertSlotTree(slot)
  const running = await realpath(runningPackage)
  const selected = await selectedPackage(layout)
  const pkg = join(slot, ...PACKAGE_PARTS)
  if ([running, selected, ...activePackages].filter(Boolean).some(p => samePath(p, pkg))) throw new Error('目录仍被运行进程或链接引用')
  await removeOwnedTree(slot, layout.root, layout.platform)
  await mkdir(slot, { recursive: true })
}

async function applyEntryChange(change, content, current, temp, platform) {
  if (current && !current.isSymbolicLink()) throw new Error('命令入口在切换期间被替换为非链接: ' + change.path)
  await symlink(content, temp)
  if (await readlink(temp) !== content) throw new Error('命令入口链接读回失败')
  if (platform === 'win32' && current) await unlink(change.path)
  await rename(temp, change.path)
}

async function writeEntry(change, restore = false, platform = process.platform) {
  const content = restore ? change.before : change.after
  if (change.kind === 'file') {
    await writeFile(change.path, content, { mode: change.mode })
    if (await readFile(change.path, 'utf8') !== content) throw new Error('命令入口读回失败')
    return
  }
  const temp = change.path + '.maintain-next'
  if (await optionalStat(temp)) throw new Error('残留临时命令入口: ' + temp)
  try {
    const current = await optionalStat(change.path)
    await applyEntryChange(change, content, current, temp, platform)
  } finally { if (await optionalStat(temp)) await unlink(temp) }
}

export async function switchLink(layout, target, symlinkImpl = symlink) {
  const info = await optionalStat(layout.link)
  if (info && !info.isSymbolicLink()) throw new Error('dsh_link不是目录链接')
  if (!target) { if (info) await unlink(layout.link); return }
  const before = await selectedPackage(layout)
  if (layout.platform === 'win32') {
    if (info) await unlink(layout.link)
    try {
      await symlinkImpl(target, layout.link, 'junction')
      if (!samePath(await realpath(layout.link), target, layout.platform)) throw new Error('dsh_link读回失败')
    } catch (error) {
      if (before) {
        try {
          if (await optionalStat(layout.link)) await unlink(layout.link)
          await symlinkImpl(before, layout.link, 'junction')
        } catch {}
        error.rollbackFailed = !(await linkMatches(layout, before))
      }
      throw error
    }
    return
  }
  const temp = layout.link + '.next'
  if (await optionalStat(temp)) throw new Error('残留临时链接: ' + temp)
  try {
    const current = await optionalStat(layout.link)
    if (current && !current.isSymbolicLink()) throw new Error('dsh_link在切换期间被替换为非链接')
    await symlinkImpl(target, temp, 'dir')
    if (layout.platform === 'win32' && current) await unlink(layout.link)
    await rename(temp, layout.link)
    if (!samePath(await realpath(layout.link), target, layout.platform)) throw new Error('dsh_link读回失败')
  } catch (error) {
    if (before) error.rollbackFailed = !(await linkMatches(layout, before))
    throw error
  } finally { if (await optionalStat(temp)) await unlink(temp) }
}

export async function activateInstallation(layout, candidatePackage, { runningPackage, writeEntryImpl = writeEntry, switchLinkImpl = switchLink, symlinkImpl = symlink } = {}) {
  const candidate = await realpath(candidatePackage)
  const expectedSlot = await selectInactiveSlot(layout, runningPackage)
  if (!samePath(candidate, join(expectedSlot, ...PACKAGE_PARTS))) throw new Error('候选不在空闲安装目录')
  await assertRealDirectory(expectedSlot)
  const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
  if (manifest.name !== PACKAGE_NAME || manifest.bin?.dsh !== layout.bin) throw new Error('候选bin入口路径变化')
  const cli = join(candidate, layout.bin)
  if (!(await stat(cli)).isFile() || !samePath(await realpath(cli), cli)) throw new Error('候选bin不是预期真实文件')
  const changes = await entryChanges(layout)
  const before = await selectedPackage(layout)
  const applied = []
  await mkdir(join(layout.root, 'log'), { recursive: true })
  await writeFile(join(layout.root, 'log', 'entries.json'), JSON.stringify(changes))
  try {
    await switchLinkImpl(layout, candidate, symlinkImpl)
    for (const change of changes.filter(c => !c.managed)) {
      applied.push(change)
      await writeEntryImpl(change, false, layout.platform)
    }
    if (!samePath(await realpath(layout.link), candidate)) throw new Error('链接目标读回失败')
    return { slot: samePath(expectedSlot, layout.a) ? 'a' : 'b', version: manifest.version, candidatePackage: candidate }
  } catch (error) {
    const failures = []
    for (const change of applied.reverse()) { try { await writeEntryImpl(change, true, layout.platform) } catch (e) { failures.push(e.message) } }
    try { await switchLinkImpl(layout, before, symlinkImpl) } catch (e) { failures.push(e.message) }
    if (before && !(await linkMatches(layout, before))) failures.push('恢复后的dsh_link目标与原目标不符')
    if (!before && await optionalStat(layout.link)) failures.push('恢复后的dsh_link应为空')
    if (failures.length) {
      error.message += '; 恢复失败: ' + failures.join('; ')
      error.rollbackFailed = true
    } else {
      error.rollbackFailed = false
    }
    throw error
  }
}
