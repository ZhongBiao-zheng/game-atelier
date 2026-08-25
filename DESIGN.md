# Design System — game-atelier

> 永远先读这份文档再做任何视觉 / UI 决定。
> 字体、颜色、间距、深度、组件配方都在这里定义。
> 本文档由 `web/src/test/designDrift.test.ts` 守卫强制执行：硬编码色值、任意值字号、阴影、杂牌圆角/模糊会直接红灯。

---

## Product Context

- **What this is**: 游戏角色资产工作流 —— 画师 / 设计师可视化管理角色档案与 AI 出图的本地工具
- **Who it's for**: 主理人（开发者本人）+ 1-2 位合作画师
- **Space/industry**: 创意 / 游戏美术 / AI 辅助设计
- **Project type**: 本地桌面级 web 工具（不是 SaaS dashboard）

## Aesthetic Direction — "Atelier"（工坊 / 画廊）

- **Direction**: Editorial / Gallery — 暖黑画廊为主，serif 点缀
- **Decoration level**: Minimal —— 排版 + 暖调做活，不堆装饰
- **Mood**: 安静、温暖、有匠气；让 AI 生成的角色艺术做主角

**画廊墙三定律**（一切视觉决定的根）：

1. **Chrome 无彩色** —— 导航、面板、按钮、表单全部灰阶（暖中性）；AI 作品是页面上唯一的颜色。
2. **深度靠玻璃，不靠阴影** —— 层级用毛玻璃 + 发丝边表达；阴影一律禁用。
3. **作品有呼吸的空间** —— 画布纯平（无渐变、无纹理），留白宽裕，框架隐形。

## Typography

- **Display / Hero**: **Instrument Serif** — 仅用于「唯一大跳跃」：页面 hero、角色名、空状态主文案。配 `text-display`（36px / 400）。serif 是签名，克制才贵。
- **Body / UI**: **Geist** — 所有按钮、标签、表单、正文、区块标题
- **Data / Tables**: **Geist** with `tabular-nums`
- **Code / Technical**: **JetBrains Mono** — job_id、文件路径、seed、URL
- **Loading**: Google Fonts CDN（tokens.css 顶部 @import）

**Scale（四档，守卫强制）**：

| Token | Size | Usage |
|---|---|---|
| `text-xs` | 12px | 元数据、tag、状态标签、小帽标签（**12px 是下限，禁任意值字号**） |
| `text-sm` | 14px | 主 UI 文本（按钮、标签、正文默认） |
| `text-base` | 16px | 区块标题（配 `font-medium`）、强调正文 |
| `text-display` | 36px/44px | 唯一大跳跃：hero / 角色名 / 空状态（配 `font-display`，weight 400） |

- ❌ **禁用** `text-lg` / `text-xl` / `text-2xl` / `text-3xl` / `text-4xl` 与一切 `text-[Npx]` 任意值。
- 层级不够用？用字重（400/500/600）和颜色（foreground / muted-foreground），不是字号。
- **小帽标签**：`text-xs uppercase tracking-label text-muted-foreground/70`（`tracking-label` = 0.18em，唯一字距 token）。

**Font-weight 策略**：

- Geist：400（正文）/ 500（按钮、强调、区块标题）/ 600（少量小标题）
- Instrument Serif：400 only（衬线粗体会失去优雅）
- JetBrains Mono：400 / 500

## Color — Warm Atelier Palette

**方法**：restrained — 单一强调色（aged brass / 黄铜）+ 暖中性灰阶。

**表面阶梯**（暖中性，R≥G≥B；面在上，色更亮）：

| Token | Hex | Usage |
|---|---|---|
| `--background` | `#0F0E0D` | 画布 / 画廊墙 |
| `--card` | `#1B1917` | 卡片、面板、左栏 |
| `--popover` | `#221F1C` | 弹出层（比 card 抬半级） |
| `--secondary` / `--accent` | `#2A2725` | hover 背景、次要按钮 |

**玻璃与遮罩**：

| Token | Value | Usage |
|---|---|---|
| `--glass` | `rgba(27,25,23,0.66)` | 浮层玻璃底色（配 `backdrop-blur-glass`） |
| `--scrim` | `rgba(8,7,6,0.62)` | lightbox / 全屏 loading 的背景遮罩 |

**发丝边界**（暖白 alpha，不再用不透明灰）：

| Token | Value | Usage |
|---|---|---|
| `--border` | `rgba(237,234,227,0.10)` | 默认边界（卡片、分隔线、浮层描边） |
| `--input` | `rgba(237,234,227,0.16)` | 输入框边界（略亮，提示可交互） |

