# TODOS — 游戏角色资产工作流

> 最后更新：2026-05-15（/plan-eng-review 产出）
> 格式：优先级 P1/P2/P3，工期 S(<4h) / M(<1d) / L(<3d) / XL(>3d)

---

## P1 — writing-plans 第一步完成（阻塞实施）

> /plan-eng-review 发现以下 5 项必须在 writing-plans 任务卡中最先完成，否则 Skill 端与 Web 端实施者会做出相互矛盾的实现。

### [T1] jobs/*.json 字段 schema（双端合同）
- **背景**：Eng Review Q-1：`jobs/<job_id>.json` 已列出 7 个字段但没有精确类型定义、`params` 是 string 还是 object 不明、`status` 枚举值未定、Web 可编辑字段白名单缺失。两端各自推断会在集成时爆出类型不匹配。（原 P2 项升级）
- **行动**：writing-plans 第一个任务卡定义 TypeScript interface + 可编辑字段白名单 + `status` 枚举
- **验收**：`schema/jobs.ts` 文件存在，Skill 和 React 组件均 import 同一 interface
- **工期**：S（CC ~5 min）
- **依赖**：无（先行，其他任务依赖它）

### [T2] API 端点 Pydantic schema 定义
- **背景**：Eng Review Q-2：`POST /spec/<id>`、`POST /prompt/<job_id>`、`POST /feedback`、`POST /clipboard-attempt` 均无 request body 格式定义。FastAPI Pydantic model 是解药，且可自动生成 OpenAPI 文档。
- **行动**：writing-plans 第一个任务卡同时定义 4 个端点的 Pydantic model
- **验收**：`python server.py` 启动后 `/docs` 能看到所有 POST 端点的 schema
- **工期**：S（CC ~10 min）
- **依赖**：T1（jobs schema）

### [T3] Skill 写 `.runtime/active-character.json`
- **背景**：Eng Review Outside Voice #1：Skill 主循环引用 `characters/<active>.md` 但 `<active>` 由谁决定未定义。决策：Skill 处理某角色时写此文件，Web 左栏读取并高亮当前角色；画师在 Web 点左栏也写此文件，Skill 下次 turn 感知。
- **行动**：Skill turn 起始增加一步：读 `.runtime/active-character.json` 获取 `active_id`；处理角色后同步写回确认
- **验收**：Web 左栏在 Skill 跑完一次后自动高亮正确角色
- **工期**：S（CC ~5 min）
- **依赖**：T1

### [T4] viewer-server 启动时清理 stale `server.pid`
- **背景**：Eng Review A-4 + Outside Voice #5（两个模型独立发现）：CC 崩溃时 `stop` 命令不执行，`server.pid` 残留，画师下次启动报端口冲突。这是每个工作日都会踩到的问题。
- **行动**：`viewer-server start` 时检查 pid 文件是否存在且进程是否存活；若进程已死则删除 pid 文件再继续；若进程存活则跳过启动直接返回已运行端口
- **验收**：手动 `kill <viewer-server-pid>`，再次运行 `start` 不报端口冲突
- **工期**：S（CC ~10 min）
- **依赖**：无

### [T5] draft 处理改为原子 rename
- **背景**：Eng Review D2 决策：当前"列出文件 → 处理 → 移动"有竞态窗口，Web 在列出和移动之间写入的 draft 会被移走但未读，画师反馈永久丢失。
- **行动**：Skill turn 起始改为"rename `draft/*.md` → `processing/<ts>.md`（原子）→ 读 processing/ → move to draft-processed/"
- **验收**：pytest `tests/test_draft.py` — 并发写入场景无 draft 丢失
- **工期**：S（CC ~5 min）
- **依赖**：无

---

## P2 — B+ 实施期间

### [T6] SSE 断连后触发全量 GET /images 刷新
- **背景**：Eng Review P-1：浏览器 tab 进入后台 >30s 后 SSE 连接被节流，重连后可能错过期间所有文件变化通知，图廊静止无任何提示（静默失败）。
- **行动**：前端 `EventSource` 断连重连时自动发一次 `GET /images` 全量刷新；server 在 SSE 响应头加 `retry: 3000`
- **验收**：playwright test — 关闭后重开 tab，图廊自动显示最新图片
- **工期**：S（CC ~15 min）
- **依赖**：无

### [T7] 澄清 POST /prompt 职责（文档歧义）
- **背景**：Eng Review Outside Voice #6：§4.2.A 写"复制 prompt 字段 = 触发剪贴板写入'继续 + 改后的 prompt'"，但没说 `POST /prompt/<job_id>` 端点本身只更新元信息显示，**不**直接触发重出图。两者混淆会导致实施者为 POST /prompt 增加不必要的 Skill 回调逻辑。
- **行动**：在 §4.2.A 图廊交互模式小节补一行澄清说明
- **验收**：writing-plans 开发者能 10 秒内说清 POST /prompt 做什么、不做什么
- **工期**：S（CC ~5 min）
- **依赖**：无

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
| [eng-review] 架构与测试 | /plan-eng-review 完成（2026-05-15）：D1 技术栈（Python FastAPI + React）、D2 原子 rename、D3 active-character；9 个实施要求转为 P1/P2 任务；Outside Voice 7 问题已处理；3 个关键缺口转为 T3/T4/T5 |
