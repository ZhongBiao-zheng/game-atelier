# 完整示例：精灵表调整

`plugins/sprite-sheet/` 是第一个官方插件：把一张精灵表切成帧，逐帧对齐、调锚点、重排，再放回画布。它用到了全部四个贡献点，可以照着它写新插件。

## 用户怎么用

1. 设置里启用「精灵表调整」。
2. 选中一张图片，工具栏「更多」→「精灵表」：图片右侧新建一个精灵表节点并连线；在本项目里第一次使用时确认一次，随后自动打开编辑面板。也可以从「添加节点」菜单新建，再手动连一张图。
3. 面板里：自动识别或按网格切帧 → 在底部帧列表里点选、拖动换顺序、反转、删除 → 方向键微调当前帧，点当前帧设锚点 → 看预览 → 设好每行帧数、间距、对齐 → 「放到画布」。
4. 画布上多出一张排好的精灵表图片；勾选「同时输出帧数据」时还多一个文本节点，内容是给引擎用的 JSON。
5. 画布内置 Agent 也能用：`plugin_sprite_sheet_detect`（只读，识别帧）、`plugin_sprite_sheet_repack`（重排并生成新图片）。

## 目录

```text
plugins/sprite-sheet/
├── manifest.json
├── ui/src/
│   ├── main.tsx          # 按 client.surface 渲染节点面或编辑面板
│   ├── NodeFace.tsx      # 节点内容面：连入的图与帧数
│   ├── Panel.tsx         # 编辑面板
│   ├── FrameStrip.tsx    # 帧列表（点选、拖动重排）
│   ├── FrameEditor.tsx   # 当前帧：洋葱皮、锚点
│   ├── layout.ts         # 排布算法，与服务端同一套
│   ├── sheetState.ts     # 节点数据的解析与默认值
│   ├── draw.ts           # 画布绘制、包围盒读取
│   ├── kit/controls.tsx  # 按钮、数值框、下拉、勾选
│   └── styles.css        # 只用宿主下发的设计 token
├── server/
│   ├── __init__.py       # register(api)：/detect、/repack
│   └── sheet.py          # 识别、切帧、重排（只依赖 Pillow）
├── tests/
│   ├── test_sheet.py
│   └── layout_cases.json # 界面与服务端共用的排布用例
└── package/              # 构建产物，入库
```

## 清单要点

```json
{
  "id": "sprite-sheet",
  "capabilities": ["node.read_self", "node.write_self", "resource.read_inputs", "resource.create", "server.call"],
  "contributes": {
    "nodes": [{ "type": "sheet", "title": "精灵表", "icon": "frames",
                "default_size": { "width": 360, "height": 300 }, "payload_schema_version": 1,
                "input_modalities": ["image"], "max_inputs": 1, "surfaces": ["node", "panel"] }],
    "image_actions": [{ "id": "open", "label": "精灵表", "icon": "frames",
                        "action": { "kind": "create_node", "node_type": "sheet", "open_panel": true } }],
    "server": { "module": "server", "routes": [
      { "method": "POST", "path": "/detect", "access": "read" },
      { "method": "POST", "path": "/repack", "access": "edit" } ] },
    "agent_tools": [ { "name": "detect", "read_only": true, "route": "/detect", "...": "..." },
                     { "name": "repack", "read_only": false, "route": "/repack", "...": "..." } ]
  }
}
```

每项能力都有用处：读写自己的节点数据（设置随改随存）、读连入的图（预览与包围盒）、调服务端（识别与重排）、新建节点（放回画布）。

## 节点数据

```json
{
  "version": 1,
  "frames": [ { "x": 26, "y": 20, "w": 45, "h": 65, "ox": 3, "oy": -10, "ax": 0.5, "ay": 0.9 } ],
  "grid": { "columns": 6, "rows": 1, "margin": 0, "spacing": 0 },
  "columns": 6, "spacing": 0, "margin": 0, "align": "bottom-center", "trim": true,
  "anchor": { "x": 0.5, "y": 1 }, "fps": 8, "onion": true
}
```