**文字与强调**：

| Token | Hex | Usage |
|---|---|---|
| `--foreground` | `#EDEAE3` | 主文本（暖白） |
| `--muted-foreground` | `#94908B` | 元数据、placeholder、辅助文字 |
| `--primary` | `#D4A574` | 黄铜（见使用三限） |
| `--primary-foreground` | `#1B1917` | 黄铜按钮上的文字 |
| `--destructive` | `#C95C5C` | 删除、错误（暖红） |
| `--ring` | `#D4A574` | 聚焦环（黄铜） |

**黄铜使用三限**（单强调色纪律）：

1. **每屏一处主操作**（primary 按钮 / 确认出图）
2. **聚焦环**（`ring-2 ring-primary` —— 最独特的视觉签名）
3. **激活指示**（当前 tab 下划线、选中态小点）

链接、导航激活、普通强调一律用 `text-foreground` + `font-medium`，不用黄铜。黄铜出现越少越值钱。

**Status colors**（任务状态语义色，暖调对齐；12px meta 同字号靠颜色分语义）：

| Token | Hex | Usage |
|---|---|---|
| `--status-pending` | `#6B6967` | 等待中 |
| `--status-running` | `#E5B570` | 进行中（暖琥珀，跟 primary 同族不抢戏） |
| `--status-done` | `#7FB069` | 完成（鼠尾草绿） |
| `--status-failed` | `#C95C5C` | 失败（暖红，跟 destructive 一致） |

**对比度验证**（WCAG AA 4.5:1 normal text）：

- `#EDEAE3` on `#0F0E0D` ≈ 16:1 ✓
- `#94908B` on `#0F0E0D` ≈ 5.5:1 ✓
- `#D4A574` on `#0F0E0D` ≈ 9:1 ✓
- `#1B1917` on `#D4A574` ≈ 7:1 ✓（primary 按钮）

**主题策略**：dark-first 双主题。暗色是默认与首要调校对象；浅色 = 纯白画廊（clean light），顶栏「设置」左侧按钮切换，`<html class="light">` 触发 token 覆盖，localStorage `atelier:theme` 持久化（无存储 = 暗色）。组件只写语义 token，**禁止** `dark:` / `light:` 变体类——主题差异全部收在 `tokens.css`。

**浅色覆盖值**（仅列被覆盖的 token；阶梯方向与暗色相反 = 画布纯白最亮，表面与 hover 向灰走深）：

| Token | Light | 说明 |
|---|---|---|
| `--background` | `#FFFFFF` | 纯白画布 |
| `--card` / `--popover` | `#FAFAFA` / `#FFFFFF` | 卡片比画布灰半档；弹层回纯白靠发丝边分层 |
| `--secondary` / `--accent` / `--muted` | `#F0F0F0` / 同 / `#F5F5F5` | hover/选中比卡片再深一档 |
| `--foreground` / `--muted-foreground` | `#000000` / `#595959` | 纯黑 / 中性灰 |
| `--primary` / `--ring` | `#8F6234` | 黄铜压深保白底对比 |
| `--primary-foreground` | `#FFFFFF` | 铜底上的白字 |
| `--destructive` | `#B04A4A` | 暖红压深 |
| `--border` / `--input` | `rgba(0,0,0,0.12)` / `0.2` | 发丝边翻转为纯黑 alpha |
| `--glass` / `--scrim` | `rgba(255,255,255,0.66)` / `rgba(0,0,0,0.45)` | 白玻璃；遮罩仍压暗 |
| `--status-*` | `#767676` / `#A3742D` / `#4F7C3E` / `#B04A4A` | 中性灰 pending，其余同色相压深 |

浅色对比验证（WCAG AA 4.5:1）：`#000000` on `#FFFFFF` = 21:1 ✓；`#595959` ≈ 7:1 ✓；`#8F6234` ≈ 5.3:1 ✓；`#FFFFFF` on `#8F6234` ≈ 5.3:1 ✓。

## Elevation — 深度靠玻璃，不靠阴影

