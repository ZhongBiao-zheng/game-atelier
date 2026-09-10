# 卡片如何呈现给画师：show_widget 卡片 vs 文本卡

> 权威说明（2026-09-10 落地）。所有 Skill 打给画师的卡——出图 / 出视频确认卡、沉淀确认卡、
> 总控进度卡、七件套收尾、画布 / MCP 路径的生成确认卡——呈现方式一律按本文执行。
> 本文只改「怎么显示」，不改任何门禁：卡出完就地停，沉默 / 模糊不算确认，判定规则仍以各 SKILL.md 为准。

## 一、先判渲染通道

看客户端工具列表：

| 工具列表里有 | 用什么 |
|---|---|
| `show_widget`（visualize，通常伴随 `read_me`） | **卡片**：按本文第二 / 三节生成 HTML，整段作为 `widget_code` 传入 |
| 没有（Codex / 纯终端 / 其他代理） | **文本卡**：沿用各 SKILL.md 原有的文本格式，一字不改 |

规则：

- 本会话**第一次**调用 `show_widget` 前先调一次 `read_me`（`modules: ["mockup"]`，`platform: "desktop"`），之后不重复。
- `show_widget` 的 `title` 用 snake_case 且能区分（如 `job_confirm_job_2026…`、`turn_summary_portrait_v3`）；`loading_messages` 一条即可，中文。
- 卡片里**只放卡**。解释、追问、下一步说明写在卡片外的正文里。
- 卡片渲染失败（工具报错）→ 立刻退回文本卡，不重试三次、不空等。

## 二、出图 / 出视频确认卡（job 卡）

内容由 CLI 按 job JSON 生成，Skill 不手写、不摘要、不增删字段：

```bash
# submit 已把文本卡打到 stderr（文本通道直接原样转发那份）
uv run python -m character_workflow card "$JOB_ID"            # HTML → 原样进 show_widget 的 widget_code
uv run python -m character_workflow card "$JOB_ID" --format text   # 与 submit 的 stderr 逐字相同
```

Installed Plugin / Codex 模式按各 SKILL.md「运行模式」把 `uv run python -m character_workflow` 换成对应前缀。
`retry-job` 得到的新 job 同样用 `card <新job_id>`。

卡片底部三个按钮，点击会以画师身份发出**固定原话**，直接落进 SKILL.md 的判定表：

| 按钮 | 画师侧发出的话 | 对应判定 |
|---|---|---|
| 出图 / 出视频 | `出图 <job_id>` / `出视频 <job_id>` | **推进** → `run-job <job_id>` |
| 要改 | `要改 <job_id>` | **修改**，但没带改点 → 先问「要改哪里」（AskUserQuestion 或一句追问），拿到改点再重新 submit 出新卡 |
| 先不出 | `先不出 <job_id>` | **否定** → 停在 PENDING_CONFIRM，不推进、不催 |

画师不点按钮直接打字，仍按原判定表处理。`<job_id>` 与卡上的一致才算数；对不上（旧卡的 id）不推进，回一句「这张卡已作废，最新是 …」。

## 三、其他卡（LLM 组内容的卡）

进度卡、七件套、沉淀确认卡、画布确认卡、MCP 路径（`workshop_prepare_generation` 之后）的生成确认卡，
内容本来就由 Skill 按各自模板组；有 `show_widget` 时套下面这个 HTML 骨架，槽位一一对应原文本模板，
**不新增、不省略任何一行**：

```html
<h2 class="sr-only">{卡名}：{一句话概述}</h2>
<div style="background: var(--surface-2); border-radius: 12px; border: 0.5px solid var(--border); padding: 1rem 1.25rem;">
  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
    <p style="font-weight: 500; font-size: 15px; margin: 0; flex: 1;">{卡名}</p>
    <span style="font-size: 12px; padding: 4px 12px; border-radius: var(--radius); background: var(--surface-1); color: var(--text-secondary);">{状态或类别徽标，可省}</span>
  </div>
  <table style="width: 100%; font-size: 13px; border-top: 0.5px solid var(--border); padding-top: 8px;">
    <tr><td style="color: var(--text-secondary); padding: 4px 12px 4px 0; width: 120px; vertical-align: top; white-space: nowrap;">{行标签}</td><td style="padding: 4px 0;">{行内容}</td></tr>
  </table>
  <p style="font-size: 13px; color: var(--text-secondary); margin: 12px 0 4px;">{多行块标题，如 提示词 / 经验原文；没有就整段省}</p>
  <pre style="margin: 0; padding: 12px; background: var(--surface-1); border-radius: var(--radius); font-family: var(--font-mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;">{多行原文}</pre>
  <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px;">
    <button data-say="{画师原话}">{按钮文字} ↗</button>
  </div>
</div>
<script>document.querySelectorAll('button[data-say]').forEach(function (b) { b.addEventListener('click', function () { sendPrompt(b.dataset.say); }); });</script>
```