- `frames[]`：原图上的帧区域；`ox` / `oy` 是逐帧偏移（像素）；`ax` / `ay` 是这一帧单独的锚点（比例，省略时用整表的 `anchor`）。
- `anchor`：整表锚点，0–1 比例，`(0.5, 1)` 是格子底边中点。
- `sheetState.parseState` 对缺字段、坏数据一律回落到默认值；读到的数据在用户改动之前不会被写回。

## 排布算法

`layout.ts`（界面）与 `server/sheet.py` 的 `placements` / `anchor_point`（服务端）是同一套：

1. `trim` 为真时每帧先裁掉透明边（透明度 ≤ 8 算透明，全透明的帧当成 1×1）。
2. 格子取所有帧里最大的宽和高。
3. 按 `align` 把每帧放进格子（底部居中 / 居中 / 左上，奇数差向下取整），再加上逐帧偏移；超出格子的部分裁掉，不画进相邻格子。
4. 锚点像素位置 = `floor(格宽 × x)`、`floor(格高 × y)`。

两边都跑 `tests/layout_cases.json`，所以面板里的预览就是放到画布后的样子。

## 界面怎么调服务端

```ts
// Panel.tsx
const found = await client.server.call('/detect', {}, [source.handle]);
const result = await client.server.call('/repack', {
  frames, columns, spacing, margin, align, trim, anchor, frame_data: true,
}, [source.handle]);
```

`source.handle` 来自 `client.inputs.list()`。宿主把它换成版本转给服务端，服务端核对这张图此刻确实连在这个节点上，再交给处理函数：

```python
# server/__init__.py
def _source(ctx, params):
    if ctx.origin == "agent":
        return ctx.image_of_node(str(params.get("image_node_id", "")))
    if not ctx.inputs:
        raise ValueError("请先连接一张图片")   # 界面直接显示这句话
    return ctx.inputs[0]

@api.route("POST", "/repack")
def repack(ctx, params):
    source = _source(ctx, params)
    png, data = sheet.repack(sheet.open_sheet(source.path), ...)
    created = ctx.create_image(png, f"{source.title} 精灵表")
    if params.get("frame_data"):
        ctx.create_text(json.dumps(data, ensure_ascii=False), f"{source.title} 帧数据")
    return {**created, **data}
```

界面与 Agent 共用同一组处理函数，只在取图的方式上分开。

## 帧数据

```json
{
  "frames": [ { "x": 0, "y": 0, "w": 45, "h": 77, "anchor_x": 22, "anchor_y": 77 } ],
  "meta": { "size": { "w": 270, "h": 77 }, "columns": 6, "rows": 1,
            "cell": { "w": 45, "h": 77 }, "anchor": { "x": 22, "y": 77 } }
}
```

`frames[]` 是输出图里每格的位置与该格锚点（逐帧锚点覆盖时各帧不同），`meta.anchor` 是整表锚点。超过文本节点正文上限（40000 字符）时不生成文本节点，返回 `frame_data_error`。

## 键盘与输入法

- 方向键微调当前帧 1 像素，Shift 每次 10 像素；Delete 删除当前帧。焦点在输入框里时这些键不生效。
- 连续微调合成一次保存，撤销一步回到微调之前；按 Esc 关面板前会先写出未保存的微调。
- 数值框是文本框加数字键盘：中文输入法组合期间只改显示，组合结束才提交；全角数字自动换成半角。组合中的 Esc 用来取消组合，不关面板。

## 测试

```bash
uv run pytest plugins/sprite-sheet                       # 识别、切帧、重排、共用排布用例
cd web && npx vitest run ../plugins                      # 排布算法、节点数据解析、帧列表操作
uv run pytest tests/test_plugin_server.py -k sprite      # 经真实路由与校验的端到端
```
