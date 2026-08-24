# 16：实现图片反推提示词

Type: implement

Status: completed

Blocked by: 13-implement-read-only-media-tools, 15-implement-media-ownership-tools

## Goal

让已有图片节点通过受控的多模态文本 Run 生成可复用提示词，并在成功后幂等创建一个图片生成配置节点；
整个过程不读取或覆盖源图片节点的 Generation Draft，也不允许浏览器指定 preset、密钥或模型。

## Included

- `POST /canvas/projects/{project_id}/runs/reverse-prompt`：只接收 source node 与 revision，服务端固定
  `canvas.reverse_prompt.v1`，从本机 Key 配置中优先全局默认、再按登记顺序选择支持图片输入的文本模型。
- 文本 caller 接受服务端解析的项目内图片 Version，并使用 OpenAI-compatible 多模态 content 发送；
  Snapshot 冻结 preset 正文/版本、真实模型与唯一源图片 Version。
- 成功创建文本结果节点及 generation-run Derivation Connection；停止与 original retry 复用现有 Run 生命周期。
- `POST .../runs/{run_id}/reverse-prompt-config`：成功后幂等创建图片 Config Node 与文本→配置 Input
  Connection；优先全局默认、再按登记顺序选择图片模型。缺图片默认时保留文本结果。
- 图片节点 hover/Inspector 提供“反推提示词”；结果节点展示分析状态、原设置重试和配置恢复入口。

## Adaptation decision

当前项目只有一个全局 `default_alias`，没有按用途拆分的 default selector。本阶段不新增第二套密钥设置：
服务端以全局默认 Key 为首选，再按现有 Key 顺序选择首个兼容模型；模型的 `input_modalities` 是明确能力声明，
模型列表可从上游 `architecture.input_modalities` 带回，手动配置的文本模型可勾选“支持图片输入”。

## Excluded

- 蒙版局部编辑、多角度生成、视频编辑与快捷工具顺序偏好（后续 E06/E10/E14/E12）。
- 浏览器传入任意 system prompt、preset、alias/model 或媒体路径。
- 修改旧 Canvas v1 测试或当前工作区其他任务的测试文件。

## Exit gate

- 隔离数据验证受控模型解析、Snapshot、唯一图片输入、不可变结果、original retry、config 幂等、缺模型
  零写和 revision 冲突零写。
- 真实页面验证 hover/Inspector 入口、运行/失败反馈、文本结果、配置节点与连接恢复路径。
- Ruff、设计守卫、生产构建通过；源码不新增 TypeScript 错误，代码审查 P1/P2 清零。

## Verification

- 隔离 domain smoke：固定 preset/唯一图片 Snapshot、source draft 不变、文本结果、配置幂等、original
  retry、缺多模态文本模型零写全部通过。
- 隔离 ASGI smoke：模型缺失 422、创建 201、revision conflict 409、配置创建与 stale idempotent
  200 全部符合契约。
- 真实页面：图片节点入口、运行态、独立文本节点、自动图片配置、derivation/input 两类连接均通过；
  控制台无 error。
- Ruff、Python compile、设计守卫 8/8、Vite production build、source TypeScript diff 均通过；双轴审查
  未发现 P1/P2。
- 全量基线仍有旧 Canvas v1/旧模型过滤契约测试失败；按本 issue Excluded 未修改测试文件。
