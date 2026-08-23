---
status: accepted
---

# React Flow 承担人工创作画布的机械层

无限画布采用人工创作关系,而不是 ComfyUI 式可执行依赖图。使用 MIT 许可的 `@xyflow/react` 负责视口、节点、连接、选择、拖拽和小地图等通用画布交互;现有 Job Runner 继续作为唯一底层生成执行器。画布作为位于“创作台”和“工坊”之间的独立顶级功能区,其项目只能由用户在 Web 中手动创建,拥有独立画布文档、上传资源和 `namespace="canvas"` 的 Job;Character/UI/Video Skill 不创建、不填充也不推进画布项目。React Flow 与当前 React 18 技术栈直接兼容,也避免引入 Rete.js 的第二套调度模型、ComfyUI Frontend 的 Vue/GPL 约束,或接管年轻项目手写的画布引擎。画布不支持 Skill 自动编排、整图执行、分支调度、循环和子图;真实需求出现后再单独评估工作流引擎。连接与历史生成输入的语义由 ADR-0007 取代。
