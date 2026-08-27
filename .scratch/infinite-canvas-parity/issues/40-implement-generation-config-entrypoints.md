# 40：补齐生成配置节点与内容驱动入口

Type: implement

Status: completed

Blocked by: 37-implement-content-node-surfaces

## Goal

关闭固定参考基线 C05、D05、D06、D08 的真实交互缺口：让画布可以直接创建独立的生成配置节点，
在配置节点内切换文本 / 图片 / 视频 / 音频，并从已有文本内容一键建立可追溯的图片生成配置。
继续复用现有 Canvas Domain v2、不可变 Content Version、Snapshot 与统一 Job Runner，不引入浏览器图执行器。

## Reference boundary

- 固定参考：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`。
- 学习其“文本节点创建并连接生图配置”“配置节点切换四种生成类型”“空内容节点首个结果原位填充、
  已有内容或配置节点生成下游结果”的交互模型。
- 不复制其 Zustand、API 调用、模型协议、计费或样式实现；生成仍由项目现有 keys/capability 与 Job Runner 执行。

## Acceptance

1. 空白画布新增菜单可创建“生成配置”节点；从有内容节点的 source handle 拖到空白也可创建并自动建立 input 连接，target handle 菜单不得提供配置节点。
2. 新配置节点默认图片模式，使用首个真实可用模型；无兼容模型时诚实保留空模型状态，不伪造能力。
3. 配置节点表面提供可访问的文本 / 图片 / 视频 / 音频四态切换，显示当前模型与直接输入的模态数量；切换是一个可撤销 Document 命令。
4. 切换模式重新选择兼容模型并按现有 capability 归一化参数，保留提示词、稳定 `@` 引用和 `mentions_only` 输入策略，不修改既有 Run Snapshot。
5. 有非空正文的文本节点工具条提供“生成图片”；点击后在右侧创建图片配置节点、建立 text → config input 连接、写入稳定 `@[node:<id>]` 引用并选中打开节点下方独立 composer。
6. 空文本不得创建无效配置；快捷入口只建配置和连接，不自动提交、不产生费用。
7. 配置节点提交继续走现有 `submitCanvasRun`：图片 / 视频等结果由服务端按 Domain v2 决定原位填充或创建下游节点与 derivation 连接。
8. 节点创建、模式切换、连接策略、文本快捷入口与视频提交链路有聚焦测试；TypeScript、设计守卫、production build 和代码审查通过。

## Non-goals

- 不实现自动执行整张图、拓扑调度、浏览器厂商调用或参考项目计费。
- 不改变 Content Node 自身的同模态生成规则，不新增第二套模型配置源。
- 不顺手修复既有 Canvas v1 测试债或用户工作树文件。

## Rollback

回滚本票提交即可移除配置节点入口、四态切换与文本快捷动作；Schema v2、已有配置节点数据、
Snapshot、Job 和内容版本保持可读。

## Verification

- `pnpm exec vitest run src/pages/canvasGenerationConfig.test.ts src/components/canvas/CanvasGenerationPanel.test.tsx src/pages/canvasConnectionPolicy.test.ts src/components/canvas/CanvasNodeRunStatus.test.tsx src/test/designDrift.test.ts src/components/canvas/CanvasNodeToolbar.test.tsx`：59 passed。
- `pnpm exec tsc -p /tmp/tsconfig.canvas-e37.json --noEmit`：通过（Canvas 源码范围）。
- `pnpm exec vite build`：通过；仅保留既有 bundle size 警告。
- `uv run pytest -q tests/test_canvas_mentions.py`：7 passed。
- `uv run ruff check tests/test_canvas_mentions.py`：通过。
- 浏览器核对：已验证独立配置节点、四态切换、文本快捷创建、text → config 连接、稳定引用与节点下方独立 composer；未触发真实生成，并删除全部核对临时节点。
- 全量基线：Python 996 passed / 8 failed / 3 skipped；Web 474 passed / 22 failed / 13 errors，失败仍是既有 Canvas v1 与测试类型债，本票聚焦测试及新增用例无回归。
- 双重复核：规范审查提出 3 项、规格审查提出 2 项，均已修复；模型入口现与 Runner 协议路由一致，无兼容模型时保持空参数，黄铜仅作细选中指示。
