# game-ui-ai-workflow MEMORY (工作区共享)

> 跨项目通用的工具/协议/流程经验。项目特定经验请写到 `projects/<slug>/MEMORY.md`。

## character-workflow

### Portrait

- 2026-05-21 young-emperor-monkey · Lovart 返回 artifact 但 runner 因 final_status=timeout 或 downloader failed 标失败时,先检查响应里的 artifacts URL,再用 curl -sS -L --fail 手动补下载并回填 job · prompt 片段:`download failed + artifacts/agent/*.png`
- 2026-05-21 blazefist-monkey · lovart_wrapper upload_file 用 curl 子进程代替 requests,绕开服务端 chunked 响应提前关闭导致空 body 的问题 · 关键代码:subprocess.check_output(['curl', '-sS', '-F', 'file=@path', url])
- 2026-05-21 holy-spirit-priestess · 画师改已出图必须先问修改模式(A 编辑当前图 / B 完全重出 / C 局部参考重出),三种 prompt 写法互斥,混着写会让模型不知道锚定参考图还是按 prompt 重画 · 操作:AskUserQuestion 三选一
- 2026-05-21 holy-spirit-priestess · A 模式编辑当前图时 prompt 只写差异指令,不重述外观/画风/规格(参考图已承载),引导而非规定,能短就短 · prompt 片段:`以参考图为底图,仅做以下三处改动:1. 武器... 2. 披风纹理... 3. 动作...`

### Promo

- 2026-05-21 young-emperor-monkey · runner 报 output_paths missing 但 artifact URL 已存在时,curl -sS -L --fail <url> 兜底下载后手动回填 output_paths + status=done · prompt 片段:N/A(操作经验)
- 2026-05-21 young-emperor-monkey · GPT Image 2 没有原生 16:9,只需用 --size 告知尺寸(如 1536x1024)模型即可按尺寸出图;prompt 文本里不必再写"16:9 横版"等画幅描述词 · prompt 片段:`--size 1536x1024`

### Turnaround
