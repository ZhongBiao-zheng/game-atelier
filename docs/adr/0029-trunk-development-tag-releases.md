---
status: accepted
---

# 主干开发与按 tag 发布

2026-10-26 用户确认：日常直接提交推送 main，客户端只更新到经过发布门禁的正式版本。此前 dev → main PR 同步、main 同时充当更新渠道的规则被替代。

## 决策

- main 是开发主干；dev 在首次过渡完成后冻结保留，不删除。既有未合并工作不自动并入。
- 日常开发不 bump 版本。发版提交统一修改 plugin.json 版本和 changelog 最新条目；推送 main 后，由用户明确授权运行 make release。
- make release 检查 main、干净工作区、正式版本、最新日志、本地与远端 tag 不存在，以及 HEAD 等于实时查询的 origin/main。任何失败均不推 tag。
- vX.Y.Z tag 推送后，发布流水线依赖 macOS/Linux/Windows 的完整测试；Windows 在发布调用中必须阻塞。测试通过才构建，构建通过才发布 GitHub Release，发布后才镜像 CNB。
- 源码更新优先查询 CNB 正式 tag，失败时使用 GitHub 已发布的正式 Release；只 fetch 指定 tag 并 fast-forward，不追踪任何分支。安装包只通过 HTTP 查询 GitHub Release，不自动替换文件。
- CNB 最新 Release API 匿名实测返回401，不能作为安装包查询源。CNB tag 推送发生于 GitHub Release 发布后，附件同步可能随后失败；因此 CNB 裸 tag 证明代码已通过上游门禁，不证明附件已同步完成。
- 更新发现总等待预算3秒，CNB优先阶段最多1.5秒；成功缓存24小时，失败缓存1小时。缓存按渠道和查询模式隔离，旧 main 版本缓存不复用。

## 原因与后果

把开发主干和用户升级版本分开，减少日常分支同步操作，同时保留明确的发布授权与完整测试门禁。未通过测试的 GitHub 裸 tag 不会被客户端当成可升级版本。发布失败须修复后重新准备版本，不能强制改写已有 tag。

## 首次过渡

本方案最后一次在 dev 开发；合 main 与首个 tag 分别由用户确认。首个发版版本必须高于已部署的旧版（至少覆盖5.127.x），使仍读 main plugin.json 的客户端取得新的更新器。过渡前 main 保持可用，合入后尽快完成获准的首次发布；CI 失败时不得宣称发布完成。

本规则同步到 CLAUDE.md（AGENTS.md 软链接）、issue-tracker 与 product-feature-workflow；CONTEXT 中的制作版本/同步术语仍属于产品领域，不改为 Git 发布术语。
