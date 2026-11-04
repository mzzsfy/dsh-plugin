import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createApplication } from '../src/application.mjs'
import { registerRoutes } from '../src/routes.mjs'
import { memoryStorage } from './helpers.mjs'
import { makeSecurity, normalizeQuote } from '../src/market-model.mjs'
const securities = [makeSecurity('XSHG', '600519', '贵州茅台', { cnspell: 'gzmt' }), makeSecurity('XSHE', '000001', '平安银行', { cnspell: 'payh' }), makeSecurity('XSHG', '601318', '中国平安', { cnspell: 'zgpa' })]
const fake = {
  descriptor: { adapterId: 'tushare', capabilities: ['catalog', 'quotes', 'calendar'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20 },
  async probe() { return { status: 'ready' } },
  async catalog(req) { return { items: securities.filter(s => s.exchange === req.market), complete: true } },
  async calendar(req) { return { items: [{ date: new Date().toISOString().slice(0, 10), exchange: req.market, isOpen: true }] } },
  async quotes(req, ctx) { return { items: req.securities.map(s => normalizeQuote({ securityId: s.id, providerInstanceId: req.providerInstanceId, adapterId: 'tushare', providerSymbol: s.code, last: s.code === '600519' ? '1428.00' : '12.16', previousClose: s.code === '600519' ? '1400.00' : '12.40', open: '12.40', high: '12.56', low: '12.10', volume: '135600', amount: '1648896.00', quoteAt: new Date().toISOString(), receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null })) } },
}
const routes = new Map(), counts = {}, listeners = new Set()
const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], env: { DSH_STOCK_TUSHARE_TOKEN: 'fixture-only' }, publish: payload => { for (const res of listeners) res.write(`data: ${JSON.stringify(payload)}\n\n`) } })
registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
const clientUrl = new URL('../src/client.js', import.meta.url)
const commonClient = await readFile(new URL('../../dsh-common-tools/src/client.js', import.meta.url), 'utf8')
const react = await build({ stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; window.React=React; window.createRoot=createRoot", resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') }, bundle: true, write: false, format: 'iife' })
const bootstrap = `
const modules={ react:window.React, 'react-dom/client':{createRoot:window.createRoot} };let cleanup=[];
window.__ModuleLoader__={load(entry){modules[entry.id]=entry.factory(name=>modules[name])}};
`
const setup = `
const plugin=modules['@mzzsfy/dsh-stock-assistant'];
const panelListeners=new Set();let panelId='stock-assistant',main;
const root=window.createRoot(document.getElementById('app'));
const ctx={fiber:{entry:{options:{name:'@mzzsfy/dsh-stock-assistant'}}},effect:fn=>{const stop=fn();cleanup.push(stop);return stop},layout:{panelInfo:{getSnapshot:()=>({activePanelId:panelId}),subscribe:fn=>{panelListeners.add(fn);return()=>panelListeners.delete(fn)}},selectPanel:id=>{panelId=id;panelListeners.forEach(fn=>fn());root.render(id==='stock-assistant'?main:React.createElement('button',{onClick:()=>ctx.layout.selectPanel('stock-assistant')},'打开股票'))}},slots:{inject:(name,fn)=>{fn();return()=>{}},register:(opts,render)=>{if(opts.name==='main')main=render();return()=>{}}}};
plugin.apply(ctx);root.render(main);
window.fixture={selectPanel:ctx.layout.selectPanel,sessionChange:()=>panelListeners.forEach(fn=>fn()),cleanup:()=>cleanup.reverse().forEach(fn=>fn?.())};
`
// 夹具仅替换传输，保留公共包真实快照调度器。
const bridge = `
const realTools=modules['@mzzsfy/dsh-common-tools'];
modules['@mzzsfy/dsh-common-tools/client']={...realTools,setupCommonTools(){return {publish:payload=>fetch('/fixture/demand',{method:'POST',body:JSON.stringify(payload)}),subscribe(fn,{onReset}={}){const events=new EventSource('/fixture/events');events.onmessage=e=>fn(JSON.parse(e.data));events.onopen=()=>onReset?.();return()=>events.close()}}}};
`
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>股票 · 隔离验收夹具</title><style>
:root { --dsw-alias-brand-primary:#2563eb;--dsw-alias-button-primary-hover:#1d4ed8;--dsw-alias-label-primary-inverted:white;--dsw-alias-state-success-primary:#16853c;--dsw-alias-state-warn-primary:#a16207;--dsw-alias-state-error-primary:#c92936;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f5f6f8;--dsw-alias-bg-module-platform:#e5e7eb;--dsw-alias-border-l2:#d1d5db;--dsw-alias-label-primary:#17191c;--dsw-alias-label-secondary:#545b66;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-interactive-bg-hover:#f3f4f6;--dsw-alias-state-business-primary:#2563eb;--ds-font-family-code:monospace; }
html,body,#app{height:100%;margin:0;font-family:system-ui}
html[data-theme=dark]{--dsw-alias-bg-layer-1:#17191c;--dsw-alias-bg-layer-2:#22262c;--dsw-alias-bg-module-platform:#353a42;--dsw-alias-border-l2:#444c57;--dsw-alias-label-primary:#f1f3f5;--dsw-alias-label-secondary:#b6c0ce;--dsw-alias-label-tertiary:#9aa8ba;--dsw-alias-interactive-bg-hover:#303640;--dsw-alias-state-success-primary:#4ade80;--dsw-alias-state-error-primary:#fb7185}
</style></head><body><div id="app"></div><script src="/fixture/react.js"></script><script>${bootstrap}</script><script src="/fixture/common.js"></script><script>${bridge}</script><script src="/fixture/client.js"></script><script>${setup}</script></body></html>`
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname; counts[path] = (counts[path] || 0) + 1
  if (routes.has(path)) return routes.get(path)(req, res)
  if (path === '/fixture/react.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(react.outputFiles[0].text) }
  if (path === '/fixture/common.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(commonClient) }
  if (path === '/fixture/client.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(clientUrl, 'utf8')) }
  if (path === '/fixture/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write(':connected\n\n'); listeners.add(res); req.on('close', () => listeners.delete(res)); return }
  if (path === '/fixture/demand') { let text = ''; for await (const chunk of req) text += chunk; app.demand(JSON.parse(text)); return res.end('{}') }
  if (path === '/fixture/counts') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(counts)) }
  if (path === '/fixture/burst') { for(let i = 0; i < 50; i++) for (const s of listeners) s.write('data: {"type":"invalidate"}\n\n'); return res.end('{}') }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
console.log(`FIXTURE_URL=http://127.0.0.1:${server.address().port}`)
process.on('SIGTERM', async () => { await app.close(); for (const res of listeners) res.end(); server.close(() => process.exit(0)) })
