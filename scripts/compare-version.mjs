// prerelease 感知语义版本比较(dev-link hostMin 校验与 compat 装载过滤共用,双消费方同源)
// a<b → -1,a>b → 1,等 → 0;形态不符合返回 null,调用方按无法校验处理(不放行也不阻塞)

/**
 * 核心段允许 3-4 位(x.y.z 或 x.y.z.w,宿主出现过 4 位形态),prerelease 段按
 * '.' 切分逐段比较(数字段数值比,标识段字典比,数字段 > 标识段,同 publish 规则)。
 */
export function compareVersion(a, b) {
  const parse = (v) => {
    const m = /^(\d+(?:\.\d+){2,3})(?:-([0-9A-Za-z.-]+))?$/.exec(v)
    return m ? {core: m[1].split('.').map(Number), pre: m[2] ?? null} : null
  }
  const preKey = (t) => (/^\d+$/.test(t) ? [0, Number(t)] : [1, t])
  const preCmp = (x, y) => {
    const kx = preKey(x)
    const ky = preKey(y)
    return kx[0] !== ky[0] ? kx[0] - ky[0] : kx[1] < ky[1] ? -1 : kx[1] > ky[1] ? 1 : 0
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  const width = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < width; i += 1) {
    if ((pa.core[i] || 0) !== (pb.core[i] || 0)) return Math.sign((pa.core[i] || 0) - (pb.core[i] || 0))
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const xs = pa.pre.split('.')
  const ys = pb.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    if (xs[i] === undefined) return -1
    if (ys[i] === undefined) return 1
    const order = preCmp(xs[i], ys[i])
    if (order !== 0) return order
  }
  return 0
}

/**
 * 宿主版本底线判定:宿主版本或 hostMin 任一缺失、或形态无法比较 → 'skip'(校验跳过,
 * 不放行也不阻塞,与 dev-link 人工链路同语义);宿主 < hostMin → 'fail';其余 → 'pass'。
 */
export function judgeHostMin(hostVersion, hostMin) {
  if (hostVersion === undefined || hostMin === undefined) return 'skip'
  const order = compareVersion(hostVersion, hostMin)
  if (order === null) return 'skip'
  return order < 0 ? 'fail' : 'pass'
}
