---
status: accepted
---

# Canvas 节点插件只在 sandbox 中通过 capability broker 扩展画布

远程、本地和官方节点插件都先安装为带 digest 的不可变包，再在无同源、无任意网络的 sandbox iframe 中
运行；宿主 React 页面不 import 插件代码。插件安装与项目启用分离，权限绑定 project、plugin 与 digest，
节点和项目 state 由宿主 envelope 保存；跨节点写入通过 typed Change Set，四模态生成逐次确认后只走
Job Runner。服务端可执行 Caller Adapter 不属于节点插件：第一版只开放 declarative Caller Profile 与随
应用发布、签名且经审核的内建 adapter，第三方可执行 adapter 暂不开放。
