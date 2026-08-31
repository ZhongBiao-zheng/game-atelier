---
name: turnaround
description: |
  角色三视图、character sheet 工作流：依据完整 spec 与已登记身份参考冻结外观，
  生成适合建模或动画的正侧背工程图，经工坊 MCP 准备并等待本机人工批准。
  用户要三视图、角色三面、结构设定或调用 /game-atelier:turnaround 时使用。
---

# 角色三视图

默认单张出图，保持三面同时可比较。

先完整读取 [MCP 工作流](../../docs/references/workshop-mcp-workflow.md)、
[统一 Prompt 规则](../../docs/references/art-prompt-system.md)、
[三视图 Prompt](references/prompt-turnaround-zh.md)、
[模型选择](../../docs/references/model-routing.md)。项目操作只能通过受限 MCP。

## 前置门

`workshop_list_projects`、`workshop_list_targets` 找到明确角色，锁定
`asset_slot:"turnaround"`。读 `workshop_get_context`、完整 `character_spec`、
项目基线与世界观、当前项目三视图经验和反馈。

完整 spec 与可核对的身份基准缺一不可。默认以当前角色定稿 portrait 为身份锚，
没有定稿则明确选当前立绘；派生角色允许使用已冻结的来源作为身份基准，
不能偷换父角色的新版本。通过 `workshop_list_media` / `workshop_read_media`
核对登记图，资料缺失先回 character 补完。旧定稿过期要先说明，不能装作当前标准。

## 工程约束与参考图清单

先确认下游用途、视图组合、着色方式、道具拆解需求。默认正面 / 侧面 / 背面横向三联，
全身含脚，中性站姿，三面头顶线 / 腰线 / 脚底线一致，比例、服装层次、道具位置固定。

- 建模与绑骨以清楚结构和平涂为先；卡牌或服装用途再调整线条与细节密度。
- 全部身份锚冻结，不能顺手改发型 / 颜色 / 服装；要求重新设计时先修 spec。
- 禁止戏剧光影、特效粒子、动态夸张动作和复杂场景，说明这会妨碍工程读图；
  用户想做气氛图可转立绘或美宣，不把气氛图冒充三视图。
- 有身份图时不复述整份外观，文字补正侧背独有结构及工程要求。
- 额外参考只允许布局用途 `composition_only`，不借用外部人物身份、服装、风格或色彩。
- 参考图清单按实际 `media_ids` 顺序逐张写“序号 + 简短可见描述 + 用途”；
  默认身份图和布局图都必须描述，不能只写图一图二。

画幅优先 3:2 横幅（常用 1536×1024），实际 size / ratio 服从模型返回能力；
模型不支持时请画师确认替代，不能把 unsupported 尺寸写成保证。
背景浅灰 / 米白或浅网格，平光均匀，不写负向质量词堆叠。

## 保存、人工批准、检验

1. 按三视图参考的四段结构写 Prompt：简短角色与视图组合 → 各面独有细节 →
   画面规格与辅助基线 → 继承风格。身份锚与 spec 冲突先解决，不带冲突出图。
2. 用户确认的结构资料用 `workshop_write_document` 更新 `character_spec`，
   必须先读完整文档、带 revision；不直写任何项目文件。
3. `workshop_list_models` 核对能力，默认一张。用 `workshop_prepare_generation`
   准备当前 turnaround 请求，请用户在本机 Atelier「待批准生成」人工批准后再执行。
4. `workshop_get_generation` 查询同一 request ID；聊天“出图”不代替页面批准，
   不用 shell 或供应商工具绕过，不自动重试付费任务。
5. 成功后 `workshop_read_media` 查看本次媒体，检查三面比例、基线、关节 / 接缝、
   服装和武器背面结构、手脚及锚点漂移。无法看图时注明未做视觉质检。
6. 画师在 Web 选择定稿，Skill 不代选；旧版保留。反馈完成再确认对应 ID；
   再生图要新请求与新的页面批准。

产物归当前角色 turnaround/；收尾按共享七件套报告真实进度。
