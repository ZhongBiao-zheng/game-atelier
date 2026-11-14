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
4. 界面发起时：`node_id` 是本项目里属于该插件的节点；`inputs` 里每个版本都是此刻以输入连线连到这个节点的图片的当前版本。

## `ctx`

| 成员 | 说明 |
|---|---|
| `ctx.origin` | `"surface"`（插件界面经宿主发起）或 `"agent"`（内置 Agent 调用） |
| `ctx.plugin_id`、`ctx.project_id`、`ctx.node_id` | 当前插件、项目、节点（Agent 调用时 `node_id` 为空） |
| `ctx.capabilities` | 本项目批准的能力 |
| `ctx.inputs` | 界面带来的、已核对的图片：`node_id`、`version_id`、`title`、`path`、`width`、`height`。`path` 只在服务端使用，不要回传给界面 |
| `ctx.image_of_node(node_id)` | 按节点 id 取图片，只在 Agent 调用时可用 |
| `ctx.create_image(png_bytes, title, beside_node_id=None)` | 把 PNG 落成画布上的普通图片节点，需要 `resource.create`，返回 `{node_id}` |
| `ctx.create_text(text, title, beside_node_id=None)` | 落成普通文本节点（正文 ≤ 40000 字符），需要 `resource.create` |

新建的节点放在 `beside_node_id`（默认当前节点）旁边；画布正在自动保存时会重读重试，最多三次。

## 错误

| 抛出 | HTTP | 界面看到 |
|---|---|---|
| `ValueError` / `TypeError` / `KeyError` | 422 | `SERVER_ERROR`，`message` 是异常文字——写成给用户看的一句话 |
| `PluginError(code, message, status)` | 指定 | 指定 |
| 其他异常 | 500 | `INTERNAL`，细节只进服务端日志 |

## 不能做的

- 不能直接调用厂商接口或 Job Runner 内部函数：`check_product_plugins.py` 拒绝 `character_workflow.lib.callers` 与 `job_runner` 的导入。需要生成内容时，应提出生成草稿由用户确认后走 Canvas Run，这样成本统计、路由和网关配额才覆盖得到（界面侧的生成能力尚未开放）。
- 第三方 Python 依赖只能写进根 `pyproject.toml`，安装包没有给单个插件装依赖的机制。
- 不要依赖当前工作目录；路径从 `ctx` 或模块自身位置取。
