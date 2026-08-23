---
status: accepted
---

# Canvas 四模态生成统一进入 Job Runner

Canvas 的文本、图片、视频和音频生成全部创建带不可变 Snapshot 与 candidate 集合的 Canvas Job，并由
现有 `job_runner.run_job()` 作为唯一执行入口；模型协议由服务端 capability/caller registry 解析，浏览器
不直连模型、不读取密钥，也不执行任意模型调用脚本。批量结果属于一个 Job，允许候选部分成功和协作
取消；自定义模型调用只能通过后续受控 server-side caller adapter 扩展，而不能成为第五条执行路径。
