# TODOS — 游戏角色资产工作流

> 最后更新：2026-05-15（/plan-design-review 产出）
> 格式：优先级 P1/P2/P3，工期 S(<4h) / M(<1d) / L(<3d) / XL(>3d)

---

## P1 — 阻塞下一步

*（当前无 P1 阻塞项，可进入 writing-plans）*

---

## P2 — B+ 实施期间

### [impl] 图片元信息面板字段定义
- **背景**：v2.1 §4.2 交付物 9 规定每张图写 `.runtime/jobs/<job_id>.json` 包含 `prompt / submitted_at / model / params / seed / output_path / status`。字段白名单、可编辑字段范围、前端 editor 校验规则需在开始写 Web 前敲定，否则实施者无法写 schema。
- **行动**：writing-plans 阶段在"交付物 9"的任务卡里补充字段 schema + 可编辑字段白名单
- **验收**：jobs/*.json 有确定的 TypeScript interface / JSON schema 文档
- **工期**：S（CC ~30 min）
- **依赖**：writing-plans 阶段开始

### [impl] 绑定地址规范：127.0.0.1 不是 0.0.0.0
- **背景**：viewer-server 若监听 0.0.0.0，在共享 WiFi 下同网段其他人可以访问画师的角色档案和出图。小但真实的 security surface。
- **行动**：writing-plans / 实施时确保 server 绑定 `127.0.0.1`（或 `--host 127.0.0.1` flag），README 加一行说明
- **验收**：`ss -tlnp | grep 5173` 只显示 `127.0.0.1:5173`
- **工期**：S（5 min 改一行代码）
- **依赖**：无

---

## P2 — V2 议题（B+ 上线后评估）

### [v2] Web 内独立"出图板块"
- **背景**：用户在 CEO Review 中提出"两种操作模式"——(1) 查看/复制历史出图的 prompt → 去终端手动发；(2) Web 内直接配 API key、选模型、触发出图。(1) 已纳入 B+（交付物 9 侧面板）。(2) 本项指后者：Web 内完整的独立出图能力。
- **为什么暂不做**：违反"零账号"哲学锚（需配 API key）；与 Skill 主路径职责重叠（需说清两者如何共存）；B+ 上线前无法验证画师真实需求。
- **触发条件**：B+ 上线 4 周后，若画师频繁手动复制 prompt 去终端出图（M3 可观测性数据显示），则评估是否提前立项
- **行动**：B+ 上线 4 周时，用画师访谈数据 + jobs/*.json 使用数据决策
- **工期**（如立项）：L（人类: 3-5 天 / CC: ~4-8h）
- **依赖**：B+ 上线 + 4 周使用数据

---

## 已关闭

| 项 | 关闭原因 |
|---|---|
| B+ 验收标准（TBD）| v2.1 §4.6 已回填 4 个可测指标（2026-05-15）|
| [design-review] 三栏 UI 设计缺口 | /plan-design-review 7 passes 完成；D1 图廊交互模式决策落地；v2.3 §4.2.A 全量补充（2026-05-15）|
