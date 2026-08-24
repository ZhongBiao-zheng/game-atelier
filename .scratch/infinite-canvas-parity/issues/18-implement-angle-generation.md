# 18：实现图片多角度生成

Type: implement

Status: completed

Blocked by: 06-implement-generation-run-lifecycle, 15-implement-media-ownership-tools

## Goal

让任意已有图片节点通过相机方位角、俯仰、距离与镜头类型生成同一主体的新视角；浏览器预览只用于表达
参数，真实结果必须由受控 Image Run 生成，源图片版本与全部角度参数冻结进不可变 Snapshot。

## Included

- 图片节点“多角度”入口与独立 Dialog：水平角 -60°–60°、俯仰 -45°–45°、距离 1–10、标准/广角、
  重置与轻量透视预览。
- `POST /canvas/projects/{project_id}/runs/angle` JSON 入口只接收 source node、revision、候选数和四个结构化
  相机参数；模型由服务端按默认优先级选择首个支持图片参考的 Image Model。
- 服务端使用版本化受控 prompt，把源图片作为唯一 Snapshot input；角度参数与 preset 版本进入
  `normalized_params`，浏览器不能提交裸媒体路径、provider、model 或自由 prompt。
- 结果为独立图片节点，只有一条 generation-run Derivation Connection；停止、候选切换、单候选补跑与
  original retry 沿用普通 Run 生命周期。

## Adaptation decision

参考实现的 `previewTransform` 只做 Dialog 内低成本视觉提示，不作为输出。当前项目不执行本地图片透视变换；
真实生成交给现有图片 caller，并由 Job Snapshot 保留可审计、可重试的机位参数和源版本。

## Excluded

- 浏览器本地变形结果落盘、3D 相机轨迹、批量角度预设与 AI 超分。
- 视频编辑与快捷工具顺序偏好（后续 E14/E12）。
- 修改旧 Canvas v1 测试或当前工作区其他任务的测试文件。

## Exit gate

- 参数越界、缺源版本、缺支持参考图的模型、revision conflict 与跨项目输入全部零写。
- Snapshot 只有唯一 source input，并冻结四个参数、preset 版本与真实 alias/provider/model；original retry
  逐字段复用原 Snapshot。
- 真实页面核对入口、Dialog、四类控件、重置、预览、运行反馈、结果节点与连接。
- Ruff、设计守卫、生产构建通过；源码不新增 TypeScript 错误，代码审查 P1/P2 清零。

## Verification

- Domain/API smoke：越界参数返回 422 且 document revision/nodes 不变；Snapshot 只有一个 source input，
  冻结四个机位参数与 `canvas.angle_edit@1`，original retry 复用原 Snapshot 和同一条 derivation 关系。
- Placement smoke：同一源节点连续生成的结果按纵向空位落点，不重叠，并各自保留独立 generation-run
  connection。
- 真实页面：核对图片节点入口、独立 Dialog、标准/广角与候选数、生成完成反馈、紧凑结果标题、候选区、
  “原设置重试”与“当前设置再生成”；浏览器 console 无 warning/error。
- Mock caller 确认请求进入 `/v1/images/edits`，而不是把浏览器透视预览当作结果。
- 门禁：Ruff、当前 Canvas TypeScript、设计漂移 8/8、Vite production build 与 diff check 全部通过；
  完整基线保持 Python 939 passed / 13 failed / 3 skipped，Web 381 passed / 22 failed（均为既有旧契约失败）。
- 本地交互/数据契约双轴审查完成，P1/P2 为 0。