槽位对应关系：

| 卡 | 卡名 | 行 | 多行块 | 按钮（`data-say` = 画师会说的原话） |
|---|---|---|---|---|
| 七件套收尾 | 收尾 | 当前步骤 / 完成状态 / 本步产物 / 需要你检查 / 可选操作 / 进入下一步的条件（video 版无「可选操作」） | 无 | 「下一步可直接说的话」每条一个按钮，`data-say` 就是那句原话 |
| 总控进度卡 | 进度 | 项目 / 环境 / 角色 / UI / 视频 / 建议下一步 | 无 | 「你可以直接说」每条一个按钮（1–3 个） |
| 沉淀确认卡 | 沉淀确认 | slot / 评分 / 证据图 | 经验原文（那一行） | `沉淀这条` / `不用沉这张` |
| 画布确认卡 | 出图确认 | 画布 / 生成面节点 / 模型 / 素材节点 / 数量与参数 / 费用状态 | 提示词摘要 | `出图` / `要改` / `先不出`（画布无 job_id，不带 id） |
| MCP 生成确认卡 | 出图确认 | 目标 / 模型 / 参考清单 / 参数 / 费用状态 / 配置来源 | 提示词 | `出图 <request_id>` / `要改 <request_id>` / `先不出 <request_id>` |

按钮回话与判定的对应同第二节：肯定 → 推进（MCP 路径下即调 `workshop_approve_generation`，或请画师去「待批准生成」页），
「要改」→ 先问改点，「先不出」→ 停。七件套 / 进度卡的按钮只是把「可直接说的话」变成一键可点，
点了就当画师原样说了那句话。

HTML 里的 `<` `&` `"` 必须转义（`&lt;` `&amp;` `&quot;`），提示词原文尤其注意；不加 emoji、不加渐变 / 阴影、不放 `<style>` 块。

## 四、出图结果卡（job 完成后）

`card <job_id>` 对 `done` / `partial` 的 job 自动输出**结果卡**：产物缩略图（长边 320px JPEG，data URI 内嵌）+
job_id / model / size / 张数 + 按钮。**卡片里只有缩略图**：show_widget 的 CSP 拦掉 `file://` 与 `127.0.0.1`，
iframe 里也没有本机 cookie，所以原图仍按 `docs/references/image-presentation.md` 的渲染通道另发（文件面板 / Markdown 图片），
结果卡不替代原图。视频 job 的结果卡只列路径不预览。

| 按钮 | 画师侧发出的话 | 对应处理 |
|---|---|---|
| vN 定稿 | `vN 定稿` | 按各 SKILL.md 的定稿规则（AskUserQuestion 确认后 `set-canonical`） |
| 要改 | `要改 <job_id>` | 先问改点与 A / B / C 模式，再重新 submit 出新确认卡 |
| 先放着 | `先放着 <job_id>` | 不推进，进入七件套收尾 |

出图完成的顺序：结果卡 → 原图（渲染通道）→ 收尾验证 → 七件套。文本通道没有结果卡，直接原图 + 七件套。

## 五、不变的事

- 卡是**停下等回复**的信号，不是流程推进。卡出完本轮结束，任何自动 run-job / approve 都违规。
- 「结构化提问工具不可用时的【待确认】文本卡」是 AskUserQuestion 的降级，与本文无关：有 `show_widget` 的环境必然有 AskUserQuestion，仍用 AskUserQuestion 提问。
- 文本卡格式（各 SKILL.md 代码块）保持不变，是所有非 widget 环境的唯一形态。
