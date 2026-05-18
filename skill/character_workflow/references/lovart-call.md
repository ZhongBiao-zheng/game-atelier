# 出图调用流程（Lovart）

## 核心原则

**不许直接调 Lovart。** 先把调用参数完整打到台面上，画师看清楚后明确确认（终端说"出图"/"确认"，或 Web 上点确认按钮），再动手。出图要钱、要时间，让画师裸眼复核一次永远不亏。

## 前提

- spec 已经按 `spec-protocol.md` 问清楚（不许带 `?` 占位）
- prompt 已经按 `prompt-zh.md` 写成中文 8 段式
- `.runtime/config.json` 里 `image_storage_root` 已配置

## 步骤

### 1. 把"出图卡片"落盘（PENDING_CONFIRM）

```bash
python -c "
from skill.character_workflow.lib.jobs import write_job_pending_confirm
from ulid import ULID
job_id = f'job-{ULID()}'
write_job_pending_confirm(
    job_id=job_id,
    character_id='holy-spirit-priestess',
    prompt='...中文 prompt...',
    model='gpt_image_2',
    params={
        'vendor': 'OpenAI (via Lovart)',
        'size': '1024x1024',
        'n': 4,
        'reference_images': [],   # 用户给的参考图路径，没有就空
    },
    seed=None,
)
print(job_id)
"
```

这条 job 落盘后，watcher 会广播 `job-changed`，Web 端 CharacterGallery 会在画廊上方渲染一张"待确认"卡片，展示完整调用细节。

### 2. 在终端打出可读的出图卡片

回话里给画师看，**所有字段都列全**（不要省略，画师要复核的就是这些）：

```
即将调用：
- 模型 / 厂家：gpt_image_2 (OpenAI via Lovart)
- 出图尺寸：1024×1024
- 数量：4 张
- 参考图：（无）/ <path>
- 中文 prompt：
  「圣灵祭祀（女）...
   头戴白色羽冠，金色发带...
   ...」

确认出图吗？回"出图"/"确认"/"OK" 推进；不满意直接说要改哪段。
```

### 3. 等画师确认

- 画师在 **终端** 说"出图"/"确认"/"OK"/"go" → Skill 在下一轮 turn 把 job `status` 改成 `PENDING`，进入第 4 步
- 画师在 **Web** 点确认按钮 → 后端 `POST /api/jobs/<id>/confirm` 直接改 `status=PENDING`，Skill 下次 turn 起始扫到这条 pending job 就动手
- 画师说"取消"/"重写" → 改 prompt 重新走第 1 步；或者前端点取消 → `POST /api/jobs/<id>/cancel` 把 job 标 FAILED + error="画师取消"

**不许**在 PENDING_CONFIRM 状态下直接 fork lovart-api。

### 4. 调 lovart-api（确认后才执行）

```bash
update_job_status(job_id, status=JobStatus.RUNNING)
# 调 /Users/zhengzhongbiao/.claude/skills/lovart-api/
# 默认 chat，--include-tools generate_image_gpt_image_2
# --output-dir <image_storage_root>/<character_id>/<job_id>/
# --json --download
```

调用返回后：

- 成功 → `update_job_status(job_id, status=JobStatus.DONE, output_paths=[...])`
- 失败 → `update_job_status(job_id, status=JobStatus.FAILED, error=...)`

### 5. 在终端用 markdown 展示出图结果

**必做。** Web 那边 SSE 会自动刷新，但画师在终端继续工作时也要能立刻看到图。出图成功后**立刻**在终端回话里打出每张图的 markdown 图片语法，让 CC 终端把图渲染出来：

```
出图完成（共 N 张）：

![v1](/Users/.../holy-spirit-priestess-v1.png)
![v2](/Users/.../holy-spirit-priestess-v2.png)
![v3](/Users/.../holy-spirit-priestess-v3.png)
![v4](/Users/.../holy-spirit-priestess-v4.png)
```

要点：
- 路径用**绝对路径**（`output_paths` 里就是绝对的）
- alt 文本用 `v1`/`v2`/... 序号，方便画师说"2 号那张再改"
- 每张一行，不要塞一行里
- 末尾顺手提一句"在 Web 也能看，或者直接说要改哪张"

### 6. SSE 自动刷新

不需要主动推。Watcher 看到 `.runtime/jobs/<id>.json` 变化就广播 `job-changed`，Web 端自动重渲染。

## 失败处理

- 网络/凭证失败 → 写 error，告诉画师重试还是改 prompt
- 输出路径不可写 → 提醒画师 `image_storage_root` 是否被外部移除/锁定

## 不要做的事

- **不要** 跳过第 1–3 步直接调 lovart-api —— 画师没看清楚就出图等于偷钱
- **不要** 在 PENDING_CONFIRM 卡片里把 vendor/size/n/参考图省略 —— 画师要的就是这些细节
- 不要硬编码 Lovart 内部参数（cfg_scale 等）—— 让 lovart-api skill 自己管
- 不要写英文 prompt 喂给 Lovart —— 画师全程中文链路（见 prompt-zh.md）
- 不要一次出超过 4 张
