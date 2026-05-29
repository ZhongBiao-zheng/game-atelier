# game-ui-ai-workflow MEMORY

## 出图通用

- 画师改图先问三模式：A 编辑当前图 / B 完全重出 / C 局部参考混合；三者互斥，混用输出不稳定
- A 模式：prompt 只写差异指令，不重述外观（参考图已锚定）
- job DONE 后立即写入 spec.md（vN + job_id + 模型 + 尺寸 + 已知偏差），漏记导致下轮误判为未出
- 确认卡必须贴完整 prompt 原文；不写"排除："段；不默认 Lovart，只有画师点名才走
- 出图必须显式传 `--size`（横版 1536x1024 / 竖版 1024x1536）；GPT Image 2 / Seedream 均无合理默认
- 初稿碎渣/AI感重 → 清稿模式：初稿作参考图 + `skills/character-promo/references/prompt-templates/image-cleanup-zh.md`，不改构图只提质量
- 跨模型对比：同 prompt + 同参考图，只改 alias，结果交画师选

## Lovart

- 一次只消化一张参考图；立绘 vs 画师上传图二选一，默认选立绘锚定身份
- 参考图含异种生物时，prompt 第1段必须点明角色种族，否则 agent 以参考图生物为主体
- `Project xxx does not exist`：`~/.lovart/state.json` 的 active_project 被 GC；清掉该字段重试
- artifact URL 存在但 runner 标失败：`curl -sS -L --fail <url>` 补下载，回填 output_paths + status=done
- upload_file 用 curl 子进程，不用 requests（绕开 chunked 响应空 body）

## Caller / API

- OpenAI-HK 走 `/chat/completions`；reference_images 必须 base64 嵌入 messages content image_url part，否则静默丢弃（`src/character_workflow/lib/callers/openai_image.py`）
- OpenAI-HK 未传 size → 默认竖版；caller 把 hint 追加进 prompt 文本，前提是 submit 时显式传 `--size`
- OpenAI-HK 响应可能把图片 URL 包装成 Markdown 或返回半截链接；下载前必须清洗
- Seedream 最小尺寸按面积算（≥ 3,686,400 px²）；1:1 最小合法尺寸 1920×1920
- Seedream `n=2` 可能只返回 1 张；caller 需按 params.n 补发请求
- `--source-image` 必须显式传，runner 不会自动上传立绘

## 开发

- viewer-server 服务 `web/dist`；源码改后必须重 build，浏览器看到旧 UI 先查 dist 时间戳

## Spec 格式（2026-05-29 重设计）

- spec.md = 角色身份定义，不含日志/prompt/皮肤设计；格式见 `docs/references/spec-template.md`
- YAML frontmatter 必填：id / name / project / created；asset.* 节按需追加，无该资产则无该节
- worldview.md 已废除，内容并入 `projects/<slug>/MEMORY.md`（4 节：世界观/项目规则/角色名册/工作经验）
- turn-start 返回 `project_memory`（读项目 MEMORY.md 全文），旧 worldview_project/worldview_workspace 已移除

<!-- session-count: 4/5 -->
