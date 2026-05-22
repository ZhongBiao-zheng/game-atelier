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
JOB_ID=$(uv run python -m character_workflow submit \
  --kind portrait --prompt-file /tmp/cw-prompt-$$.md)
rm /tmp/cw-prompt-$$.md
echo "$JOB_ID"
```

要点：
- `--character` 缺省读 `.runtime/active-character.json`，stage A/B/C 时**必传**
- `--n` 默认 1，画师明示"多出几张"才传 `--n 4`
- 调用方负责创建 + 删除临时 prompt 文件（避免 `/tmp` 残留）
- stdout 是纯 job_id 字符串，可直接 `$(...)` 捕获
- `--source-image` 会同时写入顶层 `source_image` 和 `params.reference_images`
- 落盘后 watcher 广播 `job-changed`，Web 端 CharacterGallery 自动渲染"待确认"卡片

### 2. 终端出图卡片格式

确认卡片必须包含即将提交给模型的完整 prompt 原文。不能用摘要、文件路径、"见上文"、"同 spec" 或省略号替代。

```
即将调用：
- 模型 / 厂家：gpt_image_2 (OpenAI via Lovart)
- 出图尺寸：1024×1024
- 数量：4 张
- 参考图：（无）/ <path>
- 中文 prompt：
  <PROMPT_START>
  <逐字贴出本次将提交给模型的完整 prompt，保留换行>
  <PROMPT_END>

确认出图吗？回"出图"/"确认"/"OK" 推进；不满意直接说要改哪段。
```

### 3. 画师确认后执行 runner

终端说"出图"/"确认"/"OK"/"go" 后，不再手拼 Lovart 命令：

```bash
uv run python -m character_workflow run-job "$JOB_ID"
```

如果画师只说"出图"，没有指定 job：

```bash
uv run python -m character_workflow run-latest --kind portrait
```

promo / turnaround 按对应 kind：

```bash
uv run python -m character_workflow run-latest --kind promo
uv run python -m character_workflow run-latest --kind turnaround
```

取消 → 改 prompt 重走第 1 步；或 `POST /api/jobs/<id>/cancel` 直接删 job 文件（pending_confirm 从未真出图，无保留意义）。

### 4. runner 做什么

runner 是唯一执行入口：

- 校验 `status == pending_confirm`
- 归一 `source_image -> params.reference_images`
- 上传参考图并写 `params.lovart_attachments`
- 标 `PENDING` 且清空旧 `error`
- 调 project-local `lovart_wrapper.py`，清空 proxy env，使用 Lovart `chat --json --download`
- 下载到 temp，筛掉 0 字节/无效图片，再移动到 `characters/<id>/<kind>/vN.png`
- 写 `vN.md` sidecar
- `DONE` 时写 `output_paths`、`actual_size`、`lovart_thread_id`、`lovart_final_status`、`warnings`，并清空旧 `error`

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
- `PENDING_CONFIRM` 卡片只给 prompt 文件路径、摘要、"同 spec" 或带 `...` 的截断 prompt
- 硬编码 cfg_scale 等 Lovart 内部参数
- 用英文 prompt
- 一次出超过 4 张
