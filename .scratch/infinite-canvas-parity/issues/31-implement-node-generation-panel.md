# 31：补齐节点下方独立生成面板

Type: implement

Status: completed

Blocked by: 30-implement-node-run-status-retry

## Goal

补齐 D01/I05：将文本、图片、视频、音频、配置与声明内置生成能力的插件节点统一接入独立的
节点下方生成面板；面板跟随节点、可单独关闭并可由再次选择节点重新打开，不与节点卡片或检查器合并。

## Included

- 桌面端生成面板作为节点卡片外的独立 sibling surface，默认位于节点下方并随节点拖动、缩放。
- 面板在画布左右边缘按 16px 安全区水平钳位，React Flow zoom 下以屏幕像素校正偏移。
- 面板提供明确关闭入口；关闭不取消节点选择，再次点击/键盘选择同一节点重新打开。
- 提示词为主体，模型、密钥、真实能力参数与运行操作收在底部工具区；不出现不存在的 `1x`。
- 窄屏使用独立底部生成面板；生成面板打开时暂时隐藏节点检查器，关闭后恢复检查器。
- Composer 运行状态复用 E30 已校验的 result Job，不接受只命中 run id、但结果节点不一致的 Job。

## Excluded

- D10/D11/D13 的模型/图片/视频参数完备性、参数 popover 重构和厂商能力扩展。
- 新增引用协议、改变连接规则、Generation Snapshot 或 Job/Canvas schema。
- 右键菜单、批量选择工具条、Agent/插件面板能力扩展。

## Exit gate

- 所有带 Generation Draft 的节点共用同一独立面板结构；分组节点不显示伪 composer。
- 关闭、重新打开、左右边缘钳位、高倍 zoom 安全宽度、焦点恢复和窄屏独立面板均有聚焦测试。
- 节点主体、左右连接柄、上方 hover 工具条与运行状态无回归。
- 聚焦测试、设计守卫、生产构建、真实浏览器与代码审查通过；旧版 Canvas v1 类型/全量测试基线保持不变。

## Verification

- 41 项 E31/E30/节点工具条/设计守卫定向测试通过。
- `vite build` 与 dist normalize 通过；`tsc` 仅保留旧版 Canvas v1 测试的既有错误。
- 全量 Web：42 files / 418 tests 通过；4 files / 22 tests 与 13 errors 为旧版 Canvas v1 基线。
- 1280×720、50% zoom 实页验证：面板在节点下方且左右在安全区内，关闭后焦点回到节点，连接柄保留，再选同节点可重开，控制台零错误。
