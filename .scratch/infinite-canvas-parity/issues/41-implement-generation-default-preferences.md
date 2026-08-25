# 41：补齐渠道模型与生成默认偏好

Type: implement

Status: in-progress

Blocked by: 40-implement-generation-config-entrypoints

## Goal

关闭固定参考基线 F08：让画师在画布内设置文本 / 图片 / 视频 / 音频各自的默认模型与默认参数，
后续人工创建生成节点或切换配置类型时自动采用；渠道、凭证、模型目录和执行能力继续只来自现有 Keys
与统一 Job Runner，不复制参考项目的浏览器密钥仓库或直连执行器。

## Reference boundary

- 固定参考：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`。
- 学习其全局四模态默认模型、Canvas 图片候选数与音频默认参数的 preference 语义。
- 适配为服务端应用级 `.config/canvas-ui.json`；只存非敏感 alias / model / capability 参数，绝不存 API Key、Base URL 或媒体路径。
- 节点 composer 仍可覆盖默认值；已存在 Draft、不可变 Run Snapshot 与历史 Job 永不被偏好回写。

## Acceptance

1. `CanvasUiPreferences` 升级为严格 v2，新增四模态 `generation_defaults`；每项只允许该模态的安全参数，拒绝媒体引用、mask、本机路径、运行回写字段与其他模态字段。
2. GET 在文件不存在时返回 v2 默认值且零写；PUT 以 revision + 文件锁 + 原子替换保存工具栏和生成偏好，旧 revision 冲突零写，损坏文件不静默覆盖。
3. 画布工具栏提供“生成偏好”入口；独立 Dialog 展示四模态默认模型，并复用现有 capability 控件编辑真实支持的默认参数。
4. 模型选项只包含 Canvas Runner 可路由模型；可恢复“自动选择”。偏好指向已删除、改模态或不可路由模型时明确显示失效，创建时诚实回退首个可路由模型，不套用失效模型参数。
5. 空白新增、连接创建、文本一键生图、反推提示词恢复与配置节点模式切换均采用相应偏好；节点内手动切换模型只改当前 Draft，不修改全局偏好。
6. 保存/取消、并发冲突重载、窄屏滚动、键盘焦点和错误提示可用；供应商与模型目录仍在现有设置页管理。
7. 项目 `canvas.json`、undo/redo、项目包和 Run Snapshot 不包含 `generation_defaults`；偏好变更不增加项目 revision。
8. 后端、前端、设计守卫、源码 TypeScript、production build、真实浏览器和双轴代码审查通过。

## Non-goals

- 不复制 API Key、Base URL、渠道模型目录或浏览器直连逻辑。
- 不增加隐藏 system prompt，不修改已存在节点或历史 Snapshot，不实现跨设备同步。
- 不修复既有 Canvas v1 测试债或用户工作树文件。

## Rollback

回滚本票提交即可移除 v2 偏好与 Dialog；Canvas Document、Content Version、Job/Snapshot 和 Keys
保持不变。当前工作区没有已落盘的 v1 `canvas-ui.json`，无需兼容或迁移旧结构。

## Verification

待完成。
