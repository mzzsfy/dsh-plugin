// guard 官方行配置:从宿主 settings.yaml 读官方 `shell` 节,代挂 pwsh-sandbox
// 时透传(Config 消费 pwshPath 等),保持官方执行器配置零感知延续。
// settings.yaml 定位经宿主 dsh-home-paths(官方同构 gateway officialRowConfig,
// 剥离 pi-ai 专属的 compat 键处理——pwsh 配置无此形态)。

/**
 * 读官方 shell 节。
 * @param {() => Promise<object>} readDocument settings.yaml 全文档读取(测试注入)
 * @returns {Promise<object>} 节缺失/读取失败一律空对象(schema 默认顶上)
 */
export async function officialRowConfig(readDocument) {
  try {
    const document = await readDocument()
    const section = document?.shell
    return typeof section === 'object' && section !== null && !Array.isArray(section) ? section : {}
  } catch {
    return {}
  }
}

/**
 * settings.yaml 全文档读取的生产实现:宿主入口依赖树内解析 dsh-home-paths
 * 与 yaml 包,经 realpath 对齐宿主本体树(官方同构;解析链裸 import 会命中
 * 与运行宿主脱钩的副本)。
 */
export async function readSettingsDocument() {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { realpath } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const entry = process.argv[1]
  if (!entry) return {}
  const realEntry = await realpath(entry)
  const require = createRequire(pathToFileURL(realEntry))
  const yamlPath = await realpath(require.resolve('yaml'))
  const { parse } = await import(pathToFileURL(yamlPath).href)
  let home = null
  try {
    const homePaths = await realpath(require.resolve('@deepseek-ai/dsh-home-paths'))
    const resolved = await import(pathToFileURL(homePaths).href)
    home = resolved.resolveDshHome
  } catch {
    home = null
  }
  const filename = typeof home === 'function' ? join(home(), 'settings.yaml') : join(dirname(process.execPath), 'settings.yaml')
  const { readFile } = await import('node:fs/promises')
  return parse(await readFile(filename, 'utf8'))
}

/** 官方包物理路径解析:宿主入口依赖树内定位(官方同构),失败返回 null。 */
export async function resolveFromHostTree(packageName) {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const { realpath } = await import('node:fs/promises')
    const entry = process.argv[1]
    if (!entry) return null
    const realEntry = await realpath(entry)
    const require = createRequire(pathToFileURL(realEntry))
    return await realpath(require.resolve(packageName))
  } catch {
    return null
  }
}
