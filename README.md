# 模型上下文预算

独立可移除的 DSH 0.2.2-rc.2 界面插件。入口位于左侧，目标为主区域插件页；返回会话不改变当前会话。源码、测试、构建脚本与界面资源在同一个独立 Git 仓库中维护。

## 使用

打开一个会话，从左侧进入「模型上下文预算」。页面只读取当前会话所选供应商的模型配置与当前 Agent 实际挂载的官方 BasicCompactionEngine 策略。选定该供应商的目标模型，输入正整数阈值 T，计算并预览。勾选确认后才写入目标模型 contextWindow，随后回读官方配置及适配器生效值。

- 阈值：`floor(min(r × W, W − O − B))`。
- 反算：`W = ceil(max(T / r, T + O + B))`，必须代回与 T 一致。
- 近期原文保留：固定 `retainTokens`，或 `floor((W − O) × retainRatio)`；必须小于阈值。
- O 只来自 `llm.resolveModelInfo(...).defaultMaxTokens ?? 0`。目录输出能力 maxTokens 不作为 O。
- 自动压缩关闭时明确标识：显示的是策略预算，不会自动启用。

## 已核验接口与边界

Host 使用官方 `llm.listConfigurableProviders()` 的 settingsNs/settingsPath，`settingsController.describe()` 读配置，`settingsController.mutate(ns, [{ op: 'set', path, value }], revision)` 只改一个字段。写前重读配置、会话选择、模型元数据和 preset 策略，预览失效或配置 revision 变化时拒绝。保存后回读；若提交后回读失败明确告知，绝不自动重试或回滚。

已核验供应商规则：

- 官方 pi-ai 配置：非空 models 数组时写该模型索引的 contextWindow；否则写 modelOverrides 中的目标 ID。仅通过 `{provider}` 调用官方本地目录发现，绝不提供 baseURL、apiKey 或发起自定义网关探测。能力顺序为模型配置 → 同 ID 已安装目录 → 官方有效配置的能力回退值。
- DeepSeek API key：只写有效配置 models 数组中现存目标的 contextWindow。仅出现在动态目录、未在可寻址配置 models 中的模型只读。
- DeepSeek Account：写 `modelOverrides.<ID>.contextWindow`。目录能力未公开且没有显式配置时标为未知，不以请求预留冒充目录能力。
- 其他适配器/未识别压缩引擎：不猜测覆盖语义或预算，明确只读/不可计算。

所选模型及 preset 来自 live Agent 和 `agentPresets.serviceFor(agent, 'compaction')`。没有已加载 Agent 时不恢复它，提示返回会话打开再刷新。不会取 Host 的 inactive compaction 配置代替实际 preset。

会话请求 maxTokens 覆盖、路由变化与在途请求可能使实际阈值不同。更改影响当前 profile 中该模型的后续请求，非仅当前会话。此插件不运行压缩、不修改官方压缩策略、不改变模型选择、不触碰凭据，不添加定时任务或其他数据源。确认操作仅供官方 Connection 的当前 browserPeer 使用；只读 `model_context_budget` 工具可查询/反算，但不返回确认 token、不干扰用户预览、不能保存配置。

RPC 使用插件独占的 `/api/local-model-context-budget/budget` 路径，通过 `connection.fetch.register()` 精确路由，保留官方 Client RPC 信封与错误反馈。由官方载体执行 Host/Origin/认证检查，并再次通过 `connection.admit()` 确认调用者是 browserPeer；不占用官方 Gateway 的唯一 interceptor。当前安装版 `connection.rpc.handle()` 的内部服务作用域无法读取 webServer，因此不采用该注册方式，也不修改官方包或配置。反算窗口高于当前声明值时提示核实端点真实容量；公式计算不意味着端点支持该容量。

所有 UI 注册均属于本插件生命周期：`sidebar.panellist` 入口与唯一 `main` key，以及本页独占的 session-maybe 子槽。卸载只移除本插件的 UI；仅当本页仍被选中时返回会话，不关闭其他页面。草稿仅在插件存活的内存中保留；正式配置仅保存在官方 profile 服务。

## 构建

