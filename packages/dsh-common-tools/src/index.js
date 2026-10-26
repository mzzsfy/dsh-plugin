// dsh-common-tools 宿主入口:仅空 apply(占位条目宿主形态)。
// 本包是普通 npm 依赖而非 dsh 插件:client 半区经消费插件 cordis.patch.yml
// 代挂的占位条目进入客户端模块表;host 半区(setupCommonTools)由消费插件
// 在自己的 apply 里执行。两个半区的机制与契约见 README。
export function apply() {}
