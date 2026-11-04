# @mzzsfy/dsh-plugin-catalog

mzzsfy/dsh-plugin 全部已发布插件的 DSH 插件市场索引(format 1),每条自带商店图标(data: 内联 SVG)。

## 使用

在 DSH Web 设置的 **Plugins → Discover → Index sources** 中添加:

```
https://cdn.jsdelivr.net/npm/@mzzsfy/dsh-plugin-catalog/index.json
```

或国内镜像同路径:

```
https://registry.npmmirror.com/@mzzsfy/dsh-plugin-catalog/latest/files/index.json
```

添加后 Discover 列表即出现本仓库全部已发布插件,带语义图标;与官方目录(awesome-dsh-plugin)索引共存,本索引额外收录官方目录未收录的包。

## 收录范围

`scripts/catalog-manifest.mjs` 为单一事实源:已发布 npm 的生产插件包(公共依赖库与仅开发态包不在列)。新包发布 npm 后把包名加入该清单并重新构建发布本包。

## 构建与发布

```sh
node scripts/build-catalog.mjs    # 仓库根执行,重生成 packages/dsh-plugin-catalog/index.json
node scripts/publish.mjs dsh-plugin-catalog --bump patch
```

`index.json` 的版本与发布时间取自 npm registry 元数据(非本地时钟),先发布插件包再更新本包;落盘产物由 `tests/store-images.test.mjs` 场景 6 锁定与构建一致,防止过期提交。

## 图标

`assets/icons/<包名>.svg` 由 `scripts/generate-icons.mjs` 从 dsh-settings-nav-icons 内置 glyph 坐标放大生成(16 → 96 视图,描边等比),与插件设置页图标同一视觉语言。校验规则:format 1 data: 内联 SVG 解码后 ≤32KiB,由官方校验器 `@deepseek-ai/dsh-plugin-market-index` 在测试中全量验证。
