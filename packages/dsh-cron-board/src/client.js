// dsh-cron-board Client 半区:设置页分区(看板 / 环境变量 / 日志 三 Tab)。
// 以 DSH client-modules 自注册格式发布:__ModuleLoader__.load({id, factory}),
// factory(require) 中 require('react') 由 DSH client runtime 模块表解析。
// 数据全部来自本插件 REST 路由 /api/cron-board/*。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-cron-board',
  factory(require) {
    const React = require('react')

    function apply(ctx) {
      void ctx
    }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
