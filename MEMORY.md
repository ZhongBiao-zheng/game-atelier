# game-ui-ai-workflow MEMORY (工作区共享)

> 跨项目通用的工具/协议/流程经验。项目特定经验请写到 `projects/<slug>/MEMORY.md`。

## character-workflow

### Portrait

- 2026-05-21 young-emperor-monkey · Lovart 返回 artifact 但 runner 因 final_status=timeout 或 downloader failed 标失败时,先检查响应里的 artifacts URL,再用 curl -sS -L --fail 手动补下载并回填 job · prompt 片段:`download failed + artifacts/agent/*.png`
- 2026-05-21 blazefist-monkey · lovart_wrapper upload_file 用 curl 子进程代替 requests,绕开服务端 chunked 响应提前关闭导致空 body 的问题 · 关键代码:subprocess.check_output(['curl', '-sS', '-F', 'file=@path', url])
- 2026-05-21 holy-spirit-priestess · 画师改已出图必须先问修改模式(A 编辑当前图 / B 完全重出 / C 局部参考重出),三种 prompt 写法互斥,混着写会让模型不知道锚定参考图还是按 prompt 重画 · 操作:AskUserQuestion 三选一
- 2026-05-21 holy-spirit-priestess · A 模式编辑当前图时 prompt 只写差异指令,不重述外观/画风/规格(参考图已承载),引导而非规定,能短就短 · prompt 片段:`以参考图为底图,仅做以下三处改动:1. 武器... 2. 披风纹理... 3. 动作...`
- test entry

### Promo

- 2026-05-21 young-emperor-monkey · runner 报 output_paths missing 但 artifact URL 已存在时,curl -sS -L --fail <url> 兜底下载后手动回填 output_paths + status=done · prompt 片段:N/A(操作经验)
- 2026-05-21 young-emperor-monkey · GPT Image 2 没有原生 16:9,只需用 --size 告知尺寸(如 1536x1024)模型即可按尺寸出图;prompt 文本里不必再写"16:9 横版"等画幅描述词 · prompt 片段:`--size 1536x1024`
- 2026-05-22 blazefist-monkey · Lovart 一次只消化一张参考图，立绘 vs 画师上传图必须二选一；默认选立绘锚定身份，镜头/光线/色调维度全部用文字 prompt 描述完成 · prompt 片段：N/A（架构事实）
- 2026-05-22 blazefist-monkey · 参考图是异种生物时（如 KV 图里是人小孩），prompt 第1段必须点明本角色生物种类（猴子角色/狐狸角色/龙角色），否则 Lovart agent 会把参考图里的生物当主体直接拒绝出图 · prompt 片段：`以上传图中的猴子角色为画面核心`
- 2026-05-22 blazefist-monkey · 报 'Project xxx does not exist' 时，~/.lovart/state.json 的 active_project 已被 Lovart 后端 GC；清掉 active_project 字段 + 删除 projects map 里的 dead 条目后重试，lovart-api 会自动新建 project · prompt 片段：N/A（操作经验）
- 2026-05-22 blazefist-monkey · runner 不自动上传立绘，--source-image 必须显式传立绘；prompt-promo-zh 第五节关于"隐式 subject_image"是理论模型不是实际行为 · prompt 片段：N/A（架构事实）

### Turnaround
