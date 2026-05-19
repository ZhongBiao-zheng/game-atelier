# 出图调用流程（Lovart）

SKILL.md 已经写了 6 步主线，这里只补**代码片段**和**失败处理**。哲学（为什么要确认、不许跳步）见 SKILL.md。

## 前提

- spec 已按 `spec-protocol.md` 问清（无 `?` 占位）
- prompt 已按 `prompt-zh.md` 写成中文 8 段
- `.runtime/config.json` 里 `image_storage_root` 已配置

## 代码片段

### 1. 落盘 PENDING_CONFIRM

```bash
python -c "
from skill.character_workflow.lib.jobs import write_job
from ulid import ULID
job_id = f'job-{ULID()}'
write_job(
    job_id=job_id,
    character_id='holy-spirit-priestess',
    prompt='...中文 prompt...',
    model='gpt_image_2',
    params={
        'vendor': 'OpenAI (via Lovart)',
        'size': '1024x1024',
        'n': 4,
        'reference_images': [],
    },
    seed=None,
)  # 默认 status=PENDING_CONFIRM
print(job_id)
"
```

落盘后 watcher 广播 `job-changed`，Web 端 CharacterGallery 自动渲染"待确认"卡片。

### 2. 终端出图卡片格式

```
即将调用：
- 模型 / 厂家：gpt_image_2 (OpenAI via Lovart)
- 出图尺寸：1024×1024
- 数量：4 张
- 参考图：（无）/ <path>
- 中文 prompt：
  「...」

确认出图吗？回"出图"/"确认"/"OK" 推进；不满意直接说要改哪段。
```

### 3. 画师确认后推进

- 终端说"出图"/"确认"/"OK"/"go" → 下一轮 turn 把 `status` 改 `PENDING`
- Web 点确认 → `POST /api/jobs/<id>/confirm` 自动改 `PENDING`
- 取消 → 改 prompt 重走第 1 步；或 `POST /api/jobs/<id>/cancel` 标 `FAILED + error="画师取消"`

### 4. 调 lovart-api（job 停在 PENDING）

```bash
# 直接调 /Users/zhengzhongbiao/.claude/skills/lovart-api/
# 默认 chat，--include-tools generate_image_gpt_image_2
# --output-dir <image_storage_root>/<character_id>/<job_id>/
# --json --download
```

调用是同步阻塞的，画师看不到中间态，所以 job 整个调用期间停在 `PENDING`。返回后：
- 成功 → `update_job_status(job_id, status=JobStatus.DONE, output_paths=[...])`
- 失败 → `update_job_status(job_id, status=JobStatus.FAILED, error=...)`

### 5. 终端贴图

```
出图完成（共 N 张）：

![v1](/Users/.../v1.png)
![v2](/Users/.../v2.png)
![v3](/Users/.../v3.png)
![v4](/Users/.../v4.png)
```

要点：绝对路径；alt 用 `v1/v2/...` 序号方便画师指；每张一行；末尾提一句"Web 也能看，或直接说要改哪张"。

## 失败处理

- 网络/凭证失败 → 写 error，问画师重试还是改 prompt
- 输出路径不可写 → 提醒 `image_storage_root` 是否被外部移除/锁定

## 不要做的事

- 跳第 1–3 步直接调 lovart-api
- `PENDING_CONFIRM` 卡片省略 vendor/size/n/参考图
- 硬编码 cfg_scale 等 Lovart 内部参数
- 用英文 prompt
- 一次出超过 4 张