```sh
npm test
npm run build
```

测试由主 Agent 编写，覆盖官方预算边界、默认输出预留与目录能力区分、只读预览、目标字段保存、冲突/回读失败、孤立配置条目、只读工具与用户确认隔离，以及实际安装版 Connection 在真实同级插件作用域中的精确路由共存、认证和撤回。配置写回使用公开协议 fixture，不访问或修改真实 profile；通道测试加载当前 DSH 安装包，需要 `DSH_INSTALL_DIR` 指向该安装。

不需要下载依赖。构建导出 Host、预算模块与 lazy Client entry，校验 manifest/patch/locale 键与 JavaScript 语法。发布内容仅含 dist、locale、原始图标及包说明；不存在外部 symlink 或源目录运行时依赖。

## 仓库维护与本地安装

建议 GitHub 仓库名为 `dsh-model-context-budget`。版本管理保留源码、测试、构建脚本、manifest、Loader patch、语言资源、图标和 LICENSE；生成产物 `dist/`、依赖目录、日志、打包文件与本地环境文件不入库。

克隆仓库后，使用 Node.js 24.9 或以上版本运行 `npm run build`，再通过 DSH 的 **Plugins → Add plugin** 选择本地仓库目录安装。无需下载项目依赖，也不需要新增安装脚本。发布包之前同样先构建，再用 `npm pack --dry-run` 检查运行文件是否齐全。

长期维护的稳定包名为 `@local/model-context-budget`，Loader entry ID 为 `@local/model-context-budget:budget`，Client 页面 key 为 `@local/model-context-budget:page`。GitHub 仓库名与 npm 包名可以不同。后续迭代保持这些身份不变，修改源码、递增 manifest 版本并重新构建；构建脚本不锁定发布版本。

### 从自动生成包迁移

1.0.1 将旧包 `@dsh-local/view-559fb07a-7828-4e51-a989-88b2f9591ca1` 迁移为上述可读包名，并同步加载声明、Client Module Loader ID、页面/翻译命名空间及 RPC 路径。已有安装应先通过官方插件管理移除旧包，再构建并安装本维护目录，避免新旧插件并存。正式模型配置保存在官方配置服务，不依赖插件包名，无需搬迁；内存草稿及未确认预览随旧插件卸载失效。

原个性化页面创建卡片仍绑定旧包名和 DSH 保留的生成副本；它不会跟随本仓库更新，不再用于恢复或管理长期维护版。再次使用旧卡片恢复会重新安装旧身份的生成副本，可能与维护版冲突。今后统一通过 **Plugins** 管理本维护目录，按返回的 `application` / `nextStep` 判断是否已生效或需要重启；构建成功不等于当前 GUI 已更新。

## 安装后的验证

1.0.1 包名迁移已通过官方插件管理完成，旧包移除与新包安装均返回 `application: applied`。新包从本维护目录链接安装；当前 GUI 的 Client Inspect 已确认新侧栏入口、main key 和 session-maybe 子槽，旧身份已撤回。构建与打包清单检查通过，15 项测试全部通过；独立指定新 RPC 路径的回归测试在迁移前返回 404、迁移后通过。线上只执行只读预览，模型配置 revision 仍为 1，原窗口与预算保持不变，没有再次执行配置保存。迁移后的实际页面显示和交互仍需用户打开页面确认。

已通过当前安装版的真实 Host 激活、模型只读查询和阈值反算验证；Client Inspect 已确认左侧入口、独立 main key 与 session-maybe 子槽注册。用户已确认实际页面的模型列表、预览和保存正常；保存后通过只读接口回读确认：`gpt-6.1-sol` 的窗口为 `453536`、默认输出预留仍为 `128000`、默认官方压缩阈值为 `260000`、近期原文保留预算为 `52085`。此次真实配置写入由用户在 GUI 中确认执行。

冲突、其他字段保留及调用权限由隔离的公开协议 fixture 验证。仍未人工验收返回与重新打开、会话/供应商切换、light/dark、键盘焦点及窄屏滚动。没有浏览器控制工具，Slot 注册与源码审阅不能替代这些实际交互验收。
