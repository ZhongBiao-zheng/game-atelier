---
status: accepted
---

# Agent 接入分三层：知识在 Skill、手可换、批准按能力分级

本决定取代 ADR-0016 中「Skill 只经 MCP 操作、付费批准只在 Atelier 页面」两条；
其余部分（官方 SDK、typed 工具、服务端冻结与幂等）保留。

## 三层各自回答一个问题

| 层 | 问题 | 载体 | 变更方式 |
| --- | --- | --- | --- |
| 知识 | 怎么写 prompt、问什么、记什么经验 | Skill：SKILL.md、references、turn-start 四层记忆、经验沉淀 | 只随创作方法演进，不随传输层变 |
| 手 | 怎么读写应用数据、触发动作 | CLI（Bash 直跑 Python）或 MCP（工具 → HTTP → 同一段 Python） | 两条手打同一业务层，行为必须一致 |
| 批准 | 谁能按下付费按钮 | 授权能力，记录在服务端 | 按 Agent 会话的能力决定，不按传输层决定 |

PR #82 把三层焊在一起：换手的同时把批准搬到浏览器，并删掉知识层的记忆闭环。
结果是本机 Claude Code / Codex 用户每次出图多两次窗口切换，且失去跨项目经验。这是设计错误，不是 MCP 的成本。

## 决定

1. **知识层不动。** turn-start 的四层记忆注入、pending_distill、append-memory、spec 对话协议、模型路由
   全部保留在 Skill。MCP 路径需要同等上下文时，由工具提供同名字段（含跨项目 `MEMORY.md` 经验）
   并新增写经验工具；不能因为「没有工具」而删闭环。
2. **手可换，业务层唯一。** `workshop.py` / `workshop_generation.py` 是 Character、UI、Video 的业务层；
   CLI 与 MCP 都只是它的调用方。Skill 按可用性选手：`workshop_*` 工具可见则用工具，否则用 CLI。
   CLI 保留 `submit → 终端确认 → run-job` 的现有形态，不退化为只准 prepare。
3. **批准按能力分级。** Agent 授权新增 `execute_generation` 能力。持有者可直接批准自己准备的请求，
   服务端记录批准来源为该授权；本机用户给自己的 Claude Code / Codex 满能力，终端确认即批准。
   不持有者的请求才落到 Atelier「待批准生成」页面。页面是审计与兜底，不是必经之路。
   `run_job` 继续接受 `PENDING_CONFIRM`，CLI 路径的批准记录写在 Job 上；工坊请求路径的批准记录写在请求上。
4. **画布 MCP 独立。** 画布是 server 持有、带修订号、前端实时渲染的活文档，CLI 改文件会绕过并发控制，
   这是 MCP 相对 CLI 真正的增量。画布工具集单独授权、单独工具前缀，遵守 ADR-0011 的 change set 与
   逐次确认规则；不与工坊工具共用授权，也不继承工坊能力。ADR-0011 目前只有会话记录落地，
   read / propose / status 工具尚未实现，属于本决定之后的新工作。

## 不做

不把 MCP 当唯一入口；不在服务端信任聊天文本或布尔参数作为批准（批准来源必须是持有能力的会话）；
不为 MCP 复制第二套 prompt、模型路由或归档逻辑；不把网站配对（P2）作为本地能力的前置条件。

## 对 PR #82 的处置

保留：连接鉴权与授权凭据、`workshop.py` 业务层、MCP 适配器与 13 个工具、批准事务与幂等恢复。
退回：10 个 Skill 的 MCP-only 重写、CLI 只准 prepare、`run_job` 拒收 `PENDING_CONFIRM`、页面唯一批准、
参考图必须先上传（CLI 路径保留 `--reference-image` 直传）。
新增：`execute_generation` 能力、经验读写工具、Skill 的选手规则、路由白名单补齐 main 新增路由
并让守卫测试覆盖全部 router。
