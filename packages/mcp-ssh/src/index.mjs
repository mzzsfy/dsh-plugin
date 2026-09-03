// 对外入口:main 供 bin 调用;start/createCore 供测试与嵌入方(如 DSH 插件)编程复用
export { main, start, createCore, SERVER_INFO } from './server.mjs'
export { createGuard } from './guard.mjs'
export { createTools, TOOL_DEFINITIONS } from './tools.mjs'
export { createControl } from './control.mjs'
export { discoverHosts } from './ssh-config.mjs'
export { runLocal, spawnShell, killTree, createCapture } from './exec.mjs'
export { createSessions, SESSION_LIMIT, SESSION_IDLE_MS } from './session.mjs'
export { DEFAULT_CONFIG, BUILTIN_BLACKLIST, mergeConfig, homeDirOf, configPathOf } from './config.mjs'
