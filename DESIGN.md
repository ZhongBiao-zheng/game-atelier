# Design System — game-atelier

> 永远先读这份文档再做任何视觉 / UI 决定。
> 字体、颜色、间距、深度、组件配方都在这里定义。
> 本文档由 `web/src/test/designDrift.test.ts` 守卫强制执行：硬编码色值、任意值字号、阴影、杂牌圆角/模糊会直接红灯。
> 组件选用由 `web/src/test/nativeControlsGuard.test.ts` 守卫：页面写原生 input / select / textarea 会直接红灯。

---

## Product Context

- **What this is**: 游戏角色资产工作流 —— 画师 / 设计师可视化管理角色档案与 AI 出图的本地工具
- **Who it's for**: 主理人（开发者本人）+ 1-2 位合作画师
- **Space/industry**: 创意 / 游戏美术 / AI 辅助设计
- **Project type**: 本地桌面级 web 工具（不是 SaaS dashboard）

## Aesthetic Direction — "Atelier"（工坊 / 画廊）

- **Direction**: Editorial / Gallery — 石墨画廊为主，serif 点缀
- **Decoration level**: Minimal —— 排版 + 表面层级，不堆装饰
- **Mood**: 安静、克制、清晰；让 AI 生成的角色艺术做主角

**画廊墙三定律**（一切视觉决定的根）：

1. **中性框架** —— 石墨表面承托作品；主题色用于当前状态与主操作，类型和数据使用专用色板。
2. **深度靠玻璃，不靠阴影** —— 层级用毛玻璃 + 发丝边表达；阴影一律禁用。
3. **作品有呼吸的空间** —— 画布纯平（无渐变、无纹理），留白宽裕，框架隐形。

## Typography

- **Display / Hero**: **Instrument Serif**（中文字形由 **Noto Serif SC** 承接，栈内再回落 Songti SC / SimSun，不依赖系统默认衬线）— 仅用于「唯一大跳跃」：页面 hero、角色名、空状态主文案。配 `text-display`（36px / 400）。serif 是签名，克制才贵。
- **Body / UI**: **Inter**（中文字形由 **Noto Sans SC** 承接，不依赖系统苹方 / 雅黑）— 所有按钮、标签、表单、正文、区块标题
- **Data / Tables**: **Inter** with `tabular-nums` —— 日期、时间、耗时、价格、数量都用它，不用等宽字体
- **Code / Technical**: **JetBrains Mono** — 只用于 job_id、文件路径、seed、URL、代码、密钥掩码、hex 色值
- **Loading**: 全部字体用 Fontsource 包打进 `web/dist`，**不从任何外部 CDN 加载**（国内不翻墙与离线安装包都要显示一致）

**Scale（四档，守卫强制）**：

| Token | Size | Usage |
|---|---|---|
| `text-xs` | 12px | 元数据、tag、状态标签、小帽标签（**12px 是下限，禁任意值字号**） |
| `text-sm` | 14px | 主 UI 文本（按钮、标签、正文默认） |
| `text-base` | 16px | 区块标题（配 `font-medium`）、强调正文 |
| `text-display` | 36px/44px | 唯一大跳跃：hero / 角色名 / 空状态（配 `font-display`，weight 400） |

- ❌ **禁用** `text-lg` / `text-xl` / `text-2xl` / `text-3xl` / `text-4xl` 与一切 `text-[Npx]` 任意值。
- 层级不够用？用字重（400/500/600）和颜色（foreground / muted-foreground），不是字号。
- **小帽标签**：拉丁文案 `text-xs uppercase tracking-label text-muted-foreground`（`tracking-label` = 0.18em，唯一字距 token）；中文文案只写 `text-xs text-muted-foreground`，不加字距（0.18em 会把汉字拉散）。
- **文字透明度下限**：12px 文字不得用 `text-muted-foreground/70` 及更低档——`/70` 在画布上约 3.5:1，不达 AA；要更弱的层级用字重或位置，不用透明度。图标与分隔符不受此限。

**Font-weight 策略**：

- Inter / Noto Sans SC：400（正文）/ 500（按钮、强调、区块标题）/ 600（少量小标题）
- Instrument Serif：400 only（衬线粗体会失去优雅）
- JetBrains Mono：400 / 500

## Color — Graphite + Configurable Accent

暗色底固定为冷调石墨，浅色保持纯白画廊。完整色值和七套预设见 [主题色规范](docs/design/theme.md)。

| 层级 | 暗色值 | 用途 |
|---|---|---|
| `--background` | `#0A0A0B` | 页面、侧栏、画布 |
| `--panel` | `#111113` | 控制台内容面板 |
| `--card` / `--muted` | `#18181B` | 卡片 |
| `--popover` | `#1C1C1F` | 抬起的导航行、弹层 |
| `--secondary` / `--accent` | `#26262A` | hover、次要按钮、轨道 |
| `--foreground` | `#EDEDEF` | 主文字 |
| `--muted-foreground` | `#8E8E93` | 次要文字 |
| `--subtle-foreground` | `#5C5C61` | 组名、面包屑 |
| `--border` / `--input` | 白色 8% / 14% | 发丝边、输入框 |
| `--glass` / `--scrim` | `rgba(17,17,19,0.66)` / `rgba(0,0,0,0.62)` | 玻璃、遮罩 |

