# 本地开发与调试

## 准备

```bash
make install
```

插件界面借用 `web/` 的依赖（React 等）与工具链，不需要单独安装。

## 改界面

插件界面没有热更新。改完 `plugins/<id>/ui/src` 后：

```bash
cd web && node scripts/build-plugins.mjs
```

然后刷新 Atelier 页面（宿主按包摘要缓存界面，摘要变了会重新取）。宿主前端用 `pnpm dev` 跑在 5173 端口时，插件包仍由本机服务从 `plugins/<id>/package/` 提供。

构建脚本把 `ui/src/main.tsx` 打成一个 HTML（脚本与样式内联），资源不能有外部文件：图片、字体要么内联，要么在运行时从宿主取。

## 改服务端模块

服务端模块在第一次调用时加载并缓存。改了 `plugins/<id>/server/` 后，在设置里停用再启用该插件（会卸载模块），或重启本机服务。

## 调试界面

- 在 Chrome 开发者工具的上下文选择器里选插件的 iframe（标题是节点名），即可在控制台里操作沙箱页面。
- 沙箱页面是 opaque origin：`localStorage`、`fetch`、`document.cookie` 都不可用，这是预期行为。
- 所有方法调用都在消息通道上；调用失败看 `PluginRpcError.code`。
- 节点内容面不接收指针事件，交互逻辑放在编辑面板里调试（双击节点打开）。

## 测试

| 测试 | 位置 | 运行 |
|---|---|---|
| 服务端逻辑 | `plugins/<id>/tests/*.py` | `uv run pytest plugins` |
| 界面纯逻辑 | `plugins/<id>/ui/**/*.test.ts` | `cd web && npx vitest run ../plugins` |
| 端到端（真实路由与校验） | `tests/test_plugin_server.py` 的写法 | `uv run pytest tests/test_plugin_server.py` |

`make test` 与 `make verify` 都会收集 `plugins/` 下的测试。

## 检查

```bash
uv run python scripts/check_product_plugins.py   # 包与清单一致、摘要正确、路由都有实现、不直接调厂商
cd web && pnpm lint                               # 类型检查与 react-hooks 规则，含 plugins/
uv run ruff check src scripts tests plugins
```

设计守卫（颜色、字号、阴影、原生控件）在 `cd web && pnpm test` 里，覆盖 `plugins/*/ui/**/*.tsx`。
