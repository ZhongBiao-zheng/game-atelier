---
status: accepted
---

# 宿主插件：界面是宿主代码、按需加载的官方插件

2026-11-16 定：分镜改成可启用、可关闭的插件，关闭的插件不加载任何代码（前端分块、后端路由、Agent 工具、菜单与工具栏入口）。ADR-0037 的插件界面只能在沙箱里运行，沙箱 SDK 没有改画布结构、提交生成的能力（`graph.*`、`generation.*` 在 ADR-0037 列为本期不做）。

## 分镜为什么不进沙箱

分镜要在画布上建图片 / 视频节点、写节点上的生成设置、逐镜调用 Canvas Run、按每镜价格弹确认框。沙箱化需要先设计并实现 `graph.*` 与 `generation.*` 两组能力及它们的批准与计费边界，等于重写分镜并改动计费链路。宿主插件保留分镜原有的生成路径不变（迁移前后用本机假服务录到的厂商请求体逐条相同）。

## 决策

- 清单新增 `runtime: "sandbox" | "host"`，缺省 `sandbox`。
- **是否为宿主插件由宿主决定，不由清单决定。** 服务端 `plugin_registry.HOST_PLUGIN_IDS` 与前端 `web/src/plugin-host/hostPlugins.ts` 的加载表是两份白名单（前端只是加载入口，安全判定在服务端）。白名单外的包声明 `host`，或白名单里的包不声明 `host`，注册表判为 `invalid`，不能启用。目前白名单只有 `storyboard`。
- 宿主插件不声明 `ui`、`capabilities`、`agent_tools`；没有项目批准这一步。
- 目录与官方沙箱插件相同，自包含在 `plugins/<id>/`：`manifest.json`、`host/`（界面源码，宿主代码）、`server/`（服务端模块）、`tests/`、入库的 `package/manifest.lock.json`（宿主插件的包里没有界面文件）。
- 前端：`host/` 编进主应用构建，但作为单独的分块（`web/dist/assets/<id>.js`）。画布只为已启用的宿主插件 import 它；关闭时不请求这个分块。节点正文、节点工具条按钮、复制粘贴时的 payload 改写都由插件分块提供；菜单项与文本工具栏按钮由宿主按清单画（关闭时不出现）。插件拿到的是画布给的 `HostPluginApi`：读写当前文档、提交一个节点的 Canvas Run、等本地文档落定、取供应商与生成默认值。
- 后端：服务端模块与沙箱插件同一套 `register(api)`，第一次调用时 import，停用时卸载。界面调用走同一个插件路由，入口记为 `origin = "host"`：不检查项目批准与素材连线，其余检查不变；沙箱插件不能走这个入口。宿主插件的服务端模块可以 import 平台库（剧本解析用 `structured_text_call` 调对话模型并记 assist 任务），仍不能 import `callers`、`job_runner`。
- 新贡献点 `contributes.text_actions[]`（文本节点工具栏），沙箱插件与宿主插件都可用：沙箱插件从文本节点连线到新节点，宿主插件不连线、把来源节点交给插件代码。
- 新服务端登记 `api.agent_view(node_type)`：画布 Agent 的 `get_canvas` 给这类节点追加只读摘要。只有宿主插件能登记；插件关闭时不调用、不 import。
- 分镜插件 id 为 `storyboard`，节点外壳 `plugin_id: "storyboard"`。分镜此前没有进过任何发布，真实数据里没有 `atelier.storyboard` 节点，所以不做读盘迁移；开发期数据里的旧节点显示「未安装此插件」占位，数据保留。`payload` 仍按 ADR-0038 当不可信数据宽容读取。
- 分镜插件默认关闭，与其他官方插件一致。

## 没有采用

- 分镜进沙箱：见上。
- 宿主插件的界面放在 `web/src/` 里：插件就不再是一个自包含目录，启停边界只能靠约定维持。
- 清单自报 `runtime: host` 即按宿主插件对待：将来开放其他发布者时，任何包都能借此绕过沙箱与项目批准。

## 后果

- `web/` 的 Vite、TypeScript、vitest、Tailwind 的类名扫描、设计守卫都接上 `plugins/*/host/**`（裸模块从 `web/node_modules` 解析）。
- 宿主插件与宿主同源可信，审核标准与宿主代码相同；它不是向第三方开放的扩展方式。
- 分镜节点不再出现在左侧工具栏，只在添加节点菜单与文本工具栏（启用后）出现。
