# 19：实现视频派生编辑

Type: implement

Status: completed

Blocked by: 06-implement-generation-run-lifecycle, 15-implement-media-ownership-tools

## Goal

让任意已有视频节点通过工具栏“编辑视频”打开跟随节点的独立生成面板，输入镜头变化提示词并生成独立
派生视频；当前视频必须作为不可变 Snapshot 的唯一隐式 source input，而不是覆盖原视频。

## Included

- 已有视频节点的 hover toolbar 与 Inspector 增加“编辑视频”入口；上传视频也能初始化 Video Draft。
- 编辑态只展示明确支持参考视频的模型，并复用现有视频能力矩阵呈现生成方式、比例、清晰度、时长、
  档位与生成音频开关；切换模型时清除该协议不支持的旧参数。
- 继续复用通用 `POST /canvas/projects/{project_id}/runs`：服务端从当前视频节点解析唯一
  `implicit_self` Content Version，冻结 prompt、alias/provider/model 与视频参数，生成独立结果节点和
  generation-run Derivation Connection。
- original retry 逐字段复用原 Snapshot；current retry 使用当前结果视频和当前面板设置创建下一代派生。

## Adaptation decision

参考项目的“视频编辑”是 prompt 驱动的视频派生入口，不是时间线/NLE。当前项目复用既有 Job Runner、
Seedance 参考视频协议与节点下方 Composer，不新增第二套执行器或浏览器直连模型。

## Excluded

- 时间线剪切、拼接、转码、字幕轨、关键帧、局部视频蒙版与浏览器本地视频变形。
- 为只接受公网 URL 的厂商静默上传视频；未配置现有 OSS 中转时保留真实失败。
- 快捷工具顺序偏好（后续 E12）和修改旧 Canvas v1 测试。

## Exit gate

- 无当前视频版本、无支持参考视频的模型、模型/协议不兼容与 revision conflict 全部不创建 Run。
- Snapshot 只有当前视频一个 `implicit_self`，参数与模型信息冻结，结果节点不覆盖源节点且连接角色正确。
- 真实页面核对工具入口、节点下方独立面板、兼容模型过滤、视频参数、运行状态、结果播放与两种重试。
- Ruff、当前 Canvas TypeScript、设计守卫与生产构建通过；双轴审查 P1/P2 清零。

## Verification

- 真实页面从视频 hover toolbar 与 Inspector 均可打开节点下方独立 Composer；已有视频只展示参考视频
  兼容模型和 `omni` 生成方式，比例、清晰度、时长与生成音频均来自既有视频能力矩阵。
- Mock Seedance 完成真实提交：源视频保持不变，右侧创建独立视频结果节点与 generation-run 派生边；厂商
  请求携带唯一 `reference_video`、6 秒、720p、16:9 与音频开关，页面控制台零 warning/error。
- original retry 复用首轮 input/version/params；current retry 从当前结果节点与已保存的新 prompt 冻结下一代
  Snapshot。服务端额外验证即使源节点存在输入连接，已有视频编辑仍只保留一个 `implicit_self`；手写节点
  mention 会在创建 Run 前拒绝。
- `ruff`、Canvas TypeScript、设计守卫、29 个视频控件测试、51 个视频后端测试与生产构建通过；双轴复审
  P1/P2 清零。全量基线保持 Python `939 passed / 13 failed / 3 skipped`、Web
  `381 passed / 22 failed / 13 errors`，失败均为已删除 Canvas v1 契约与既有模型分类预期，没有新增失败。
