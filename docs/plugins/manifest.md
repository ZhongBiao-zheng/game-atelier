# 清单参考

源清单是 `plugins/<id>/manifest.json`，由人写。构建后生成 `package/manifest.lock.json`：源清单全部字段，加上 `files`、`source`、`digest`。宿主运行时只读锁文件。

Schema 定义：`src/character_workflow/lib/plugin_manifest.py`（Pydantic）与 `web/src/schema/plugins.ts`（TypeScript），两端手工同步。清单不接受未知字段。

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `manifest_version` | `1` | 清单格式版本 |
| `id` | 字符串 | `^[a-z][a-z0-9-]{1,39}$`，与目录名一致 |
| `name` | 字符串，≤40 | 界面显示名 |
| `version` | 三段版本号 | 插件版本 |
| `description` | 字符串，≤80 | 设置页里的一句话说明 |
| `icon` | 图标名 | 设置页图标，见下方「图标」 |
| `publisher` | `{id, name}` | 发布者 |
| `sdk_version` | 字符串 | 界面协议主版本，目前只有 `"1"` |
| `app_version` | `{min, max?}` | 兼容的 Atelier 版本范围，闭区间 |
| `ui` | `{entry: "ui/index.html"}` 或省略 | 有节点或工具栏动作时必填 |
| `capabilities` | 字符串数组 | 插件界面要用的能力，见 [界面与 SDK](sdk.md#能力) |
| `contributes` | 对象 | 贡献点，见 [贡献点](contributions.md) |
| `assets` | 数组 | 依赖的大文件（地址、字节数、SHA-256）。下载器尚未实现：声明了必需的大文件的插件显示为「需要更高版本的 Atelier」 |
| `state_schema_version` | 整数 | 项目级插件状态的版本，默认 1 |

## 锁文件追加的字段

| 字段 | 说明 |
|---|---|
| `files` | `[{path, sha256, bytes}]`，包里每个文件的摘要 |
| `source` | 目前只有 `"bundled"`（随安装包发布） |
| `digest` | `sha256:` + 去掉 `digest` 键后的锁文件按键排序、无空白、非 ASCII 不转义的 JSON 的 SHA-256 |

宿主把界面放进沙箱前按 `files` 核对字节数与 SHA-256，不一致拒绝加载。

## 图标

清单不能带自己的图形。`icon` 填宿主登记过的名字：`frames`、`grid`、`cube`、`layers`、`scissors`。未登记的名字显示为通用插件图标。新名字要先在 `web/src/components/ui/icons.tsx` 的 `PLUGIN_ICONS` 里登记。

## 校验规则

- 节点类型、工具栏动作 id、服务端路由、Agent 工具名各自不能重复。
- `create_node` 动作指向的节点类型必须在 `contributes.nodes` 里。
- Agent 工具的 `route` 必须是已声明的 POST 路由。
- 声明了节点或工具栏动作，就必须有 `ui`。
- 清单校验失败只影响这个插件：设置页显示「无法读取」，其他插件与主程序照常。
- 清单合法但当前宿主不支持（版本范围、SDK 版本、能力、必需大文件）：显示具体原因，不能启用。
