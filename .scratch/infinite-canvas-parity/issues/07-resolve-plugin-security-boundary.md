# 07：裁定节点插件与远程代码安全边界

Type: wayfinder:grilling

Status: ready-for-agent

Blocked by: 01-freeze-reference-baseline, 02-resolve-canvas-domain-v2

## Question

参考项目允许远程节点插件与自定义调用脚本；在本地持有模型密钥和用户资产的 game-atelier 中，
插件能运行什么代码、访问什么数据与网络，如何安装、授权、升级、迁移、禁用和崩溃隔离？

## Decisions required

- 支持“远程 URL 直接执行”、签名包、审核仓库或仅本地开发插件中的哪一种。
- 渲染、inspector、serialize/migrate、toolbar、AI capability 的进程与权限边界。
- 插件节点失效时如何保留数据并保证项目仍可打开。
- SDK 兼容目标是参考 API 表面，还是本项目自己的等价插件契约。

## Deliverable

- 威胁模型、能力授权表、sandbox/iframe/worker/server 的技术比较和推荐 ADR。
- 插件 manifest、版本迁移、故障占位节点和测试策略。

## Proposal

- 威胁模型、安装包、sandbox、capability、迁移、Caller Adapter 与测试：
  `../canvas-plugin-security-proposal.md`
- proposed ADR：`../../../docs/adr/0012-sandbox-canvas-plugins-behind-capability-broker.md`
- 推荐方案 A：远程/官方/本地插件全部先落不可变 package，再在 opaque-origin iframe 中运行；
  viewer-server 作为唯一 capability broker，插件不能接触密钥、裸路径、宿主 DOM 或任意网络。

## Decision

2026-08-23 用户确认方案 A：保留第三方 URL 安装入口但不提供宿主页直接执行兼容模式；runtime 首版无任意
网络；插件跨节点写入走 Change Set、四模态生成逐次确认并进入 Job Runner；digest pin + 项目级原子迁移
保证数据生存；自定义模型首版只开放 declarative Caller Profile，不开放第三方可执行 Caller Adapter。
