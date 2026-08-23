# 03：设计 Canvas schema v2 与直接切换

Type: wayfinder:research

Status: in-progress

Blocked by: 02-resolve-canvas-domain-v2

## Question

什么样的项目、文档、节点、边、生成快照、Agent 会话、插件数据和资产索引 schema，既能表达
完整参考能力，又能直接删除 Canvas v1 后只保留一套运行路径？

## Deliverable

- Pydantic/TypeScript 双端 schema 草案、版本字段与文件布局。
- v2 初始文档、路径删除顺序和全量验证方案。
- 原子保存、并发冲突、媒体路径白名单、导入包校验和配额边界。
- API 变更表与 `docs/api-contract.md` 更新清单。

## Exit gate

删除 v1 schema、旧 API 字段和旧前端分支后，证明运行时只接受 v2，且全量测试通过。

## Proposal

- schema 与直接切换方案：`../canvas-schema-v2-proposal.md`
- proposed ADR：`../../../docs/adr/0008-separate-canvas-hot-document-from-sidecars.md`
- 推荐方案 A：revision 化热文档内保存不可变 Content Version，Generation Snapshot 内嵌 Canvas Job，
  library/Agent/plugin 使用分域 sidecar；运行时只接受 v2。

## Evidence

- 当前 Python/TS v1 schema、FastAPI 保存端点、路径白名单、Job lock/atomic IO 和现有测试已逐项核对。
- 固定参考仓库的 CanvasProject、节点、导出包、插件 state 与 WebDAV manifest 已核对。
- 落地前复查发现唯一 v1「测试项目」已有 4 节点、2 连接与 1 个上传文件；用户明确同意删除后，已将
  精确项目目录移入系统废纸篓，再开始 v2 直接切换。

## Comments

- 2026-08-23：用户要求继续开发，确认方案 A；ADR-0008 已接受。
- 2026-08-23：Foundation 纵切已完成 Python/TS v2 schema、revision/ETag/lock、immutable version、
  version-id media、上传原子登记和 Web 节点适配；生成 Run/transaction 尚待下一纵切。
- 用户既有约束禁止未经同意改写测试脚本；本轮不更新 v1 fixtures，API smoke 与生产构建另行记录。
- 不引入 converter、兼容 union、fallback、备份恢复命令或长期 v1 fixture。
- v2 实现必须在一个提交内同步删除 Python/TypeScript v1 类型、旧 API 字段与旧前端分支。
