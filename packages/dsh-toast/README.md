# @mzzsfy/dsh-toast

DSH 全局浮出通知 Toast 库:多条并存栈式展示,自动消失与常驻确认两种生命周期。供各插件发送全局操作反馈与事件通知,替代各插件自写通知 UI。

**本包是普通 npm 依赖,不是 dsh 插件**:不声明 `dsh.bundle.patch`,不进 profile 插件层,无需也不应 `dsh plugin add`。消费插件在 `dependencies` 中声明本包(pnpm 随装),并在自身 `cordis.patch.yml` 中代挂本包宿主占位条目使 client 进入客户端模块表。

## 消费方接入

1. `package.json`:

```json
{
  "dependencies": { "@mzzsfy/dsh-toast": "^0.1.0" },
  "dsh": {
    "client": {
      "external": ["@mzzsfy/dsh-toast/client"]
    }
  }
}
```

2. `cordis.patch.yml`(insert 列表追加一条,使本包 client 进入模块表;id 必须带消费插件前缀,多个消费插件共存时树内 id 不冲突,name 才是包解析键):

```yml
- insert:
    - id: <本插件 id>
      name: '@mzzsfy/<本包名>'
    - id: <本插件 id>-dsh-toast
      name: '@mzzsfy/dsh-toast'
```

3. client.js 的 factory 内:

```js
const { show: toast } = require('@mzzsfy/dsh-toast/client')

toast('已保存', { kind: 'ok' })                    // 成功反馈,自动消失
toast('保存失败:' + reason, { kind: 'error', sticky: true }) // 常驻待确认
toast('回合完成', { holdMs: 6 * 1000 })            // 自定义展示期
```

## API

- `show(text, opts)` → `id`:入栈一条通知。`opts.kind` 为 `'info' | 'ok' | 'error'`(非法归 `info`,默认深色 / 成功绿 / 错误红);`opts.sticky` 真值常驻不自动消失,渲染「知道了」按钮;`opts.holdMs` 正数自定义展示期(默认 4 秒)。`text` 非字符串或为空时忽略并返回 `null`
- `dismiss(id)`:移除指定条目,幂等
- `mount()`:显式挂载渲染容器(一般无需调用,首次 `show` 惰性自举)

## 行为规格(BDD)

- Given 库已加载,When `show(text)`,Then 通知顶部居中显示,默认 4 秒后自动消失
- Given 栈内已有 4 条,When 再入栈一条,Then 最旧条目立即移除(含 sticky,新通知优先)
- Given `show(text, {sticky: true})`,Then 通知常驻,点「知道了」或 `dismiss(id)` 后消失
- Given `kind: 'error'`,Then 红色变体渲染
- Given 首次 `show`,Then 渲染容器与样式惰性挂载(容器直挂 body,不受设置页全屏层 z-index 遮挡)
- Given HMR 重载产生同 id 旧容器,When 新代首次挂载,Then 旧容器移除、新容器就位
- Given 用户系统开启减弱动态效果,Then 入场动画禁用

## 实现说明

- 位置顶部居中:不遮挡聊天输入区;容器直挂 body,层级高于设置全屏层
- 样式全部取宿主 `--dsw-alias-*` 令牌(错误变体文字色除外),双主题自适应;样式挂宿主文档级、幂等且内容变化原位替换
- store 位于模块闭包单例;渲染容器惰性自举、幂等、自愈(旧 root 卸载后重建),不依赖宿主生命周期
- react / react-dom/client 由宿主平台模块表提供,peerDependencies 声明 react 与 react-dom
