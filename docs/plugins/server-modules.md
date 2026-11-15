# 服务端模块

只有随应用发布的插件（`source: "bundled"`）可以带服务端模块。它在 Atelier 的本机服务进程里运行，所以和主程序代码同等信任，以代码审核为前提。

## 结构

```text
plugins/<id>/server/
├── __init__.py   # 导出 register(api)
└── ...           # 其他模块，用相对导入
```

```python
def register(api) -> None:
    @api.route("POST", "/detect")
    def detect(ctx, params: dict) -> dict:
        image = ctx.inputs[0]
        ...
        return {"frames": [...]}
```

- 每条 `@api.route` 必须与清单 `contributes.server.routes` 一一对应；`scripts/check_product_plugins.py` 会加载模块核对两边。
- 处理函数是同步函数，由框架放进线程池执行，可以做耗时的图像处理，不会卡住其他请求。
- 返回值必须是可 JSON 序列化的 dict，序列化后不超过 4 MiB。
- 模块在第一次调用时才加载；插件停用时卸载；包摘要变化（插件更新）后重新加载。

## 调用前的校验

服务端不信浏览器侧，每次调用都重新核对，任何一步不通过都不会进入处理函数：

1. 插件已启用；
2. 路由在清单里声明过；
3. 本项目对该插件的批准有效（见 [安全与隔离](security.md)）；界面发起的调用还要求批准里有 `server.call`；
4. 界面发起时：`node_id` 是本项目里属于该插件的节点；`inputs` 里每个版本都是此刻以输入连线连到这个节点的素材的当前版本，且素材类型在该节点类型的 `input_modalities` 里（插件更新收窄了类型后，旧连线上的素材同样被拒）。节点类型声明了 `expand_result_stack` 时，连着的结果组封面所在组里此刻的成员也算连着。

## `ctx`

| 成员 | 说明 |
|---|---|
| `ctx.origin` | `"surface"`（插件界面经宿主发起）或 `"agent"`（内置 Agent 调用） |
| `ctx.plugin_id`、`ctx.project_id`、`ctx.node_id` | 当前插件、项目、节点（Agent 调用时 `node_id` 为空） |
| `ctx.capabilities` | 本项目批准的能力 |
| `ctx.inputs` | 界面带来的、已核对的素材：`kind`（`image` / `video` / `audio`）、`node_id`、`version_id`、`title`、`path`、`width`、`height`、`duration_ms`（可能为空）。`path` 只在服务端使用，不要回传给界面 |
| `ctx.media_of_node(node_id, kinds)` | 按节点 id 取素材，只认 `kinds` 里的类型，只在 Agent 调用时可用 |
| `ctx.image_of_node(node_id)` | 等于 `media_of_node(node_id, ("image",))` |
| `ctx.create_image(png_bytes, title, beside_node_id=None)` | 把 PNG 落成画布上的普通图片节点，需要 `resource.create`，返回 `{node_id}` |
| `ctx.create_text(text, title, beside_node_id=None)` | 落成普通文本节点（正文 ≤ 40000 字符），需要 `resource.create` |
| `ctx.create_image_group(pngs, title, beside_node_id=None)` | 把 1–65 张 PNG 一次提交落成一个结果组（封面 + 成员，与生成出多张时的结果组相同：可收起、成员是普通图片节点），需要 `resource.create`，返回 `{node_id, member_node_ids}`。单张 ≤ 64 MiB、合计 ≤ 256 MiB |

新建的节点放在 `beside_node_id`（默认当前节点）旁边；画布正在自动保存时会重读重试，最多三次。

服务端新建节点会让画布文档换一个版本。页面上还没保存的改动（去抖窗口内的编辑）在下一次保存时撞上版本冲突，页面随即重载服务端文档，这些改动被丢弃。所以界面不要在调用会新建节点的路由之后紧接着 `node.writeSelf`；要记的状态在调用之前写好，或由服务端的返回值临时显示。

## 错误

| 抛出 | HTTP | 界面看到 |
|---|---|---|
| `ValueError` / `TypeError` / `KeyError` | 422 | `SERVER_ERROR`，`message` 是异常文字——写成给用户看的一句话 |
| `PluginError(code, message, status)` | 指定 | 指定 |
| 其他异常 | 500 | `INTERNAL`，细节只进服务端日志 |

## 不能做的

- 不能直接调用厂商接口或 Job Runner 内部函数：`check_product_plugins.py` 拒绝 `character_workflow.lib.callers` 与 `job_runner` 的导入。需要生成内容时，应提出生成草稿由用户确认后走 Canvas Run，这样成本统计、路由和网关配额才覆盖得到（界面侧的生成能力尚未开放）。
- 第三方 Python 依赖只能写进根 `pyproject.toml`，安装包没有给单个插件装依赖的机制（取舍见 ADR-0037「插件的第三方 Python 依赖」）。已有可直接用的：Pillow、numpy、`opencv-python-headless`（视频解码、光流、模板匹配）。
- 不要依赖当前工作目录；路径从 `ctx` 或模块自身位置取。
