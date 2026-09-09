// client.js 书挡契约:首行 IIFE 开、末行 IIFE 闭;求值前剥壳得可整源求值的函数体。
// 供整源求值类测试统一取数,形态由 client-scope.test.mjs 守卫。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const IIFE_OPEN = '(() => {'
const IIFE_CLOSE = '})()'

export const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')

const source = CLIENT_SOURCE.trimEnd()
if (!source.startsWith(IIFE_OPEN) || !source.endsWith(IIFE_CLOSE)) {
  throw new Error(`client.js 书挡契约破坏:应以 ${IIFE_OPEN} 开、${IIFE_CLOSE} 闭`)
}

export const CLIENT_BODY = source.slice(IIFE_OPEN.length, -IIFE_CLOSE.length).trim()

export const DECLARATION_NAMES = [
  ...new Set(
    [...CLIENT_BODY.matchAll(/^(?:const|function|let) ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1])
  ),
]