- ❌ **tsx 内联 `shadow-*` 全禁**（含 `drop-shadow`；`shadow-none` 例外）。暗色画廊里大投影没有用武之地，层级感主要来自玻璃和表面阶梯。
- ✅ **唯一放行的微阴影 = `.shell-glow`**（`tokens.css` 工具类，复刻 tapnow 玻璃卡）：顶部 `0 0.5px 0 inset` 发丝高光 + 一层极淡 `0 4px 16px` 软投影，亮暗各一套 token（`--hairline-inset` / `--scrim-soft`）。封装在 CSS 层、不进 tsx 内联，所以守卫正则无需放开——要微阴影就引 `shell-glow` 类，别在 tsx 写 `shadow-[...]`。输入壳 / 画廊图卡已接入。
- **玻璃配方**（浮层 / 悬浮 chrome 唯一写法）：

  ```
  bg-glass backdrop-blur-glass border border-border
  ```

  `backdrop-blur-glass` = 28px，是唯一允许的 backdrop-blur 档位（杂牌 sm/md/lg/xl/2xl 守卫红灯）。
- **遮罩配方**（lightbox / 全屏 loading）：`bg-scrim`（不再 `bg-black/85` 散值）。
- **z 梯度**（沿用既有层级，不得乱加）：内容 `auto` < 输入壳/弹窗 `z-20` < sticky 头 `z-30` < lightbox / 全屏 loading `z-50`。

## Spacing

- **Base unit**: 4px（Tailwind 默认）
- **Density**: comfortable to spacious —— 画廊要呼吸，不要 Notion 那种紧
- **Scale**:
  | Token | px | 用途 |
  |---|---|---|
  | `gap-1` | 4 | 图标 + 文字内部 |
  | `gap-2` | 8 | 紧密相关元素 |
  | `gap-3` | 12 | 同组按钮、cards |
  | `gap-4` | 16 | 表单字段间 |
  | `gap-6` | 24 | 板块内分组 |
  | `gap-8` | 32 | 大板块之间 |
  | `p-5` | 20 | 卡片/面板内边距（默认） |
  | `p-6` | 24 | 主内容区内边距 |
  | `p-8` | 32 | 详情页 hero 内边距 |

## Layout

- **Approach**: image-first + asymmetric whitespace（画廊式，非 dashboard 式）
- **Grid**:
  - 左栏（名册）：弹性 200–400px，默认 264，拖拽分界线调整、不可收起（`ResizableDivider`，宽度 localStorage 持久化）
  - 中栏：fluid（gallery）
  - 详情态左栏（胶片带）：弹性 72–320px，默认 104，拖过 64 收起为 0（header 浮出展开钮）
  - 详情态右栏（档案栏）：固定 384px
- **Max content width**: 无硬上限（gallery 需要充满）；详情页内文限 720px
- **Border radius**（面越大角越大；禁 `rounded-[…]` 任意值）:
  | Token | px | 用途 |
  |---|---|---|
  | `rounded-sm` | 6 | 小标签、tag |
  | `rounded-md` | 10 | 按钮、输入框 |
  | `rounded-lg` | 16 | 卡片、媒体瓦片、图片框 |
  | `rounded-xl` | 20 | 浮层：输入壳、popover、dialog |
  | `rounded-full` | 9999 | 圆形按钮、avatar、pill |

## 组件配方（写组件先查这里）

