---
status: accepted
---

# 弃用托管网站，只保留本机页面

2026-10-14 用户确认：托管网站方案（Vercel 上的静态界面连回用户电脑的 `127.0.0.1`）弃用。
删除网站配对、网站会话、按登记来源的 CORS、会话级媒体令牌、托管构建开关 `VITE_HOSTED_SITE`、
`vercel.json` 与设置页「网站连接」；GitHub 仓库的网站链接一并去掉。访问 Atelier 只剩本机页面
（`http://127.0.0.1:5174`）与本机 Agent（ADR-0022）两条路。

理由：定位是内部工作台（2026-09 六问结论），外部用户路径已判死；托管网站带来的是一整层跨源安全面
（配对码、CORS、媒体令牌、本地网络权限弹窗），而同事在本机打开页面就能用全部功能。
它还造成过真实问题：跨源时浏览器忽略 `<a download>`，下载按钮失效（5.89.2 为此加的附件头随本次一并撤回）。

后果：
- 连接协议仍为 `atelier-local/2`，只是不再有 `site` 会话；`/api/connection/{pairings,pair,media-token,sessions}`
  四个端点删除，带 Origin 的 bearer 一律拒绝。
- 前端连接层只有同源一种传输，`mediaUrl()` 这层包装删除，媒体地址直接写相对路径。
- 已部署的 Vercel 项目需要用户自己在 Vercel 后台下线；代码里不再有任何托管入口。
- [开发说明](../local-workspace.md) 与 `docs/plans/2026-09-10 网站配对与 Vercel 上线.md` 作为历史记录保留。
