// global 浮层轮询指纹缓存 BDD:stat 指纹命中不重复读盘,产物变更即失效,
// 删除/损坏文件与目录缺失不残留缓存条目。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, utimes, rm, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listWorkspaceCachesCached } = await import('../src/history-cache.mjs')

async function makeDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sm-fp-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeCache(dir, name, cwd, entries, mtime) {
  const file = join(dir, name)
  await writeFile(file, JSON.stringify({ cwd, entries }), 'utf8')
  if (mtime !== undefined) await utimes(file, mtime, mtime)
  return file
}

test('指纹命中:产物未变时复用解析结果,内容对象同引用', async (t) => {
  const dir = await makeDir(t)
  await writeCache(dir, 'a-1.json', 'C:\\a', [{ sid: 's1', text: 'x' }])
  const first = await listWorkspaceCachesCached(dir)
  assert.equal(first.length, 1)
  assert.equal(first[0].cwd, 'C:\\a')
  // When 再次读取(文件未动)
  const second = await listWorkspaceCachesCached(dir)
  // Then 指纹命中,返回缓存中的同一解析对象
  assert.equal(second[0], first[0])
})

test('指纹失效:文件内容变更后重读,新内容可见', async (t) => {
  const dir = await makeDir(t)
  const stamp = new Date()
  const file = await writeCache(dir, 'b-1.json', 'C:\\b', [{ sid: 's1', text: 'old' }], stamp)
  const first = await listWorkspaceCachesCached(dir)
  assert.equal(first[0].entries[0].text, 'old')
  // When 追加条目并推进 mtime(写入侧经临时文件改名,mtime 必变)
  await writeFile(file, JSON.stringify({ cwd: 'C:\\b', entries: [{ sid: 's1', text: 'old' }, { sid: 's2', text: 'new' }] }), 'utf8')
  const later = new Date(stamp.getTime() + 2000)
  await utimes(file, later, later)
  const second = await listWorkspaceCachesCached(dir)
  // Then 新内容可见
  assert.equal(second[0].entries.length, 2)
  assert.equal(second[0].entries[1].text, 'new')
})

test('卫生:文件删除与目录缺失清空对应缓存', async (t) => {
  const dir = await makeDir(t)
  const file = await writeCache(dir, 'c-1.json', 'C:\\c', [])
  await listWorkspaceCachesCached(dir)
  // When 删除文件后再读
  await rm(file)
  const afterRemove = await listWorkspaceCachesCached(dir)
  // Then 结果为空(目录仍在,缓存条目清除)
  assert.deepEqual(afterRemove, [])
  // When 目录整个消失(缓存目录被手工清理)
  await rm(dir, { recursive: true, force: true })
  const afterDirGone = await listWorkspaceCachesCached(dir)
  // Then 返回空数组不抛
  assert.deepEqual(afterDirGone, [])
  // 目录恢复后缓存可重建
  await mkdir(dir, { recursive: true })
  assert.deepEqual(await readdir(dir), [])
  await writeCache(dir, 'd-1.json', 'C:\\d', [{ sid: 's9', text: 'fresh' }])
  const rebuilt = await listWorkspaceCachesCached(dir)
  assert.equal(rebuilt.length, 1)
  assert.equal(rebuilt[0].entries[0].text, 'fresh')
})

test('过滤:损坏文件与 prompts.json 不进结果', async (t) => {
  const dir = await makeDir(t)
  await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
  await writeFile(join(dir, 'prompts.json'), JSON.stringify({ items: [] }), 'utf8')
  await writeCache(dir, 'ok-1.json', 'C:\\ok', [])
  const caches = await listWorkspaceCachesCached(dir)
  assert.equal(caches.length, 1)
  assert.equal(caches[0].cwd, 'C:\\ok')
})
