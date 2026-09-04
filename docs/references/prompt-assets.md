# 提示词资产：任务明确后先查库

画师在 Atelier「创作资产」里存的提示词模板（标题 / 标签 / 带变量的正文 / 可选推荐配置）
对 Agent 开放只读。目的：让 Agent 用画师自己的表述习惯与质量约束组 prompt，而不是每次从零写。

## 何时查

拿到一条具体出图 / 出视频需求之后、动笔写 prompt 之前，查一次。**不在启动时读全库**：
库会长到几百条，索引是按任务过滤的。纯问答、改 spec、批准门等待中不查。

## 怎么查（两级，与库大小无关）

| 步骤 | CLI | MCP | 回什么 |
| --- | --- | --- | --- |
| 1 索引 | `list-prompt-assets --tag <标签> [--query 标题子串] [--project <id>]` | `workshop_list_prompt_assets {tags, query?, project_id?, limit}` | 命中的 id / 标题 / 标签 / 最近使用 / 有无推荐配置 + 全库 `tag_facets`（标签与数量） |
| 2 全文 | `read-prompt-asset <asset_id>` | `workshop_read_prompt_asset {asset_id, project_id?}` | segments、variables、按默认值渲染的 prompt、`recommendation` |

1. 先从需求里挑 1-2 个候选标签（高清 / 写实 / 海报 / 角色…）带 `tags` 查；标签要**全部命中**。
2. 结果为空看 `tag_facets`：换库里真有的近义标签或改 `query` 按标题搜。词表里也没有 → 明说
   「资产库没有匹配模板」，自己组 prompt，不硬套。
3. 命中多条按标题与标签选最贴的一条；难以取舍时 AskUserQuestion 二选一，不要合并两条。
4. 只对准备采用的那条调全文接口——它会记一次使用（`last_used_at`），浏览不要用它。

## 怎么用

- `prompt` 是变量取默认值后的完整文本；`variables` 列出可填项。按本轮需求填变量
  （主体、风格、场景…），没有对应信息就保留默认值，不凭空造。
- 模板文本与项目 style.md / spec / 画师本轮指令冲突时，后者优先，并在确认卡点名冲突。
- `recommendation` 非空时：`model` 是模型 id，到 `list_models`（工坊 / 画布同名工具，或 keys.json）
  里找同 id 的可用模型；找到就用它与 `params`，找不到回落项目默认并在确认卡写明
  「推荐模型 X 本机不可用，改用 Y」。`params` 已经过白名单，可直接进 params，但仍受模型能力裁剪。
- 配置优先级：画师本轮明说的 > 资产推荐 > 画布 / 项目默认。确认卡里写出「配置来自哪一层」
  和「提示词来自资产〈标题〉」，让画师一眼看到来源。

## 不做的事

- 不在启动或 turn-start 读全库。
- 不改资产、不新建资产；画师想沉淀新模板 → 指向 Atelier「创作资产」。
- 不把资产正文原样当作 prompt 提交而不填变量。
