// dsh-auto-trust-all Client 半区:仅向 dsh-settings-nav-icons 声明插件图标,
// 无任何 UI 与行为;宿主非 web 环境(无 window/__ModuleLoader__)整段跳过。
// 声明经 nav-icons 契约样板锁定,改样板须同步其 orchestration 测试。

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: '@mzzsfy/dsh-auto-trust-all',
    factory() {
      // 键 = 市场短名(发现页收录显示形态);nav-icons 未就绪时入队,由其启动时排空
      const NAV_ICON = { 'dsh-auto-trust-all': 'shield' }
      if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
      else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
      else window.__navicIconQueue = [NAV_ICON]
      // 浏览器 cordis loader 装载经裸名 id 取本记录,空 apply 为合法装载最小形态
      return { apply() {} }
    },
  })
}
