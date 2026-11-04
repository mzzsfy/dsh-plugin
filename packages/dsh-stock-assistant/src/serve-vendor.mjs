// vendor 静态服务: prefix 路由白名单单文件; 命中读盘 200, 未命中/读异常 404。
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
export const VENDOR_FILE = 'lightweight-charts.standalone.production.js'
const VENDOR_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', VENDOR_FILE)
export const VENDOR_PREFIX = '/plugins-vendor/dsh-stock-assistant'
const VENDOR_MAX_AGE = 24 * 60 * 60
// 预判定: 文件存在且非空才声明 vendorAvailable(先于应用构建, 随快照下发)
export function vendorReadable() {
  statSync(VENDOR_PATH)
  return readFileSync(VENDOR_PATH).length > 0
}
export function serveVendor(req, res) {
  const target = new URL(req.url, 'http://local').pathname.slice(VENDOR_PREFIX.length).replace(/^\//, '')
  if (target !== VENDOR_FILE) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
  try {
    const body = readFileSync(VENDOR_PATH)
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': `public, max-age=${VENDOR_MAX_AGE}`, 'Content-Length': body.length })
    res.end(body)
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found') }
}
