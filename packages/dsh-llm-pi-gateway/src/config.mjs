// 装饰器形态的常量:本包 settings 节名与官方行 id。路由解析/compat 名单等
// 接管形态逻辑已随装饰器重构退役。

// 本包 settings 命名空间(仅承载 sessionMarker 配置)
export const SETTINGS_NS = 'llm-pi-gateway'

// 官方行 id(loader 行树;其 settings 节由官方行自服务,本包不消费)
export const OFFICIAL_ROW_ID = 'llm-pi-ai'

// 官方行 id 解析候选前缀:宿主把 profile 行树经 cordis:include 行挂载
// (分隔符 EntryTree.sep = ":"),受控行的实际解析 id 带前缀;空串覆盖裸树形态
export const ROW_ID_PREFIXES = ['include:', '']