| 组件 | 配方 |
|---|---|
| Primary 按钮 | `bg-primary text-primary-foreground rounded-md hover:bg-primary/90`（每屏一处） |
| 次要按钮 | `bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80` |
| Outline 按钮 | `border border-border bg-transparent rounded-md hover:bg-accent` |
| 卡片 | `bg-card border border-border rounded-lg` |
| 媒体瓦片 | `rounded-lg overflow-hidden border border-border`（框架隐形，让图说话） |
| 选项弹窗（输入框控件 popover） | 面板 `bg-card border border-border rounded-xl`（**不透明**——内含可选项时玻璃透底会让选项难辨）；选项轨道 `bg-popover`（比面板亮一档）；选项 chip 默认透明贴轨道、左右贴紧（多行只留 `gap-y-1`），`hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60`。层级铁律：**越靠背景越深**，画布 → 输入壳 → 面板 → 轨道 → 选中/hover 单调变亮 |
| 玻璃浮层（无选项的悬浮 panel/菜单） | `bg-glass backdrop-blur-glass border border-border rounded-xl` |
| Studio 输入壳（滚动联动收放） | 浮于历史滚动区上（wrapper `pointer-events-none`，壳 `pointer-events-auto`，两侧视觉与交互都穿透）；`rounded-xl` 收放两态一致（胶囊 `rounded-full` 试装后被否——过圆），展开 `min-h-[174px]`，距底 >160px 收成单行条：控件行 `grid-rows-[0fr] opacity-0` 折叠、textarea 单行、参考堆叠 `scale-80`，全程 `transition 300ms`；点击收缩壳展开但**不回滚**，「回到底部」独立玻璃 pill 出现在壳右上方，点击**瞬时跳底**不播滚动过程 |
| 玻璃 pill（顶栏 tab） | `bg-glass backdrop-blur-glass border border-border rounded-full` |
| 顶栏圆形 icon 钮（主题切换 / 设置） | `h-10 w-10 rounded-full bg-glass backdrop-blur-glass text-muted-foreground hover:bg-secondary/60 hover:text-foreground`，icon 18px |
| 遮罩层（lightbox） | `fixed inset-0 z-50 bg-scrim` |
| 状态徽章 | `text-xs` + `text-[color:var(--status-*)]`（同字号靠颜色分语义） |
| 输入框 | `border border-input bg-transparent rounded-md focus-visible:ring-1 focus-visible:ring-ring` |
| 小帽标签 | `text-xs uppercase tracking-label text-muted-foreground/70` |
| 空状态 | `font-display text-display italic text-foreground/70` + 一行 `text-sm text-muted-foreground` 说明 |
| 无限画布 chrome | React Flow 只占平面层；项目切换、工具条、MiniMap 与节点设置统一使用 `bg-glass backdrop-blur-glass border border-border`，节点本体用 `bg-card border-border rounded-lg`。素材名固定显示在节点左上方；节点选中后，功能工具条固定出现在节点上方；768px 起生成设置作为节点下方独立浮层。当前 Content Version 来源为 `upload` 的图片是纯素材节点：选中后不挂载桌面或移动端生成设置，只显示上方工具条与节点右上角“替换”动作。生成设置的提示词上方使用 48px 素材缩略条展示当前 Input Connection，`+` 菜单只增删真实连接，不自动改写提示词里的 `@` token。两块跟随浮层都反向补偿画布缩放，保持固定屏幕尺寸，并允许随节点移出视口而被自然裁切，不做翻边或边缘钳位。375px 下生成设置降级为带 safe-area 的底部面板；MiniMap 与缩放 Controls 不占手机底部空间。触控板双指平移、捏合缩放，鼠标左键拖框选择；触屏单指平移、双指缩放。菜单打开后焦点进入首项，Esc 逐层关闭并回到触发器或画布。媒体双击或预览按钮进入有焦点陷阱的 Dialog。节点列表必须启用可见区域渲染、稳定对象 memo，图片原生 lazy，视频/音频接近视区后才绑定 `src` |

## Motion

- **Approach**: minimal-functional —— 只用帮助理解的过渡，不堆装饰动画
- **Easing**: `ease-out`（进入） / `ease-in`（离开） / `ease-in-out`（位置移动）
- **Duration**:
  - micro `75ms`：按钮按下、checkbox 状态
  - short `150ms`：hover、聚焦环
  - medium `250ms`：卡片展开、对话框
  - long `400ms`：页面切换（很少用）
- **Hover 准则**：图片卡片可以 `scale-[1.02]`（微妙提示可点击）；按钮只换颜色，不换大小
- **不用**：自动 loop 动画、装饰性渐入、scroll-driven 效果（这是工具不是营销页）

## 标志性细节（让产品有"自己的脸"）

1. **空状态用 serif** —— "请在左栏选择角色" 用 `font-display text-display`，瞬间让工具变画廊
2. **角色名用 serif** —— 详情页 / 卡片顶部的角色名也用衬线，加深"作品集"质感
3. **黄铜聚焦环** —— focus state 用 `ring-2 ring-primary`，最独特的视觉签名
4. **图片框无边框（仅发丝 border）** —— 让图本身说话，框架尽量隐形
5. **mono 字体处理 job_id / 路径** —— 技术细节用 mono，跟主 UI 文字形成清晰对比
6. **玻璃 chrome** —— 悬浮 UI（顶栏 pill、Studio 输入壳）统一 28px 毛玻璃，是工具的"材质签名"；**例外**：含选项的弹窗用不透明 `bg-card`（可读性优先）

## 反 AI Slop 清单（绝不出现在本项目；标 ⚙ 的由守卫测试强制）

