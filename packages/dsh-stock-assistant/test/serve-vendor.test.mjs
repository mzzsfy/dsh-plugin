import test from 'node:test'
import assert from 'node:assert/strict'
import { serveVendor, VENDOR_FILE, VENDOR_PREFIX } from '../src/serve-vendor.mjs'

const res = () => {
  const out = { headers: null, body: null, status: null, ended: false }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers }
  out.end = body => { out.body = body; out.ended = true }
  return out
}

test('serveVendor 白名单命中 200 与缓存头, 未命中 404', () => {
  const ok = res()
  serveVendor({ url: `${VENDOR_PREFIX}/${VENDOR_FILE}` }, ok)
  assert.equal(ok.status, 200)
  assert.match(ok.headers['Content-Type'], /javascript/)
  assert.ok(ok.headers['Cache-Control'].includes('max-age'))
  const miss = res()
  serveVendor({ url: `${VENDOR_PREFIX}/../package.json` }, miss)
  assert.equal(miss.status, 404)
  const root = res()
  serveVendor({ url: `${VENDOR_PREFIX}/` }, root)
  assert.equal(root.status, 404)
})
