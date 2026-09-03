---
name: canvas
version: 1.0.0
description: |
  用 canvas_* MCP 工具操作本机 Atelier 画布：读节点与连线、增删文本 / 媒体节点、填生成配置、
  导入本机文件、在授权允许时直接发起生成并读回结果。用户要「在画布上摆节点 / 连线 / 出图」、
  把本地图片放进画布、批量搭生成流程，或调用 /game-atelier:canvas 时使用。
  角色 / 美宣 / UI / 视频的工坊流程不归本 skill，交对应工坊 Skill。
allowed-tools:
  - Read
  - AskUserQuestion
triggers:
  - /game-atelier:canvas
  - 画布
  - 在画布上
  - 帮我搭画布
  - 画布出图
---

## 定位

画布是 server 持有、带 revision 的活文档，本 Skill 只有一条手：`canvas_*` MCP 工具
（契约见 `docs/contracts/canvas-mcp.md`）。没有 CLI 路径，不读写画布文件，不改 Job。
工具不可见 / 授权不含画布时，指用户去本机 Atelier「本机 Agent 连接」页勾选画布与画布操作，
配置方法见 `docs/mcp-local-client.md`；停在授权环节，不改走 shell。

## 先读再改

1. `canvas_list_projects` 列授权画布；用户点名时按名字匹配，重名问一次，不猜 ID。
2. `canvas_get_document` 读全图：节点（id / 类型 / 标题 / 位置 / 文本 / draft / 版本）、
   连线、媒体版本、`revision`。每次修改前都重读，拿最新 revision；用户在浏览器里也可能在改。
3. 文本超过 4000 字会截断（`text_truncated`），截断内容不能当完整文本写回。
4. 位置单位是画布坐标；新节点默认放在已有节点右侧 400 或下方 300 的空位，不叠在别人身上。

## 编辑：一批 change set，一次提交

`canvas_apply_changes` 带 `expected_revision` 与 `changes[]`（≤50 条）原子提交；
返回 `DOCUMENT_CONFLICT` 就重读再改，不重试旧 revision。

| 要做 | op | 注意 |
| --- | --- | --- |
| 放一段提示词 | `add_text` | title 简短可辨；text 就是提示词正文 |
| 放一张本机图 / 视频 / 音频 | 先 `canvas_import_media` 再（如需另建节点）`add_media_node` | 导入本身已建节点；只接受绝对路径，图 ≤10 MB，视频音频 ≤100 MB |
| 让某节点成为生成面 | `set_draft` | mode / prompt / model / alias 必填；model 与 alias 来自 `canvas_list_models`，不虚构 |
| 把素材接进生成面 | `connect` | source 是素材或提示词节点，target 是生成面；视频首尾帧用 `slot` |
| 调整 / 清理 | `move` / `set_text` / `disconnect` / `remove_node` | 只能断输入连线；派生连线与生成产物由服务端持有，不可动 |

搭「提示词 → 参考图 → 生成面」的标准三件：一条 change set 里 `add_text` + `set_draft` + 两条 `connect`，
生成面用一个空文本节点或已有图片节点承载 draft。`input_policy` 缺省 `all_connected`（接进来的都当输入）；
只想引用 @ 提到的素材才用 `mentions_only`。

`params` 只收标量，按浏览器白名单过滤：图片常用 `n / size / ratio / quality`，视频 `duration / resolution / ratio`。
路径类字段写了也会被丢弃，不要试。

## 生成：先确认卡，再看能力

1. 发起前打确认卡给用户：画布名、生成面节点、模型 alias / model、prompt 摘要、接入的素材节点列表、
   数量与参数、费用状态（本地未核价即写「费用待确认」）。
2. 等用户明确肯定（出图 / 可以 / 走）。沉默、模糊、「再想想」都不推进；模糊用 AskUserQuestion 二选一。
3. 授权含 `canvas_generate` → 调 `canvas_run`（surface_node_id + 当前 revision + requested_count）。
   返回 `TARGET_NOT_AUTHORIZED` 表示授权没给发起生成，告知用户在授权页补勾，不能改走其他路径。
4. `canvas_run` 后服务端会在生成面右侧建结果节点，文档 revision 变化；之后所有修改先重读。
5. `canvas_get_run` 查同一 `run_id`：`candidates[].version_id` 是产物版本；`failed` 只报告安全摘要，
   不自动重跑。用户要再来一张 = 新的确认卡 + 新的 `canvas_run`。

## 看结果

`canvas_read_media` 读产物或导入图的有界预览（≤1024 边长 JPEG）；预览尺寸不是原图尺寸，
以返回的 width / height 为准。有视觉能力时对照用户要求点评构图、主体、明显崩坏；没有就明说未做视觉质检。
完整大图、拖动排版、定稿由用户在浏览器画布完成，本 Skill 不代选。

## 收尾（七件套，实质推进后）

```text
当前步骤：
完成状态：
本步产物：
需要你检查：
可选操作：
进入下一步的条件：
下一步可直接说的话：
```

状态区分「已改画布（revision N）/ 待你确认出图 / 生成中 / 已生成」，不把建议写成已执行。

## Guardrails

- 只用 `canvas_*` 工具；工具不可用不改走 shell / 文件 / 直接调供应商。
- 每次修改前重读 revision；`DOCUMENT_CONFLICT` 重读再改，不盲重试。
- 生成必过确认卡 + 用户明确肯定；`canvas_generate` 缺失时不绕、不替用户补权限。
- 不虚构 model / alias / 价格；`canvas_list_models` 里没有的不写进 draft。
- 不动派生连线、历史版本、生成产物；不删用户节点，除非用户点名。
- 不把本地路径塞进 params；导入文件只走 `canvas_import_media`。
- 提问走 AskUserQuestion，单次 ≤4 问、每问 ≤4 选项；不可用时文本确认，不伪造回答。

## 跳过条件

用户要的是角色立绘 / 美宣 / 三视图 / UI 页面 / 视频企划（有工坊目标与 spec 的东西）→ 交对应工坊 Skill；
用户只想在浏览器里自己摆 → 不触发，告知画布页入口。
