# 界面与 SDK

插件界面是一个单文件 HTML，宿主核对摘要后用 `srcdoc` 放进只开脚本的 sandbox iframe。界面与宿主之间只通过一个消息通道通信，SDK 封装了这层协议。

协议类型：`plugins/sdk/protocol.ts`（`atelier-plugin/1`）；SDK：`plugins/sdk/index.ts`。插件源码用相对路径引入：

```ts
import { connect, PluginRpcError, type PluginClient } from '../../../sdk';
```

## 两种界面

| | 节点内容面 `node` | 编辑面板 `panel` |
|---|---|---|
| 位置 | 画布节点的内容区 | 双击节点后打开的宿主对话框 |
| 指针 | 不接收（拖动、框选、缩放都归画布） | 正常交互 |
| 键盘 | 无 | 焦点在面板里时宿主收不到按键；SDK 把 Esc 接到「关闭面板」 |
| 何时存在 | 节点在画布上渲染时 | 面板打开期间 |

同一个包用 `client.surface` 区分该渲染哪一种。

## 连接

```ts
const client = await connect();   // 10 秒内宿主没握手则拒绝
```

握手做的事：校验协议版本；只接受父窗口发来的握手（同页面的其他插件界面不能冒充宿主）；在通道上先回报宿主放在页面里的 nonce（宿主收到前不服务任何方法）；套用主题；开始按需加载字体。自己实现握手的插件必须做同样的事。

## 客户端 API

```ts
client.pluginId;           // 插件 id
client.surface;            // 'node' | 'panel'
client.theme;              // { mode: 'dark' | 'light', tokens: Record<string, string> }

await client.node.readSelf();              // { node_type, title, size, payload_schema_version, payload }
await client.node.writeSelf(payload);      // 写回节点数据，进撤销历史与自动保存

await client.inputs.list();                // [{ handle, kind, title, width, height }]
await client.inputs.readBitmap(handle);    // ImageBitmap（转移，不复制）
await client.inputs.readBytes(handle);     // ArrayBuffer
await client.inputs.readText(handle);      // 文本素材

await client.server.call(path, params, handles);  // 调本插件的服务端路由，见下
await client.ui.close();                   // 关闭编辑面板

const off = client.on('node.changed', () => {});  // 也有 'inputs.changed'、'theme.changed'
```

- `handle` 只在本次界面实例里有效，不是文件路径或版本 id。素材断开连接后句柄立即失效。
- `server.call` 的 `handles` 由宿主换成版本后转发，服务端再核对这些素材此刻确实连在这个节点上；界面拿不到文件路径。路径必须符合清单路由的格式（`/` 开头，小写字母、数字、`/`、`_`、`-`）。
- 失败时抛 `PluginRpcError`，`code` 见下表。`SERVER_ERROR` 的 `message` 是服务端给用户看的原因，可以直接显示。

## 能力

能力在清单 `capabilities` 里声明，在每个项目里由用户批准一次（见 [安全与隔离](security.md)）。

| 能力 | 解锁 |
|---|---|
| `node.read_self` | `node.readSelf` |
| `node.write_self` | `node.writeSelf` |
| `resource.read_inputs` | `inputs.list`、`inputs.read*`：读到连给本节点的素材完整内容 |
| `resource.create` | 服务端模块新建画布节点（`create_image`、`create_text`） |
| `storage.project` | 项目级插件状态（已定义，宿主尚未开放接口） |
| `server.call` | `server.call` |

清单声明了宿主不认识的能力，插件显示为「需要更高版本的 Atelier」。

## 限制与错误码

| 限制 | 值 |
|---|---|
| 调用频率 | 每个界面实例每秒 60 次，同时在途 8 个 |
| 普通参数 | 64 KiB |
| `writeSelf` 的数据、`server.call` 的参数 | 256 KiB（按 UTF-8 字节），深度 32，键与数组元素合计 10000 |
| 数据格式 | 纯 JSON；不接受函数、Map、日期、二进制、`NaN`、`undefined`、`__proto__` / `constructor` / `prototype` 键、含孤立代理字符的字符串 |
| 握手 | 页面加载后 5 秒内要回报 nonce，否则显示「插件没有响应」 |

| 错误码 | 含义 |
|---|---|
| `CAPABILITY_DENIED` | 本项目没有批准这项能力 |
| `UNKNOWN_METHOD` | 不支持的方法 |
| `BAD_REQUEST` | 参数形状或数据格式不对 |
| `PAYLOAD_TOO_LARGE` | 超过大小、深度或条目上限 |
| `INVALID_HANDLE` | 句柄不是本实例发出的，或素材已断开 |
| `RATE_LIMITED` | 调用过于频繁 |
| `UNAVAILABLE` | 节点已不存在 |
| `SERVER_ERROR` | 服务端路由拒绝了请求，`message` 可直接显示 |
| `INTERNAL` | 宿主处理失败（不透露细节） |

## 主题与字体

握手时宿主下发一组设计 token（颜色、字体族），SDK 写到界面页面的 `:root` 上，用 `var(--primary)`、`var(--border)` 等引用；切换主题时收到 `theme.changed` 并自动更新。界面里不要写死颜色。

沙箱里没有网络，字体由宿主按需传字节：SDK 统计页面里出现的字，向宿主要对应的字体分片注册。首次出现的汉字会先用系统字体显示再切换。

## 设计约束

插件界面受与宿主相同的设计守卫约束（`web/src/test/designDrift.test.ts`、`nativeControlsGuard.test.ts` 扫描 `plugins/*/ui/**/*.tsx`）：不写死颜色、不用阴影与渐变、字号四档。沙箱里用不了宿主的组件库，基础控件写在插件自己的 `ui/src/kit/` 目录里——这一层可以写原生控件，页面文件不行。
