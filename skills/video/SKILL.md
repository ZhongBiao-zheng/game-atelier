---
name: video
description: |
  游戏项目完整视频工作流：建立企划 brief 与一份多镜头完整 Prompt，经工坊 MCP 准备请求，
  在 Atelier 人工批准后一次生成完整视频，多次生成形成整片版本供选定。
  用于宣传片、角色展示、玩法演示、剧情过场、社媒短片、Shot 1-N 提示词或 /game-atelier:video；
  无项目自由试验走 Web 创作台，不用于时间线剪辑或纯报错分析。
---

# 正式项目视频

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md) 和
[完整视频 Prompt 契约](references/prompt-contract.md)。
最小闭环：企划 brief → 一份完整 Prompt → 人工批准 → 一次完整成片 → 整片选版。

`镜头1…镜头N` / `Shot 1…Shot N` 只是同一个 prompt.md 内部段落，
**一份完整 Prompt 只对应一个生成请求，批准后只创建一个 Job**。
不拆 shot-map、逐镜头目录 / Job / 画布节点，不把版本当片段拼成时间线。

## 定目标与资料

`workshop_list_projects` 明确授权项目，`workshop_list_targets(type:"video")`
找已有企划；用户明确要新企划才 `workshop_create_target(type:"video")`。
保留工具返回 ID，不拼目录或覆盖同名企划。
锁定 `{type:"video",project_id,production_id}`，通过
`workshop_get_context` 与 `workshop_read_document` 读完整项目基线、世界观、
`video_brief` 和 `video_prompt`。

问清企划名称、类型、平台、比例、总时长、传播目的、角色、声音策略。
对白、动作音效、环境音、BGM、静音或组合按任务选，不默认禁止 BGM。
用 MCP 带 revision 保存 brief；已存在则只按本轮需求补改，不重建。

## 先定模型，再写完整 Prompt

1. `workshop_list_models` 查看当前企划实际可用模型与能力，再按 Prompt 契约选模板；
   静态参考中的能力示例不能覆盖本机返回的硬限制。
2. 用 `workshop_list_media` 读取正式登记素材，包括用户在 Web 企划里选定的角色 / UI
   参考。优先 canonical；当前上下文可见的过期标记要提示。无定稿时可选未定稿图并明示。
3. `workshop_read_media` 查看图片预览。视频 / 音频当前只有元数据，
   不声称已观看 / 听取；需要核验其中内容时请用户在 Atelier 查看确认。
   对要求限制可辨识写实真人脸的模型，无法核验的素材不能宣称已通过检查。
4. 按 `media_ids` 顺序说明每张图的可见特征、人物 / 场景 / 声音归属；
   不把绝对路径、聊天附件路径或临时 URL 当素材输入，也不上传未登记的临时素材。
5. Seedance 常规短片按“主体、场景、声音、镜头1–N”写具体事件。
   2.0 不写时间戳；2.5 仅精确卡点时使用不重叠且不超过请求时长的时间段。
   素材已经表达的外观不重复堆料，易误解身份补必要特征，结尾有明确落点。
6. 完整 Prompt 保存为当前企划 `video_prompt`，一份文档与一次生成快照，不能拆任务。
   展示模型、时长、比例、素材、声音与完整内容给画师核对。

## 准备、人工批准、整片选版

`workshop_prepare_generation` 使用当前 video target 和
`params.type:"video"`，传完整 prompt、实际 alias/model、模型支持的时长 / ratio /
resolution / frame_mode / 音频选项与有序 media_ids。
准备返回 request ID，不代表已创建成片或已经扣费。

请用户在本机 Atelier「待批准生成」人工批准后才执行。聊天“生成 / 出片 / 全部重试”
不能代替每个请求的页面批准。没有 Agent 批准工具，不调用 shell 或供应商绕过。
用 `workshop_get_generation` 查同一请求，完成后引导用户在当前企划播放完整版本。

失败只报告该请求的真实错误；要再试时修改必要内容并准备新请求，重新页面批准。
网络结果不明先查状态，不能自动再扣费。用户在 Web 选定最终视频，取消也在 Web；
Skill 不代选、不删除其他整片版本、不反向修改历史 Job。

产物仍落原项目视频企划的 versions/，不建 MCP 资产仓。
反馈真的处理完才确认对应 ID，收尾按共享七件套，清楚区分待批准、处理中和已生成。