**主题色组**：`--primary` + `--brand-2/3/4`，默认青柠；用户在设置 / 外观选择预设或配置四个 hex。`--accent` 仍专用于 shadcn hover 底色。

1. 主色只用于当前状态或主操作：选中导航、主按钮、范围分段、今天的柱子、额度条、上涨标签、开关、焦点环、画布选区。
2. 类型标签：图片用 `--brand-2`，视频用 `--brand-3`，文本用 `--brand-4`；音频保持中性标签。
3. 未选中侧栏为中性灰图标与文字，无色块；选中项为 `bg-popover` 行底 + 主色实心图标块。
4. 数据色固定为五色糖果色 `--chart-1…5`，每张排行卡按行序分配，必须带名称标签。切换主题色不改变数据色。
5. 状态色固定：等待 `#5C5C61`、运行 `#F2A33A`、完成 `#52AB69`、失败 `#E5534B`。切换主题色不改变状态语义。
6. 主色文字在 `#0A0A0B` 与 `#FFFFFF` 之间自动选择对比度更高者，按当前模式的实际派生色计算。

**亮暗模式**：暗色默认，支持浅色和跟随系统；`atelier:theme` 保存选择，`atelier:accent` 保存预设 ID 或原始自定义四颜色。React 渲染前应用，全站监听存储变化；跟随系统监听 `prefers-color-scheme`。浅色模式的主副色在 OKLCH 中设 L=0.5、C/h 不变；固定数据色用 L=0.55。浅色背景与原有文字、玻璃和状态 token 保持原规则。派生色不写回存储。组件仅使用语义 token，禁 `dark:` / `light:` 分支。

**派生样式**：主色 14% 标签底、30% 历史柱、6% 面板右上径向光晕，以及类型标签背景，全部封装在 `tokens.css`；tsx 不写裸 hex、rgba 或渐变。

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

页面只组合 `web/src/components/ui/` 的组件。组件清单与选用规则见 [组件规范](docs/design/components.md)；Studio、画布、控制台等具体界面的布局与交互见 [界面规格](docs/design/surfaces.md)。

| 组件 | 配方 |
|---|---|
| Primary 按钮 | `bg-primary text-primary-foreground rounded-md hover:bg-primary/90`（每屏一处） |
| 次要按钮 | `bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80` |
| Outline 按钮 | `border border-border bg-transparent rounded-md hover:bg-accent` |
| 卡片 | `bg-card border border-border rounded-lg` |
| 媒体瓦片 | `rounded-lg overflow-hidden border border-border`（框架隐形，让图说话） |
| 选项弹窗（输入框控件 popover） | 面板 `bg-card border border-border rounded-xl`（**不透明**——内含可选项时玻璃透底会让选项难辨）；选项轨道 `bg-popover`（比面板亮一档）；选项 chip 默认透明贴轨道、左右贴紧（多行只留 `gap-y-1`），`hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60`。层级铁律：**越靠背景越深**，画布 → 输入壳 → 面板 → 轨道 → 选中/hover 单调变亮 |
| 玻璃浮层（无选项的悬浮 panel/菜单） | `bg-glass backdrop-blur-glass border border-border rounded-xl` |
| 玻璃 pill（顶栏 tab） | `bg-glass backdrop-blur-glass border border-border rounded-full` |
| 顶栏圆形 icon 钮（主题切换 / 设置） | `h-10 w-10 rounded-full bg-glass backdrop-blur-glass text-muted-foreground hover:bg-secondary/60 hover:text-foreground`，icon 18px |
| 遮罩层（lightbox） | `fixed inset-0 z-50 bg-scrim` |
| 状态徽章 | `text-xs` + `text-[color:var(--status-*)]`（同字号靠颜色分语义） |
| 输入框（`Input`） | `border border-input bg-transparent rounded-md focus-visible:ring-1 focus-visible:ring-ring` |
| 下拉（`Select`） | 外观由 `tokens.css` 的 base 规则统一（去系统箭头、`--select-chevron` 发丝箭头、右内边距 2rem）；`Select` 组件已带与输入框相同的边框 / 圆角 / 高度，不再各自画箭头 |
| 小帽标签 | 拉丁 `text-xs uppercase tracking-label text-muted-foreground`；中文 `text-xs text-muted-foreground` |
| 空状态 | `font-display text-display italic text-foreground/70` + 一行 `text-sm text-muted-foreground` 说明 |

## Motion

- **Approach**: minimal-functional —— 只用帮助理解的过渡，不堆装饰动画
- **Easing**: `ease-out`（进入） / `ease-in`（离开） / `ease-in-out`（位置移动）
- **Duration**:
  - fast `150ms`（`--motion-fast` / `duration-150`）：hover、聚焦环、浮层进出
  - base `200ms`（`--motion-base` / `duration-200`）：遮罩、展开
  - slow `300ms`（`--motion-slow` / `duration-300`）：输入壳收放、位置移动
