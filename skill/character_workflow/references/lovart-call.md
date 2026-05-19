# 出图调用流程（Lovart）

SKILL.md 已经写了 6 步主线，这里只补**代码片段**和**失败处理**。哲学（为什么要确认、不许跳步）见 SKILL.md。

## 前提

- spec 已按 `spec-protocol.md` 问清（无 `?` 占位）
- prompt 已按 `prompt-zh.md` 写成中文 8 段
- `.runtime/config.json` 里 `image_storage_root` 已配置

## 代码片段

### 1. 落盘 PENDING_CONFIRM

prompt 走文件（8 段式中文几百字，作为 shell 参数会被引号/顿号/换行卡）：

```bash
# 写到临时文件（PID 后缀避免并发冲突）
cat > /tmp/cw-prompt-$$.md <<'PROMPT'
...中文 8 段式 prompt...
PROMPT

# submit 子命令是默认值 SSoT —— 不要自己决定 model / n / size
JOB_ID=$(uv run python -m skill.character_workflow submit \
  --kind portrait --prompt-file /tmp/cw-prompt-$$.md)
rm /tmp/cw-prompt-$$.md
echo "$JOB_ID"
```

要点：
- `--character` 缺省读 `.runtime/active-character.json`，stage A/B/C 时**必传**
- `--n` 默认 1，画师明示"多出几张"才传 `--n 4`
- 调用方负责创建 + 删除临时 prompt 文件（避免 `/tmp` 残留）
- stdout 是纯 job_id 字符串，可直接 `$(...)` 捕获
- 落盘后 watcher 广播 `job-changed`，Web 端 CharacterGallery 自动渲染"待确认"卡片

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
