// dsh-toast Host 半区:无宿主逻辑。本包是普通 npm 依赖(不声明 dsh.bundle.patch,
// 不进 profile 插件层),宿主占位条目由消费插件的 cordis.patch.yml 代挂;cordis
// 装载该条目时经本入口激活空插件,同时使 client 半区进入客户端模块表。

export const name = 'dsh-toast'

export const inject = []

export function apply() {}
