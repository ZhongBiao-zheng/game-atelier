# 04：人工节点、画布 Job 与来源闭环

Type: feature

Status: ready-for-human

Blocked by: 03

## Scope

- 实现参考图式新增节点抽屉：文本、图片、视频、音频和上传。
- 实现 TextNode、ResourceNode、GenerationNode 与只读来源连接。
- 用户在 GenerationNode 中明确编辑参数并点击生成。
- 接入 `namespace="canvas"` Job、现有 caller/SSE 和节点内结果候选。

## Acceptance

- 项目、节点、参考绑定和生成都只由用户操作产生。
- 移动/连接节点不运行；没有 Skill 回合或整图执行入口。
- 图片/视频生成状态在原节点更新，旧 Job/候选不被覆盖。
- 删除节点不误删上传文件或 Job 产物。

## Comments

- 2026-08-23：等待纠正版整体方案批准。
- 2026-08-23：纠正版方案已确认，可按 Scope 实施。
- 2026-08-24：图片/视频 Run lifecycle 纵切已接通：候选部分成功、诚实停止请求、原 Snapshot/当前
  Draft 两种重试、候选替代关系与重启恢复均进入服务端真源；文本/音频 caller 仍待后续纵切。
