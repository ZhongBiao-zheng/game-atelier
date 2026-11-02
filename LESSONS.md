# LESSONS

项目教训按规则记录；同类问题合并计数，在三个不同任务出现后提炼为项目规范。

条目格式：规则、原因、证据（日期与文件或提交）、出现次数。

## 全量 pytest 和清理前端构建必须顺序运行
- 原因：bootstrap 测试读取仓库 web/dist；make build 清空该目录时会让安装检查误报缺少产物。
- 证据：2026-11-02 ComfyUI A 批并行验证出现 11 个 bootstrap 失败，构建完成后顺序重跑全部通过。
- 出现：1

## 新增生成参数必须验证从界面保存到真实 caller 的完整链路
- 原因：创作台重新组装 JobParams，Canvas 另有 CANVAS_DRAFT_PARAM_FIELDS 白名单；单测 caller 无法发现中途丢参数。
- 证据：2026-11-02 ComfyUI A 批补齐 workflow_inputs 两处传递，并用 Studio / Canvas 的真实 Job 验证落盘值。
- 出现：1