- ❌ 紫色 / 蓝紫渐变（最 SaaS 的 cliché）
- ❌ 3 列 feature grid + 彩色圆圈图标
- ❌ 居中一切、统一 bubble border-radius
- ❌ Inter / Roboto / Arial 作为正文字体
- ❌ system-ui 作为 display 字体（"我放弃了排版"信号）
- ❌ 渐变按钮 / `bg-gradient` ⚙
- ❌ "Built for X" 营销文案
- ❌ `shadow-*` 阴影（深度靠玻璃） ⚙
- ❌ 任意值字号 `text-[Npx]`、`text-lg` 以上字号档 ⚙
- ❌ 硬编码色值（hex / 裸 rgba，必须走 token） ⚙
- ❌ `rounded-[…]` 任意值圆角、杂牌 `backdrop-blur-*` ⚙

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-18 | 创建初版 Atelier 设计系统 | 由 `/design-consultation` 在 Tailwind v4 + shadcn 迁移完成后生成。画师 = 创意用户，工具应有创意软件氛围而非 SaaS 通用感。 |
| 2026-05-18 | 用 Instrument Serif 做 display | 内部工具几乎都用 sans-serif，serif 让这个工具显得是"创意软件" |
| 2026-05-18 | primary 换 #D4A574 黄铜（替换 #3B82F6 蓝） | 通用蓝过于 generic；黄铜暖、独特、暗示"工艺/贵重" |
| 2026-05-18 | background 由 #0F0F0F 偏到 #0F0E0D 暖黑 | R略大于B，整体气质从"电子屏幕"偏向"画廊空间" |
| 2026-06-10 | 收编 Tapnow 方法论：画廊墙三定律 / 玻璃替代阴影 / 发丝边 / 表面阶梯 / 字阶压缩 / 圆角层级 | 抄方法论不抄皮肤——前端全 AI 生成导致 13 种字号、28 处无定义阴影；方法论 + 守卫止漂移 |
| 2026-06-10 | 主色保留黄铜，拒收 Tapnow 青 #1fa2dc | 单强调色的「纪律」学 Tapnow，「色相」是身份；延续 5-18 弃通用蓝决策 |
| 2026-06-10 | Geist 留任正文，serif 收敛为唯一大跳跃；拒收 Inter | Inter 在反 slop 红线上；serif 从「到处都是」收敛成 36px 单档，签名更贵 |
| 2026-06-10 | 加 designDrift.test.ts 漂移守卫 | 文档对 AI 是软约束，红灯才是硬约束 |
| 2026-06-10 | 选项弹窗从玻璃改 `bg-popover` 不透明，选项 chip 用 `bg-secondary/40` 三层分明 | 玻璃透底让弹窗里的选项与背景作品糊在一起（飙哥实测反馈）；玻璃保留给 pill / 输入壳 / lightbox 等无选项浮层 |
| 2026-06-10 | 弹窗/输入框层级改「越靠背景越深」单调阶梯：面板 `bg-card` → 轨道 `bg-popover` → 选中/hover `secondary`；棋子与底部控件默认透明，比例棋子左右贴紧 | 原来面板(#221F1C)里嵌更深的轨道(#1B1917)、控件(`bg-background/30`)比输入壳还深，两处倒挂（飙哥反馈）；token 值不动，只重排用法 |
| 2026-06-11 | 出图页历史改从下往上（col-reverse 原生钉底）+ 输入壳浮层化（两侧穿透）+ 滚动联动收放（>160 收 / <80 展，点击展开不回滚，「回到底部」独立 pill）；omni 参考归位 textarea 左侧倾斜堆叠 | 对齐即梦交互（飙哥指定参考）；底栏独占一排挡住历史、omni 资产行与首尾帧/图片参考的左置约定相悖；收缩态展开靠点击/焦点，滚动意图优先于停留状态 |
| 2026-06-12 | Layout 栏宽同步工坊重构现状：名册弹性 200–400（默认 264，不可收起）、胶片带 72–320（默认 104，<64 收起）、档案栏 384px | 工坊改弹性分界线后文档里的固定 280/360 已失实 |
| 2026-06-12 | 新增浅色主题（飙哥要求），dark-first 不变：`.light` 类覆盖 token，黄铜压深 #8F6234；禁 `dark:`/`light:` 变体类 | 主题差异收在 tokens.css 单点，组件零改动零分叉 |
| 2026-06-12 | 浅色从初版「暖纸画廊」(#F2EEE6 米色) 改纯白画廊：画布 #FFFFFF、卡片 #FAFAFA、纯黑字、发丝边纯黑 alpha，阶梯方向翻转（表面向灰走深） | 飙哥给参考站配色（bg #fff / card #fafafa / text #000/#404040 / border 黑 alpha），按参考调；品牌黄铜保留不跟参考站青色 |
| 2026-08-23 | 独立无限画布沿用暖黑平面 + 玻璃 chrome，节点保持不透明卡片，窄屏节点设置转为底部面板 | 保持人工创作空间的沉浸感，同时让可编辑表单不受底图干扰 |
