> **DEPRECATED** — 自 2026-05-21 起,新经验请用 `append-memory` CLI 写入工作区 `MEMORY.md` 或项目级 `projects/<slug>/MEMORY.md`。
> 本文件保留历史档案,context_loader 不再读取,SKILL 也不再追加。

# 美宣图出图历代经验 · LESSONS

> Skill #2 `/character-promo` 收尾时（job DONE / FAILED 有明确原因），主动询问
> "要不要把本轮 prompt 经验沉淀一句到 lessons？"，画师答 Y 才追加到本文件末尾。
>
> **一条经验 = 一行 markdown，格式严格**：
> ```
> - YYYY-MM-DD <角色 id> · <一句话决策/教训/亮点> · prompt 片段：`...`
> ```
>
> **软上限 50 条**。超过时 context_loader 在 stderr 告警。
> 不自动去重 / 不自动总结。

## 经验条目（按时间倒序）

<!-- 第一条经验由首次完整跑通 /character-promo 后追加。 -->
- 2026-05-21 young-emperor-monkey · prompt 身份锚点全下放参考图，文本只写动作/场景/光/构图/风格骨架，比堆 spec 外观词准 · prompt 片段：`以上传图中的角色为画面核心，保留其外观和识别特征`
- 2026-05-21 young-emperor-monkey · 画风描述去 IP 名（不写宝可梦/帕鲁等），用客观笔触语言即可引导图鉴风 · prompt 片段：`清晰黑色轮廓线，平涂上色，柔和边缘阴影，卡通插画风格`
- 2026-05-21 young-emperor-monkey · runner 报 output_paths missing 但 artifact URL 已存在时，curl -sS -L --fail <url> 兜底下载后手动回填 output_paths + status=done · prompt 片段：N/A（操作经验）
- 2026-05-21 young-emperor-monkey · GPT Image 2 没有原生 16:9，只需用 --size 告知尺寸（如 1536x1024）模型即可按尺寸出图；prompt 文本里不必再写"16:9 横版"等画幅描述词 · prompt 片段：`--size 1536x1024`
- 2026-05-22 char-1779358169 火栗狐 · prompt 开头先声明图像主题/类型（"游戏美术宣传海报 · 角色 KV · 画幅"）+ 参考图协议紧跟第二句，然后才进入情节/光线/构图/风格描述；让 AI 在读情节前先进入海报创作 mode 并完成角色身份锚定 · prompt 片段：`游戏美术宣传海报 · 火栗狐角色 KV · 3:2 横版构图。以上传图中的狐狸角色为画面核心，保留其外观与识别特征。`
