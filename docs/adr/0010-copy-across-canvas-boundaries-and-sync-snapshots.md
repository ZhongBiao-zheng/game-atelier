---
status: accepted
---

# 跨创作空间复制内容，并用不可变快照同步 Canvas Project

Canvas Project 是上传、Content Version、Library Entry、Local Prompt、Canvas Job、Agent session 与
plugin state 的所有权边界。同一项目内节点和资产条目可以引用同一不可变 Content Version；跨 Canvas、
Studio 或 Workshop 的传递必须由用户显式触发，并由服务端复制字节与冻结来源血缘。发布到 Workshop
同样创建目标项目拥有的新版本，源内容之后的修改或删除不得影响副本。

项目 ZIP 与 WebDAV 消费同一份规范文件集合和摘要清单。ZIP 导入总是分配新 Canvas Project ID；WebDAV
以不可变 snapshot、parent lineage、content-addressed blob 和条件更新的 latest pointer 同步。若本地与
远端从同一已同步快照分叉，远端版本导入为新的冲突副本，而不是按 updated_at 做字段级自动合并。

项目包、设置包和同步快照不得包含 API Key、WebDAV secret、全局 provider 配置、插件代码、缓存或运行中
事务。公共提示词源由服务端作为不可信 JSON 抓取并缓存；编辑或加入项目提示词库时创建本地快照，远端
刷新不改写已插入内容。
