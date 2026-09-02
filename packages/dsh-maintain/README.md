# @mzzsfy/dsh-maintain

DeepSeek Harness 设置页插件:版本与进程运维一体化——监测 npm 新版本、一键升级、安全重启。

设计文档见 [docs/design/dsh-maintain.md](../../docs/design/dsh-maintain.md)。

## 功能

- 版本监测:host 启动即检查一次,按轮询间隔重复检查(内存快照,不持久化);当前版本与追踪通道最新版对比,落后即提示。
- 追踪通道:在 npm dist-tags 间切换(latest / next / alpha 等,选项由检查结果动态生成),切换后按新通道判定。
- 一键升级:两段式确认后按自定义命令模板执行,`{tag}` 执行时替换为追踪通道;命令可在设置面板直接查看与编辑,升级期间串行化,超时 10 分钟强杀;成功后自动重新检查并提示重启生效。
- 面板设置编辑:升级命令、轮询间隔、镜像地址均可在面板直接编辑保存,与 settings.yaml 等效(轮询间隔保存即重排,镜像地址保存即重查);空命令与非 http(s) 地址会被拒绝。
- 安全重启:两段式确认后 host 优雅退出(`appExit`,5 秒兜底强制);确认后面板立即提示重启进行中,自动探测宿主恢复并刷新页面。动作路由不做来源判断,访问控制必须由外层鉴权插件(如 dsh-web-startup-auth)统一负责,未部署鉴权插件时动作路由匿名可达。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-maintain
```

标准插件安装:包进入 profile node_modules(pnpm 标准布局,声明的 peer 由虚拟层链入),bundle patch 随下次 dsh 重启自动生效,无需手动编辑 cordis.patch.yml。

发布前开发安装(拷贝进 store,行为与 registry 安装一致):

```sh
dsh plugin --profile web add file:./packages/dsh-maintain
```

注意:勿用 `link:` 或裸相对路径——那是符号链接模式,realpath 后 peer 从仓库目录解析会失败(这正是早期"必须手工拷贝部署"结论的成因,对标准安装不成立)。

## 设置(settings.yaml,热加载)

```yaml
maintain:
  channel: latest                                # 追踪通道,选项以检查返回的 dist-tags 为准
  pollIntervalSec: 21600                         # 轮询间隔秒,仅正数启用周期检查,0/负数禁用
  upgradeCommandTemplate: npm install -g @deepseek-ai/dsh@{tag}   # 可整体自改为任意命令,亦可在设置面板编辑
  registryBase: https://registry.npmjs.org       # 官方源不可达时可改为镜像地址
```

升级命令、轮询间隔、镜像地址三项亦可在设置面板"版本与运维"页直接编辑保存(等效 settings.yaml,热生效)。

## 重启须知

- 重启依赖托管常驻(pm2 / systemd / nssm / Docker 等)自动拉起;手动终端启动的进程不会自动恢复。
- 确认重启后本页自动探测宿主恢复并整页刷新;宿主退出窗口内请求失败属预期,面板显示等待提示。若长时间未恢复(手动终端启动或进程管理器未拉起),请手动刷新排查。
- 重启不检测运行中的 agent:最多 5 秒后强制退出,任务中断;会话已持久化,重开后可 resume。

## 开发

```
cd packages/dsh-maintain && npm test
```
