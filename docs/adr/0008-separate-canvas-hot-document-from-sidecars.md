---
status: accepted
---

# 画布热文档只持有布局、引用与内容版本

Canvas v2 将布局、节点、连接和不可变 Content Version 保存在一个 revision 化 `canvas.json` 中，使一次
人工编辑能够在项目锁内原子提交；Generation Snapshot 归对应 Job，资产/提示词库、Agent 会话和插件
私有状态则使用分域 sidecar，避免把高频画布保存放大为整个项目历史重写。每个内容版本一个文件会让
普通编辑变成跨文件事务，把所有项目状态塞进单一 JSON 又会放大冲突与权限半径，因此不采用这两种
结构。
