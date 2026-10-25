# 本机 Canvas MCP

在设置的本机 Agent 连接中启用连接；凭据保存在本机受保护文件，客户端启动方式由插件注册。MCP 服务仅连接 127.0.0.1。

工具集合为 canvas_list_projects、canvas_get_document、canvas_list_models、canvas_apply_changes、canvas_import_media、canvas_run、canvas_get_run、canvas_read_media。能力为 canvas_read、canvas_edit、canvas_generate；读写都由本地服务校验，工具不提供任意文件或 HTTP 入口。画布运行仍需用户明确授权计费。

工坊工具和生成请求已退役，旧 workshop_* 名称不能调用。项目模型与数据迁移见 [ADR-0027](adr/0027-canvas-project-is-the-project.md)。
