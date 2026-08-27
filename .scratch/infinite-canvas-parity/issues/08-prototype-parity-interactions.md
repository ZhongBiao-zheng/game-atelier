# 08：用 React Flow 验证完整节点交互与样式

Type: wayfinder:prototype

Status: ready-for-human

Blocked by: 01-freeze-reference-baseline, 02-resolve-canvas-domain-v2

## Question

在不复制参考画布引擎和 Ant Design 的情况下，React Flow 能否稳定复刻其节点 chrome、空节点、
resize、左右连接柄、拖线到空白创建、多选/框选、分组、悬浮工具栏、下方独立 composer、侧栏、
缩略图和背景切换，并保持 Atelier 的视觉一致性？

## Prototype scope

- 只用 fixture，不接真实生成和持久化。
- 覆盖文本、空图片、已有图片、视频、音频、配置、分组和一个插件占位节点。
- 1440px 做逐项并排对照，768/375 验证可用降级。
- 150 个媒体节点验证拖拽、框选、缩放和打开 composer 的性能。

## Exit gate

人工验收节点密度、布局关系、composer 跟随、连接创建、工具栏和窄屏行为后，才固化组件 API。

## Prototype delivery

- A/B/C 临时路由、fixture 与切换器在 B 定稿并完成生产重写后已删除，不进入运行包。
- 本票保留浏览器验收数字与最终决策，作为原型结论的唯一长期记录。

## Browser evidence — 2026-08-23

- 1440 × 900: A/B/C visually inspected; no runtime warning or error after fixing the
  selection callback loop.
- 768 × 900 and 375 × 812: A/B/C remain operable; secondary rails collapse and a mobile
  action bar preserves add/group/ungroup/background/stress controls.
- Box-select 2 nodes → group: `nodes 10 → 11`, `selected 2 → 1`.
- Ungroup: `nodes 11 → 10`, selection restored to the former members.
- Drag an output handle to blank canvas → choose image: `nodes 10 → 11`, `edges 5 → 6`.
- Independent lower composer count: `1`; exact `1x` label count: `0`.
- Stress mode: 150 fixtures added, 160 React Flow nodes rendered with no console warning/error.

## Current recommendation

Recommend B (悬浮工具坞) for the human gate: it is closest to the reference project's
full-screen canvas, floating creation dock and unobstructed spatial editing model. This is
not yet a production decision; A/B/C remain available until the user records a verdict.

## Decision

2026-08-23：用户在 B 推荐与生产化交接后要求“继续开发”，确认采用 B（悬浮工具坞）。
生产实现保留全屏画布、左侧悬浮创建工具坞、节点下方独立 composer、紧凑项目切换与保存状态；
不采用 A 的常驻 Agent 右栏，也不采用 C 的常驻底部素材带。A/B/C 原型已在生产重写完成后删除。
