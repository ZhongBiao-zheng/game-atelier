# 打包与发布

## 入库的东西

```text
plugins/<id>/
├── manifest.json        # 源清单
├── ui/                  # 界面源码
├── server/              # 服务端模块（可选）
├── tests/
└── package/             # 构建产物，入库
    ├── manifest.lock.json
    └── ui/index.html
```

`package/` 与 `web/dist/` 一样入库，并受「干净构建后无差异」约束：`make verify` 与 CI 会重建一次，`package/` 有任何差异都失败。提交前先 `make build` 并把 `package/` 一起暂存。

## 发布

官方插件随主程序安装包一起发布，没有单独的插件版本发布流程：

- `scripts/build_release.py` 把整个 `plugins/` 拷进安装包的 `app/plugins/`。
- 安装包里的本机服务按 `app/plugins/*/package/manifest.lock.json` 扫描插件。
- 「安装」等于用户在设置里启用。依赖大文件的插件将来在启用时下载（下载器尚未实现）。

## 入库检查

`scripts/check_product_plugins.py`（接入 `make verify` 与 CI）：

- `manifest.json` 合法且 `id` 与目录名一致；
- `package/manifest.lock.json` 合法，内容与 `manifest.json` 一致（改了清单要重新构建）；
- 包摘要正确；`files` 列出的文件存在且字节数、SHA-256 一致；包里没有清单之外的文件；
- 界面入口以构建脚本生成的外壳开头；
- 声明了 `server` 就必须有 `server/__init__.py`，反之亦然；声明的路由都有实现，实现的路由都已声明；
- 服务端模块不导入 `character_workflow.lib.callers` 与 `job_runner`。

`scripts/check_plugin.py` 是另一回事：它检查 Claude Code Plugin 渠道（`.claude-plugin/`），与产品内插件无关。它的 25 MB 体积上限会把 `plugins/` 算进去，大文件一律走 `assets` 下载，不要放进仓库。
