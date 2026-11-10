// dsh-common-tools 宿主入口:仅空 apply(装载行宿主形态,多行合并成多个空条目)。
// 本包是普通 npm 依赖而非 dsh 插件:client 半区经每个消费插件 cordis.patch.yml
// 自带的装载行进入客户端模块表,宿主按包名合并成单份;host 半区(setupCommonTools)
// 由消费插件在自己的 apply 里执行。两个半区的机制与契约见 README 与
// DEVELOPMENT/client-dependency.md。
export function apply() {}
