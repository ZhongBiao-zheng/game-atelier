---
status: accepted
---

# Canvas Agent 只通过受限 Change Set 操作项目

Canvas Agent 是用户显式发起的项目内协作助手，不是 Character/UI/Video Workflow Skill。它可以读取当前
Canvas Project 并提出 typed Canvas Change Set，但不能直接写浏览器状态、项目文件、Job、Snapshot 或
Derivation；viewer-server 以 project scope、expected revision、capability 与 approval 作为唯一执行点。
结构和内容修改可以在当前 Session 获得有限类别授权，生成、删除、跨空间复制、发布及网络副作用始终
逐次确认，项目生命周期不向 Agent 暴露。

Agent 面板通过按需启动的受限 sidecar 复用本机 Codex 登录、模型和流式协议。sidecar 使用空临时工作目录，
没有 data root、源码工作区写入、shell、任意网络工具或 danger-full-access，只能调用 viewer-server 暴露的
Canvas read/propose/status MCP 工具。Canvas Agent Skill 只是用户为下一次 Turn 选择的指令模板，不能
后台运行、管理 Workflow Skill 或扩大工具与审批权限。
