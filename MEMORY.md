# game-ui-ai-workflow MEMORY (工作区共享)

> 跨项目通用的工具/协议/流程经验。项目特定经验请写到 `projects/<slug>/MEMORY.md`。

## character-workflow

### Portrait

- 2026-05-21 young-emperor-monkey · Lovart 返回 artifact 但 runner 因 final_status=timeout 或 downloader failed 标失败时,先检查响应里的 artifacts URL,再用 curl -sS -L --fail 手动补下载并回填 job · prompt 片段:`download failed + artifacts/agent/*.png`
- 2026-05-21 blazefist-monkey · lovart_wrapper upload_file 用 curl 子进程代替 requests,绕开服务端 chunked 响应提前关闭导致空 body 的问题 · 关键代码:subprocess.check_output(['curl', '-sS', '-F', 'file=@path', url])
- 2026-05-21 holy-spirit-priestess · 画师改已出图必须先问修改模式(A 编辑当前图 / B 完全重出 / C 局部参考重出),三种 prompt 写法互斥,混着写会让模型不知道锚定参考图还是按 prompt 重画 · 操作:AskUserQuestion 三选一
- 2026-05-21 holy-spirit-priestess · A 模式编辑当前图时 prompt 只写差异指令,不重述外观/画风/规格(参考图已承载),引导而非规定,能短就短 · prompt 片段:`以参考图为底图,仅做以下三处改动:1. 武器... 2. 披风纹理... 3. 动作...`
- 2026-05-25 通用 · job DONE 后必须立即把 vN.png + job_id + 模型 + 尺寸 + subject_image + 已知偏差落到 spec.md 对应小节（出图记录 / 美宣记录 / 三视图记录）；漏记会让下一轮 turn-start 时画师以为没出过，差点盲目重出。runner 应在 status=done 时强制同步 spec，不能只靠 Skill 主动写入。 · 操作经验，无 prompt 片段
- test entry

### Promo

- 2026-05-21 young-emperor-monkey · runner 报 output_paths missing 但 artifact URL 已存在时,curl -sS -L --fail <url> 兜底下载后手动回填 output_paths + status=done · prompt 片段:N/A(操作经验)
- 2026-05-21 young-emperor-monkey · GPT Image 2 没有原生 16:9,只需用 --size 告知尺寸(如 1536x1024)模型即可按尺寸出图;prompt 文本里不必再写"16:9 横版"等画幅描述词 · prompt 片段:`--size 1536x1024`
- 2026-05-22 blazefist-monkey · Lovart 一次只消化一张参考图，立绘 vs 画师上传图必须二选一；默认选立绘锚定身份，镜头/光线/色调维度全部用文字 prompt 描述完成 · prompt 片段：N/A（架构事实）
- 2026-05-22 blazefist-monkey · 参考图是异种生物时（如 KV 图里是人小孩），prompt 第1段必须点明本角色生物种类（猴子角色/狐狸角色/龙角色），否则 Lovart agent 会把参考图里的生物当主体直接拒绝出图 · prompt 片段：`以上传图中的猴子角色为画面核心`
- 2026-05-22 blazefist-monkey · 报 'Project xxx does not exist' 时，~/.lovart/state.json 的 active_project 已被 Lovart 后端 GC；清掉 active_project 字段 + 删除 projects map 里的 dead 条目后重试，lovart-api 会自动新建 project · prompt 片段：N/A（操作经验）
- 2026-05-22 blazefist-monkey · runner 不自动上传立绘，--source-image 必须显式传立绘；prompt-promo-zh 第五节关于"隐式 subject_image"是理论模型不是实际行为 · prompt 片段：N/A（架构事实）

### Turnaround

### Studio

- 2026-05-29 通用 · 火山 Seedream 4.5 的尺寸下限是总像素面积 `3686400`，不是单边 `1296px`；`1296x1296` 只有 1,679,616 像素会 400，1:1 最小合法尺寸应抬到 `1920x1920`。前端输入、提交 payload 和后端 caller 都要按面积兜底，避免历史 job / 再次生成绕过 UI。 · 操作经验，无 prompt 片段
- 2026-05-29 通用 · OpenAI-HK / 类 OpenAI 图像接口可能把图片地址包装成 Markdown 文本，甚至返回 `url](url` 这种半截链接；后端下载前必须清洗 URL，再交给 requests/curl，否则会把脏尾带进 CDN 请求并报 `download image 404`。 · 操作经验，无 prompt 片段
- 2026-05-29 通用 · 火山 Seedream 兼容 `/images/generations` 即使请求 `n=2` 也可能只返回 1 张，不能把返回数量当作用户意图；caller 需按 `params.n` 校验落盘数量，少于请求数时补发单图请求并续写 `v2/v3...`。 · 操作经验，无 prompt 片段
- 2026-05-29 通用 · viewer-server 默认服务 `web/dist`，前端源码改完但未重新 build 时，浏览器仍会看到旧 UI；排查“源码已改但 Web 没变”要先看 `web/dist` 时间戳和 bundle 内容，再重建 dist。 · 操作经验，无 prompt 片段

<!-- session-count: 3/5 -->
