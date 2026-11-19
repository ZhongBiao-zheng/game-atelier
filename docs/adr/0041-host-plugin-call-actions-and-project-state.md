---
status: accepted
---

# 宿主插件的调用型动作、画布入口与项目状态

2026-11-19 定，起因是 PS 联动插件 `ps-bridge`（第 1 批）。它的两个入口都不新建插件节点：「从 Photoshop 取图」把 PS 里的选区落成普通图片节点，「发到 Photoshop」把一张图片节点置入 PS。ADR-0039 给宿主插件的入口只有 `create_node`（从素材新建插件节点）与节点类型，装不下这两件事；它还需要在项目里记住「哪张图来自 PS 的哪个文档、哪个位置」，以便结果放回原处。

## 决策

- **`host_call` 动作**：`image_actions[]` 新增动作 `{ "kind": "host_call" }`。点击后宿主加载插件分块，把来源图片节点交给分块里同 id 的处理函数（`HostPluginModule.imageActions`），不建节点、不连线。只有宿主插件可用；目前只在图片工具栏实现，在文本 / 视频工具栏声明判为清单无效（免得按钮点了没反应）。
- **`canvas_actions[]` 贡献点**：画布左侧「添加节点」菜单里的入口，排在插件节点之后，动作只能是 `host_call`，处理函数收到 `HostPluginApi` 与视口中心的画布坐标。只有宿主插件可用，最多 8 项。
- **忙碌状态**：插件分块可以提供 `busy`（订阅 + 读取）。处理期间宿主把这个插件的两类入口置灰，防止重复点击；服务端仍要自己挡并发，前端置灰只是体验。
- **`HostPluginApi.announce`**：画布顶部的一行提示，给「已发到 Photoshop」这类不需要用户处理的结果用。
- **宿主入口的 `ctx`**：宿主插件的服务端代码走 `host` 入口时，`media_of_node` / `image_of_node` 可以读本项目任意节点的素材，`create_*` 不检查 `resource.create`。理由与 ADR-0039 相同：宿主插件与宿主同源可信、没有项目批准这一步；原先 host 入口的能力集是空集，等于宿主插件什么也建不了。沙箱插件的界面仍只能读连到自己节点的素材。
- **项目状态**：`ctx.read_state()` / `ctx.update_state(change)` 读写 `canvases/<project>/plugins/<id>/state.json`（`CanvasPluginState`，≤ 1 MiB，已随项目包导出导入）。`update_state` 持画布项目锁（锁文件按 `canvas_project_lock_path` 放在 `.runtime/locks/`，不进项目目录）做读-改-写，revision 加一。文件读不出时报错，不当成空状态（否则插件在空状态上重建，丢掉用户记录）。只给宿主插件；沙箱插件的 `storage.project` 仍未开放。

入口在画布的添加菜单与图片节点工具栏「更多」里，不新增顶栏入口，符合插件系统「只在现有界面里增加功能」的约定。插件关闭时入口不出现、分块不加载。

## 没有采用

- 让 `ps-bridge` 用一个插件节点承载「取图」「发回」：用户要先建一个与内容无关的节点，再从它出发操作；取到的图片也只能做成插件节点的产物，而不是普通图片节点。
- 对沙箱插件开放 `host_call` 与 `canvas_actions`：沙箱界面不在宿主进程里，没有可调用的处理函数；要开放需要另设计经 broker 的调用协议与批准边界。
- 项目状态用浏览器本地存储：换浏览器、导出项目包就丢；服务端需要在「发回」时按图片版本查来源。
- 项目状态另起一把锁：与画布自动保存共用项目锁，写入很小，避免再造一份跨进程互斥路径。

## 后果

- 清单 schema 两端同步：`plugin_manifest.py` 与 `web/src/schema/plugins.ts`。
- 文档：`docs/plugins/contributions.md`（`host_call`、`canvas_actions`）、`server-modules.md`（host 入口的 `ctx`、项目状态）、`data.md`、`sdk.md`。
- `ps-bridge` 的 Agent 工具进 Canvas MCP 是另一项决定，随第 2 批另记。
