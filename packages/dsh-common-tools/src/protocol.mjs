// 帧协议版本:host 与 client 必须同值——单边抬高而另一端未同批抬,hello 协商即无交集,
// client 只留一条 console 告警就停用总线(页面静默失联)。
// client 是浏览器单文件模块,不能 import 本包文件,其字面量由 test/protocol.test.mjs
// 与本文件互锁;host 半区直接 import 本文件,不再本地声明。改动帧集合即递增本常量。
export const PROTOCOL = 1

// host 回报给 client 的支持集:多版本共存期在此追加,单值协议语义不变
export const SUPPORTED_PROTOCOLS = Object.freeze([PROTOCOL])
