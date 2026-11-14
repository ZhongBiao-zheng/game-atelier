# 贡献点

插件在清单的 `contributes` 里声明它向主程序注册的功能。

## 画布节点类型 `contributes.nodes[]`

```json
{
  "type": "sheet",
  "title": "精灵表",
  "icon": "frames",
  "default_size": { "width": 360, "height": 300 },
  "min_size": { "width": 240, "height": 200 },
  "payload_schema_version": 1,
  "input_modalities": ["image"],
  "max_inputs": 1,
  "surfaces": ["node", "panel"]
}
```

| 字段 | 说明 |
|---|---|
| `type` | 插件内唯一，写进节点数据的 `node_type` |
| `title`、`icon` | 添加菜单与节点标题 |
| `default_size`、`min_size` | 新建时的尺寸与最小尺寸（宽 120–2000，高 80–2000） |
| `payload_schema_version` | 写进节点的 `data_schema_version`，节点数据格式变化时递增 |
| `input_modalities` | 可以连进来的素材类型：`text`、`image`、`video`、`audio`。空数组表示不接收输入 |
| `max_inputs` | 输入连线上限 |
| `surfaces` | `node`：节点内容面；`panel`：双击节点打开的编辑面板 |

宿主负责：添加菜单项（排在内置项之后，说明显示插件名）、节点标题、连接柄、缩放手柄、选中框、工具条、占位与批准。插件界面只占节点内容区。

连线规则：只接受普通输入连线（无 slot、非标注）。插件节点不能作为输入来源——要向画布输出内容，用服务端模块的 `create_image` / `create_text` 新建普通节点。保存画布时，只对**本次新增**的插件连线按清单核对（插件已启用、类型在 `input_modalities` 内、不超过 `max_inputs`）；已有连线与读取画布不依赖插件是否存在。

## 图片工具栏动作 `contributes.image_actions[]`

```json
{ "id": "open", "label": "精灵表", "icon": "frames",
  "action": { "kind": "create_node", "node_type": "sheet", "open_panel": true } }
```

动作出现在图片节点工具栏「更多」菜单里，排在内置项之后，不进「自定义工具条」。按钮是宿主按清单画的，点击之前不运行任何插件代码。

`create_node`：在图片右侧新建该类型的插件节点，并从图片连一条输入连线；`open_panel` 为真时，本项目批准通过后自动打开编辑面板。另一种 `open_panel` 动作已在清单 schema 里定义，宿主尚未实现。

## 服务端路由 `contributes.server`

```json
"server": {
  "module": "server",
  "routes": [
    { "method": "POST", "path": "/detect", "access": "read" },
    { "method": "POST", "path": "/repack", "access": "edit" }
  ]
}
```

只有随应用发布的插件可以声明。每条路由对应 `POST /api/plugins/<id>/routes<path>`，`access` 决定鉴权时算读还是写（写操作要求页面持有编辑权）。未声明的路径、未启用的插件在鉴权层就被拒绝，插件代码不会被触达。`long_running` 已在 schema 里定义，尚未接入更新器的在途统计。实现方式见 [服务端模块](server-modules.md)。

## Agent 工具 `contributes.agent_tools[]`

```json
{
  "name": "detect",
  "description": "识别一张精灵表里的帧……只读。",
  "parameters": { "type": "object", "required": ["image_node_id"],
                  "properties": { "image_node_id": { "type": "string" } } },
  "read_only": true,
  "route": "/detect"
}
```

插件启用后，工具以 `plugin_<id 中的 - 换成 _>_<name>` 为名加入画布内置 Agent 的工具列表（例：`plugin_sprite_sheet_detect`）。每次组装 Agent 时读一遍已启用插件，所以启停在下一轮对话生效。

- `read_only` 为真时不需要用户确认；否则按当前权限模式（审查模式下确认，自动模式下直接执行）。
- 调用同样要求本项目已批准该插件。
- 工具调用走 `route` 指向的同一个处理函数，`ctx.origin` 为 `"agent"`。
- 外部 MCP（Claude Code 等）的工具列表不包含插件工具。