- **Hover 准则**：图片卡片可以 `scale-[1.02]`（微妙提示可点击）；按钮只换颜色，不换大小
- **不用**：自动 loop 动画、装饰性渐入、scroll-driven 效果（这是工具不是营销页）

## 标志性细节（让产品有"自己的脸"）

1. **空状态用 serif** —— "请在左栏选择角色" 用 `font-display text-display`，瞬间让工具变画廊
2. **角色名用 serif** —— 详情页 / 卡片顶部的角色名也用衬线，加深"作品集"质感
3. **主题色聚焦环** —— focus state 用 `ring-2 ring-primary`，最独特的视觉签名
4. **图片框无边框（仅发丝 border）** —— 让图本身说话，框架尽量隐形
5. **mono 字体处理 job_id / 路径** —— 技术细节用 mono，跟主 UI 文字形成清晰对比
6. **玻璃 chrome** —— 悬浮 UI（顶栏 pill、Studio 输入壳）统一 28px 毛玻璃，是工具的"材质签名"；**例外**：含选项的弹窗用不透明 `bg-card`（可读性优先）

## 反 AI Slop 清单（绝不出现在本项目；标 ⚙ 的由守卫测试强制）

- ❌ 紫色 / 蓝紫渐变（最 SaaS 的 cliché）
- ❌ 3 列 feature grid + 彩色圆圈图标
- ❌ 居中一切、统一 bubble border-radius
- ❌ Roboto / Arial / 系统默认字体作为正文字体；从外部 CDN 加载字体
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
| 2026-10-12 | 只读状态从顶部居中浮条改为顶栏字标右侧胶囊；12px 文字禁用 `/70` 以下透明度；中文小帽标签去字距；display 栈补 Noto Serif SC；动效时长以 token 三档为准；删 `--radius-2xl` | UI 评审（Claude Design 画布 + Mobbin 参考）：浮条在 lg 以上压住导航 tab；`/70` 约 3.5:1 不达 AA；Instrument Serif 无中文字形，原先落到系统宋体，跨平台不一致 |
| 2026-10-13 | 画布四角各管一类：左上项目与画布菜单（重命名 / 生成偏好 / 快捷键 / 设置 / 外观），右上生成中计数与 Agent，左下资产，右下小地图 / 缩放百分比 / 适应全部；删缩放滑杆。图片节点工具条直接露出前 4 个快捷工具 + 图生图 + 更多 + 保存 + 隐藏；生成面板去标题行 | UI 评审第二轮（Mobbin：FLORA、Weavy、ElevenLabs Flows、Runway）：左下 5 个图标混了视图、内容、设置三类；工具条 13 项占 870px。飙哥定：生成面板保持跟随节点、不做撤销重做按钮与保存状态文字、连接线不换、保存与隐藏保持固定 |
| 2026-10-13 | 裁剪 / 切分弹窗改左图右栏（舞台用 container-type: size 让图片等比铺满，右栏 18rem）；裁剪框外四块遮罩压暗、三分线、L 形角手柄；尺寸只留宽高像素输入（失焦或回车提交），不做 X / Y；切分块编号 + 结果尺寸列表、行列步进、四个预设 | Mobbin 参考 Air、Telegram、Shopify、Squarespace 的裁剪器；原先竖排一列，图高时整个弹窗滚动，百分比输入不直观 |
| 2026-10-24 | 设置拆为七个控制台地址，用量统一展示个人与团队花费 | PRD D1–D13：配置、观测、资源、扩展分组，局域网额度仅在用量页出现 |
| 2026-10-24 | 主色改为可配置、默认青柠，底色改为石墨；推翻 2026-05-18 和 2026-06-10 两条黄铜决定 | 暖棕加黄铜显旧显脏。主副色、固定数据色与状态色分离，详见 [主题色规范](docs/design/theme.md)；历史日志中的暖黑与黄铜记录不再作为现行规则。 |
| 2026-10-26 | 正文改用 Inter + Noto Sans SC，全部字体本地打包，等宽字体只留给技术信息；推翻 2026-06-10「Geist 留任、拒收 Inter」 | 中文原本落到系统字体，Mac 苹方与 Windows 雅黑不一致；Google Fonts 在国内不翻墙与离线安装包下加载失败；同类工具 Tapnow / Lovart / LibTV 均为 Inter + 中文网页字体（读其线上 CSS 得出）；创作台 93 处等宽字体让数据行与正文割裂 |
| 2026-10-29 | 页面禁写原生 input / select / textarea，补 `SecretInput` / `Select` / `Checkbox` / `Radio` / `Slider` / `FileInput`；原生 button、bare 控件、任意值间距走棘轮；界面规格拆到 `docs/design/surfaces.md`，组件选用写入 `docs/design/components.md` | 组件层已有但被绕开：78 处原生控件、32 个文件手抄防填充属性，密钥框的保存密码修法只留在单页；本文件混入大段界面交互，通用配方被冲淡 |
