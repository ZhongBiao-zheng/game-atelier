# 出图产物如何在代理 GUI 里呈现给画师

> 权威说明（2026-08-16 实测补全，2026-08-16 改为三渲染通道结构）。三个出图 skill
> （character / promo / turnaround）的「终端渲染」步骤、以及任何需要把本地图片拿给画师看的
> 场景，一律按本文档执行。
> 契约源：`docs/api-contract.md` 的 `/api/raw` 段；`src/viewer_server/routes.py::get_raw_image` 是唯一实现。

## 一、先分清两件事：agent 看图 vs 画师看图

| 动作 | 用什么 | 目的 | 限制 |
|---|---|---|---|
| **agent 自己看图**（质检 / 沉淀经验前确认） | `read_image` 工具 | 把图读进模型上下文，agent 亲眼核对 | **需要模型声明支持图片输入**；不支持的模型（如 deepseek-v4-flash）调用即报错，这是正常的，不代表出图失败 |
| **把图呈现给画师**（出图完成后） | Markdown 图片语法 + 可加载的图片地址 | 让画师在代理 GUI 里直接看到成品 | 取决于渲染通道（见下），与模型是否支持图片输入**无关** |

`read_image` 报错 ≠ 图没出。出图是否成功只看 job 状态（`done`）与 `output_paths`。呈现画师永远用
Markdown 图片，**不要**因为 `read_image` 失败就放弃呈现或宣称失败。

## 二、三种渲染通道（按"渲染端能力"分，不是按产品名）

出图产物是本地文件（`output_paths` 里的绝对路径，如
`/Users/me/game-atelier/characters/foo/portrait/v2.png`）。Markdown `![alt](src)` 是各代理 GUI
通用的图片载体，但 **`src` 给什么才显示，取决于渲染通道**。别按产品名归类——Claude Desktop /
Codex 桌面版 / DeepSeek Harness 大多用 Electron / WebView（Chromium 内核），内部就是 HTML 渲染，
所以"应用"和"浏览器"经常是同一个通道；真正的分界是下面这三条能力。

### 通道 1：终端内联图像（真终端渲染 Markdown）

- 载体：iTerm2 / kitty / WezTerm / Windows Terminal 等支持内联图像的终端；Claude Code CLI、
  Codex CLI 直接跑在终端里时走这里。
- 写法：**本地绝对路径** `![vN](<output_paths 绝对路径>)`，终端渲染器直接读本地文件。
- 这是三个 SKILL.md 里「终端渲染」原本的写法，**只对终端内联图像成立**。

### 通道 2：HTML 渲染，能访问本地文件

- 载体：页面以 `file://` 协议加载的应用 / 本地页面，或应用把 Markdown 里的本地路径自行转成
  blob:/data: 注入渲染（部分桌面应用行为）。
- 写法：本地绝对路径或 `file:///` 前缀都可行。
- 注意：**能否访问本地文件取决于应用实现，无法从文档端保证**——不确定就实测（见第四节）。

### 通道 3：HTML 渲染，不能访问本地文件

- 载体：页面以 `http://` 协议加载——如 DeepSeek Harness 的 GUI（`http://127.0.0.1:<port>/`）、
  远程网页、绝大多数 Web 面板。**本地绝对路径 / `file://` 会被浏览器安全策略拦截，显示裂图。**
- 必须给"可加载的地址"，两种：
  1. **有后端（本项目 = viewer-server）→ HTTP URL**，首选：
     ```
     http://127.0.0.1:<port>/api/raw?path=<data-root相对路径>&job_id=<job_id>
     ```
     - 端口读 `<data_root>/.runtime/server.port`（默认 5174，被占用 +1，**别写死 5174**）。
     - 相对路径：`output_paths[i]` 是绝对路径，转成相对 data root（`characters/<id>/<slot>/vN.png`）。
     - **必须带本次 job 的 `job_id`**：`/api/raw` 用它做白名单鉴权（只认该 job 的
       `output_paths` / `reference_images` / `source_image`），不带或对不上 → 403。
     - 呈现前先确认 server 在跑：`curl -sS -o /dev/null -w "%{http_code}" "<上述URL>"` 为 200 再 render；
       未启动 → 按 viewer-server skill 启动，或直接走下面的 data URI。
  2. **没有后端（别人的项目 / server 不可用）→ base64 data URI，零依赖通用方案**：
     ```
     ![vN](data:image/png;base64,<base64编码>)
     ```
     任何 HTML 渲染引擎都能显示，不需要后端、不需要本地路径、不需要文件服务。
     **代价**：消息体积 +33%（1024x1536 PNG 常达数百 KB 到数 MB）；大图先压小（缩到 ~512px）再编码。
     这是"项目没后端"时的标准答案，不是可有可无的兜底。

## 三、判断当前是哪个通道

1. **看渲染端**：当前画师 GUI 是终端（TTY）还是应用/网页？终端 → 通道 1；应用/网页 → 通道 2 或 3。
2. **HTML 通道下测本地可达性**：试一次本地路径渲染，问画师一句「图能看到吗」。能看到 → 通道 2；
   裂图 → 通道 3。
3. **通道 3 下**：有 viewer-server 在跑 → `/api/raw` HTTP URL；没有 / 不想依赖 → data URI。
4. **不确定时**：data URI 最通用（任何 HTML 渲染都显示），一次成功；但消息会膨胀，所以有后端时
   优先 `/api/raw`。一次实测即可，别反复横跳。

## 四、降级顺序（呈现失败时）

1. `/api/raw` HTTP URL（通道 3 有后端时首选）→ 画师说看不到 →
2. 本地绝对路径 `![vN](<abs>)`（通道 1 / 通道 2）→ 画师说看不到 →
3. base64 data URI（零依赖，任何 HTML 渲染都显示，最后兜底；大图先压小）→ 仍不行 →
4. 告诉画师产物文件路径，让其在 Web（`http://127.0.0.1:<port>/` 角色页 / 项目页）查看。

**绝不**：`read_image` 失败就跳过呈现；拿上轮 `v_latest` 或按 mtime 挑文件冒充本次产物。

## 五、各 SKILL.md 的引用写法

出图完成后的渲染步骤统一为：

```
渲染路径取本次 run-job 返回的 output_paths（为空 = 未成图，走失败分支）。
图片呈现规则见 docs/references/image-presentation.md：终端内联图像 → 本地绝对路径；
HTML 渲染 → 能访问本地文件用本地路径，不能（http:// 页面）用 /api/raw HTTP URL + job_id，
无后端时用 base64 data URI。判断方法见文档第三节。
```

渲染后仍按各 skill 的「收尾验证」逐条核对锚点漂移 / 崩坏。
