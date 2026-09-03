#!/usr/bin/env node
// bin 入口:main() 显式调用而非 argv[1] 直判(Windows 路径分隔符导致误判,见参考实现 issue #8)
import { main } from '../src/index.mjs'

main().catch((error) => {
  process.stderr.write(`[agent-shell] fatal: ${String(error?.stack || error)}\n`)
  process.exit(1)
})
