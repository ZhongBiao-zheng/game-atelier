> **DEPRECATED** — 自 2026-05-21 起,新经验请用 `append-memory` CLI 写入工作区 `MEMORY.md` 或项目级 `projects/<slug>/MEMORY.md`。
> 本文件保留历史档案,context_loader 不再读取,SKILL 也不再追加。

# 立绘出图历代经验 · LESSONS

> Skill #1 `/character-workflow` 收尾时（job DONE / FAILED 有明确原因 / spec 归档），
> 默认主动询问"要不要把本轮 prompt 经验沉淀一句到 lessons？"；画师明确授权 Skill 自行判断时，
> 直接追加 1–2 条能复用的经验到本文件末尾。
>
> **一条经验 = 一行 markdown，格式严格**：
> ```
> - YYYY-MM-DD <角色 id> · <一句话决策/教训/亮点> · prompt 片段：`...`
> ```
>
> **软上限 50 条**。超过时 context_loader 在 stderr 告警，建议人工分卷归档（暂未做工具）。
> 不自动去重 / 不自动总结 —— 想合并相似条目自己编辑。
>
> 手动编辑后**无须重启 server**，下次 Skill 启动会把全文拼到 portrait 专家人设 prompt 前缀。

## 经验条目（按时间倒序）

<!-- 第一条经验由首次完整跑通 /character-workflow 后追加。 -->
- 2026-05-21 young-emperor-monkey · 精灵类角色首轮出图避免直呼现有 IP 与“幼年+强攻”等组合，改成原创怪兽图鉴风、初阶形态、蓄势展示动作更稳 · prompt 片段：`原创日式怪兽图鉴官方设定图风格，适合全年龄向游戏角色`
- 2026-05-21 young-emperor-monkey · Lovart 返回 artifact 但 runner 因 final_status=timeout 或 downloader failed 标失败时，先检查响应里的 artifacts URL，再用 curl -sS -L --fail 手动补下载并回填 job · prompt 片段：`download failed + artifacts/agent/*.png`
- 2026-05-21 blazefist-monkey · 出进化形态立绘时把前置进化 portrait/v1.png 上传为参考图，能保持配色血统一致性 · 操作：lovart_wrapper upload + chat --attachments CDN_URL
- 2026-05-21 blazefist-monkey · lovart_wrapper upload_file 用 curl 子进程代替 requests，绕开服务端 chunked 响应提前关闭导致空 body 的问题 · 关键代码：subprocess.check_output(['curl', '-sS', '-F', 'file=@path', url])
- 2026-05-21 holy-spirit-priestess · 画师改已出图必须先问修改模式（A 编辑当前图 / B 完全重出 / C 局部参考重出），三种 prompt 写法互斥，混着写会让模型不知道锚定参考图还是按 prompt 重画 · 操作：AskUserQuestion 三选一
- 2026-05-21 holy-spirit-priestess · A 模式编辑当前图时 prompt 只写差异指令，不重述外观/画风/规格（参考图已承载），引导而非规定，能短就短 · prompt 片段：`以参考图为底图，仅做以下三处改动：1. 武器... 2. 披风纹理... 3. 动作...`
