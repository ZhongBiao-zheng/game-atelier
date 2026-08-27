# 34：补齐已连接内容的 @ 引用与提交重编号

Type: implement

Status: completed

Blocked by: 33-implement-canvas-text-audio-settings

## Goal

补齐 D15/D16：生成面板输入 `@` 时只展示当前节点已连接且有可用版本的文本、图片、视频、音频，
以原子 chip 编辑稳定的 `@[node:<id>]` token；提交时重新解析当前连接、内容版本与实际输入顺序，
生成与媒体数组一致的类型内编号。

## Included

- 参考固定基线的 contentEditable chip、光标跟随菜单、缩略图、搜索与键盘选择。
- Draft 只保存稳定 node token；界面标签按当前 incoming Input Connection 重新计算。
- 断开的 token 保留为 missing chip、显示诊断并禁止提交，服务端继续作为最终安全边界拒绝。
- `mentions_only` 只选 prompt 实际引用；`all_connected` 保留协议兼容的隐式自身与所有已连接输入；
  已有视频派生编辑、speech 音频沿用项目既有的受限输入契约。
- 服务端按冻结后的真实输入顺序为文本、图片、视频、音频分别编号；重复引用复用同一编号。
- 桌面节点跟随面板与窄屏底部面板共用同一输入组件和行为。

## Excluded

- 引用未连接节点、跨画布资源、递归遍历上游图、自动执行下游节点。
- 在 Draft 中保存显示标签、媒体裸路径或冻结 Content Version。
- Agent 对话框的 @ 引用、Studio 既有 `@图1` 协议改造。

## Exit gate

- 输入 `@` 可通过鼠标或键盘插入四类已连接内容，图片显示缩略图 chip。
- 节点改名、连接增删与顺序变化不会改写稳定 token，显示标签会立即重算。
- missing 引用在 UI 和服务端均不能静默降级成普通文本。
- Snapshot inputs、final prompt 与 Job 三类媒体引用数组顺序一致，类型内编号可测试。
- 聚焦测试、设计守卫、生产构建、真实浏览器与代码审查完成。

## Verification

- Web 聚焦测试 54/54、Python 聚焦测试 16/16、相关 Ruff 与设计守卫通过。
- 全量 Python：8 failed / 968 passed / 3 skipped；全量 Web：22 failed / 451 passed / 13 errors。失败均为既有 Canvas v1/旧 Key 基线，本阶段没有新增失败。
- Vite production build 与 dist 归一化通过；`pnpm build` 仅被既有 Canvas v1 测试类型错误阻塞，本阶段源码无新增类型错误。
- 真实浏览器验证连接候选、光标菜单、键盘插入、稳定 chip、无残留 `@`、ARIA 语义及撤销还原；验证数据已恢复为空。
- Spec 与 Standards 双轴复审完成，P1/P2/P3 清零；D15、D16 parity gap 更新为 `none`。
