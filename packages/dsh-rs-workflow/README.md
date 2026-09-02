# @mzzsfy/dsh-rs-workflow

若水工作流 (rs-workflow) 一体化插件：GUI 配置、模型工具与 agent preset（工作流协议技能、编排引擎、模式组合）全部在一个包里。

## 行角色

| 行角色 | 所在平面 | 位置 | 作用 |
|---|---|---|---|
| `settings` | host | 包内 bundle patch（cordis.patch.yml） | 注册 settings 命名空间 `rs-workflow` → GUI 设置页出现表单（八个工作位模型绑定、默认模板、任务上限），持久化于 `~/.dsh/settings.yaml` |
| `preset-sync` | host | 同上 | 每次 dsh 启动把包内 `preset/rs-workflow` 幂等同步到用户预设根 → 模式选择器出现"若水工作流"，升级包后重启即更新 |
| `tool` | agent | 释放出的 preset 组合（agent.cordis.yml） | 注册模型工具 `rs_workflow_config` → 主代理启动工作流编排前读取当前配置；skills/rs-workflow 协议技能（SKILL.md + engine.js 编排引擎 + slots.json5 后备配置）随 preset 一起分发 |

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-rs-workflow
```

重启 dsh 后三件事自动发生：设置页出现 rs-workflow 表单；preset 释放到 `<dsh-home>/.agent-presets/rs-workflow`（含来源标记 `.dsh-rs-workflow-source.json`）；模式选择器出现"若水工作流"。无需手动编辑 cordis.patch.yml，无需手动拷贝 preset。

preset 内 tool 行以裸包名引用本包（从 profile 目录上溯解析到 profile node_modules），包与 preset 始终由本包同时交付，不存在顺序问题。

## 升级

同一命令重复执行即升级到最新发布版本，重启 dsh 后 preset-sync 自动把新版 preset 同步到预设根。

## 卸载

```sh
dsh plugin --profile web remove @mzzsfy/dsh-rs-workflow   # 或 pnpm remove（profile 内）
rm -r ~/.dsh/.agent-presets/rs-workflow
```

pnpm 不执行依赖的卸载脚本（preuninstall，pnpm 11 实测含 onlyBuiltDependencies 白名单均不放行），插件无法在自身被移除后自动清理，preset 残留会在模式选择器显示为 broken——按上面第二条命令手动删除即可。包内亦提供编程接口 `removePreset()`（lib/preset-sync.mjs）。

## 冒烟测试

```sh
node scripts/test-workflow-plugin.mjs
```

默认测已安装副本，传入包目录路径可测任意构建；仓库内副本解析不了 peer 依赖（@deepseek-ai/* 从安装位置向上才找得到），需自备 node_modules。覆盖三个行角色：preset-sync（临时 DSH_HOME 内真实写盘 + 幂等）、settings（分层解析）、tool（执行路径）。

## 行引用方式说明

- 预设组合行的裸包名从组合 baseUrl（profile 目录）上溯 node_modules 解析
  （`PresetTree.import` → `internal.import(specifier, baseUrl)`），profile
  node_modules 在解析链上，所以预设行用裸 scoped 包名。
- host 补丁行（bundle patch）的裸包名从安装锚点 / profile node_modules 解析，
  两条链一致，补丁行同样用裸包名。
- preset 技能发现走 skill-filesystem 的 `customSkillDirs`，以组合 `baseUrl`
  （= 释放出的 preset 目录）定位 `skills/`，随 preset 同步走。

## License

MIT
