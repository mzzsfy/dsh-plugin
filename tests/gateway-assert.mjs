// 留档断言工具:解析 echo-upstream jsonl,对最近 N 条 /v1/messages|chat/completions 跑 B1 断言
// 用法:node tests/gateway-assert.mjs --protocol anthropic|openai --last 1 --log <jsonl> [--session <id>] [--expect-affinity true|false]
import { readFileSync } from 'node:fs'

const args = {}
for (let i = 0; i < process.argv.length; i += 2) {
  if (process.argv[i]?.startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1]
}
const protocol = args.protocol ?? 'anthropic'
const last = Number(args.last ?? 1)
const expectAffinity = (args['expect-affinity'] ?? 'true') === 'true'

const MARKER_PATTERN = /^dsh:[0-9a-f]{40}$/
const pathNeedle = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'

const entries = readFileSync(args.log, 'utf8')
  .split('\n').filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.path.includes(pathNeedle))
const targets = entries.slice(-last)
if (targets.length === 0) {
  console.error(`FAIL: 留档无 ${pathNeedle} 请求`)
  process.exit(1)
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ` | ${detail}` : ''}`) }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` | ${detail}` : ''}`) }
}

for (const [index, entry] of targets.entries()) {
  const tag = targets.length > 1 ? `#${index + 1}` : ''
  const headers = entry.headers
  const body = entry.body ?? {}
  console.log(`--- ${entry.at} ${entry.path} ${tag}`)

  if (protocol === 'anthropic') {
    const marker = body.metadata?.user_id
    check('metadata.user_id 派生标记', MARKER_PATTERN.test(marker), marker ?? '(缺失)')
    if (expectAffinity) {
      check('x-session-affinity 裸 sessionId', typeof headers['x-session-affinity'] === 'string' && headers['x-session-affinity'].length > 0 && !headers['x-session-affinity'].startsWith('session-') === false, headers['x-session-affinity'] ?? '(缺失)')
      check('x-session-affinity 不含派生标记', !String(headers['x-session-affinity'] ?? '').includes('dsh:'))
    } else {
      check('cacheRetention:none 抑制 x-session-affinity', headers['x-session-affinity'] === undefined, String(headers['x-session-affinity'] ?? '(在场)'))
    }
    check('anthropic-version 在场', typeof headers['anthropic-version'] === 'string' && headers['anthropic-version'].length > 0, headers['anthropic-version'] ?? '(缺失)')
    check('x-api-key 为路由 apiKeyEnv 解析值', headers['x-api-key'] === 'test-key', headers['x-api-key'] ?? '(缺失)')
    check('静态头 x-gateway-group', headers['x-gateway-group'] === 'pool-a-anth', headers['x-gateway-group'] ?? '(缺失)')
  } else {
    check('prompt_cache_key 派生标记', MARKER_PATTERN.test(body.prompt_cache_key), body.prompt_cache_key ?? '(缺失)')
    check('metadata 不上 wire', body.metadata === undefined, body.metadata ? JSON.stringify(body.metadata) : '无 metadata 键')
    if (expectAffinity) {
      // openai 系亲和:body.session_id 或头 session_id 形态二选一(宿主版本语义差异),两者都记录
      const session = body.session_id ?? headers.session_id
      check('session_id(body 或头)', typeof session === 'string' && session.length > 0, session ?? '(双处缺失)')
      check('x-client-request-id', typeof headers['x-client-request-id'] === 'string' && headers['x-client-request-id'].length > 0, headers['x-client-request-id'] ?? '(缺失)')
      check('x-session-affinity', typeof headers['x-session-affinity'] === 'string' && headers['x-session-affinity'].length > 0, headers['x-session-affinity'] ?? '(缺失)')
    } else {
      check('none 抑制亲和头', headers['x-session-affinity'] === undefined && body.session_id === undefined && headers.session_id === undefined, '亲和三态应全缺')
    }
    check('静态头 x-gateway-group', headers['x-gateway-group'] === 'pool-a', headers['x-gateway-group'] ?? '(缺失)')
    check('无 retention 副作用字段', !('prompt_cache_retention' in body) && !('cache_retention' in body), '应无 retention 键')
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
