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

暗色底固定为冷调石墨，浅色为浅灰画廊（画布 `#F2F2F3`、卡片与弹层纯白）。两种模式都是越靠背景越深。完整色值和七套预设见 [主题色规范](docs/design/theme.md)。

**作品图发丝边**：作品图卡片加 `.media-edge`，图片上方叠一道 1px 内侧边（`--media-edge`，浅色黑 7%、暗色白 8%），让底色接近画布的图也有边界。容器自带圆角与 `overflow-hidden`。

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
| `--border` / `--input` | 白色 8% / 14%（浅色：黑 8% / 10%） | 发丝边、输入框 |
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
- **画布节点里没有玻璃**：xyflow 视口（随画布缩放的那一层）里的浮层——尺寸、定稿、标注开关、播放条、候选按钮——由 `tokens.css` 统一去掉 `backdrop-filter`，底色换成 `--canvas-chip`（暗色 88% / 浅色 90% 平底）。WebKit（Safari、桌面版）遇到 `backdrop-filter` 会把整个节点按 1 倍栅格化后随缩放拉伸，放大后图片和文字一起发虚。节点外的工具条与面板照旧用玻璃。守卫：`web/src/test/canvasViewportGlass.test.ts`。
- **浅色主题的深度**：白面 + 黑 8% 发丝边 + 柔和投影，不用暗色的顶部高光、上亮下暗斜面和金属描边环。投影只有两档 token，只在 `:root.light` 定义：`--elevation-float`（浮动 chrome、Popover / Dropdown / Dialog / Select / 工具栏弹层）与 `--elevation-raised`（导航选中药丸）。全部写在 `tokens.css` 的 `:root.light` 规则里，tsx 照旧不写 `shadow-*`。主色 / 危险按钮在浅色下是平涂实色块，outline 是白底发丝边；按钮变体靠 `ui/button.tsx` 上的无样式标记类 `btn-default` / `btn-destructive` / `btn-outline` / `btn-secondary` 区分。深色 token 与深色玻璃配方由 `web/src/test/themeTokens.test.ts` 钉死。
- **遮罩配方**（lightbox / 全屏 loading）：`bg-scrim`（不再 `bg-black/85` 散值）。遮罩上白色图标按钮的悬停底用 `bg-scrim-strong`（暗色 82% / 浅色 72% 黑），不用 `bg-background/*`：浅色主题的 background 是浅灰，白图标会看不见。
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

## 图标

图标库为 Hugeicons Rounded Stroke（免费 MIT），唯一入口是 `web/src/components/ui/icons.tsx`。页面只导入语义图标（`CloseIcon`、`RetryIcon`…），不直接用图标库。⚙ 守卫测试强制。

| 档位 | 像素 | 用途 |
|---|---|---|
| `sm` | 14 | 芯片、标签、正文内联 |
| `md`（默认） | 16 | 按钮、菜单、列表、输入框前后缀 |
| `lg` | 18 | 顶栏导航、画布与创作台悬浮工具条 |
| `xl` | 24 | 空状态、媒体占位 |

1. 尺寸只用 `size` 档位，不写 `size-*` / `h-*` / `w-*` 类、数字尺寸或 `strokeWidth`。描边由注册表固定为 1.5，`sm` 补到 1.75。`Button` / `Select` / `Tabs` / `Toggle` 内的图标由组件统一为 16px。
2. 一个含义只对应一个图标。新图标先在注册表登记语义名，同一图形可服务多个语义（如停止、空白背景、矩形工具都是方块）。
3. 选图优先 Hugeicons 原生带编号的版本；包里不带编号的 Lucide 移植名（`BotIcon`、`ScissorsIcon`…）只在原生没有合适图形时用。挑选时放 16px 与 24px 两档并排看，避免手势类、含义不清的变体。
4. 选中态靠底色块表达，不换实心图标（免费版只有线性风格）。
5. 命令式 DOM（contentEditable 芯片）用 `iconMarkup(Icon, size)` 取 SVG 字符串，不手抄路径。
6. 品牌与自绘图标不走注册表：`ModelBrandIcon`、`ProviderBrandIcon`、`GitHubIcon`、`RatioIcon`、标注工具条的自绘 SVG；尺寸同样用四档。

## 组件配方（写组件先查这里）

页面只组合 `web/src/components/ui/` 的组件。组件清单与选用规则见 [组件规范](docs/design/components.md)；Studio、画布、控制台等具体界面的布局与交互见 [界面规格](docs/design/surfaces.md)。

| 组件 | 配方 |
|---|---|
| Primary 按钮 | `bg-primary text-primary-foreground rounded-md hover:bg-primary/90`（每屏一处） |
| 次要按钮 | `bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80` |
| Outline 按钮 | `border border-border bg-transparent rounded-md hover:bg-accent` |
| 卡片 | `bg-card border border-border rounded-lg` |
| 媒体瓦片 | `rounded-lg overflow-hidden border border-border`（框架隐形，让图说话） |
| 选项弹窗（输入框控件 popover） | 面板 `bg-card border border-border rounded-xl`（**不透明**——内含可选项时玻璃透底会让选项难辨）；选项轨道 `bg-popover`（比面板亮一档）；选项 chip 默认透明贴轨道、左右贴紧（多行只留 `gap-y-1`），`hover:bg-secondary/60`；选中滑块 `bg-secondary ring-1 ring-inset ring-primary/60`，选中项不叠 hover 底色（`data-[state=on]:hover:bg-transparent`）。层级铁律：**越靠背景越深**，画布 → 输入壳 → 面板 → 轨道 → 选中/hover 单调变亮 |
| 玻璃浮层（无选项的悬浮 panel/菜单） | `bg-glass backdrop-blur-glass border border-border rounded-xl` |
| 玻璃 pill（顶栏 tab） | `bg-glass backdrop-blur-glass border border-border rounded-full` |
| 顶栏圆形 icon 钮（主题切换 / 设置） | `h-10 w-10 rounded-full bg-glass backdrop-blur-glass text-muted-foreground hover:bg-secondary/60 hover:text-foreground`，图标 `size="lg"` |
| 遮罩层（lightbox） | `fixed inset-0 z-50 bg-scrim` |
| 状态徽章 | `text-xs` + `text-[color:var(--status-*)]`（同字号靠颜色分语义） |
| 输入框（`Input`） | `border border-input bg-transparent rounded-md focus-visible:ring-1 focus-visible:ring-ring` |
| 下拉（`Select`） | 外观由 `tokens.css` 的 base 规则统一（去系统箭头、`--select-chevron` 发丝箭头、右内边距 2rem）；`Select` 组件已带与输入框相同的边框 / 圆角 / 高度，不再各自画箭头 |
| 小帽标签 | 拉丁 `text-xs uppercase tracking-label text-muted-foreground`；中文 `text-xs text-muted-foreground` |
| 空状态 | `font-display text-display italic text-foreground/70` + 一行 `text-sm text-muted-foreground` 说明 |

## Motion

- **Approach**: minimal-functional —— 只用帮助理解的过渡，不堆装饰动画
- **唯一来源**：CSS 侧 `tokens.css`（`--motion-*`、`--ease-atelier-*`），JS 侧 `lib/motion.ts`（同值，外加弹簧）。Tailwind 的 `transition-*` / `ease-*` 默认值已指向这里，散写的类自动对齐；JS 动画只用 motion（`motion/react`），不另引动画库
- **Easing**（不用 ease-in：原地关闭时前几帧几乎不动，像卡住）:
  - out `cubic-bezier(0.22,1,0.36,1)`（`--ease-atelier-out`）：200–300ms 的空间进场——面板滑入、弹窗放大、大图展开
  - subtle `cubic-bezier(0.2,0,0,1)`（`--ease-atelier-subtle`）：150ms 的颜色、透明度、4px 微位移，以及所有退场；Tailwind 过渡类默认
  - in-out `cubic-bezier(0.65,0,0.35,1)`（`--ease-atelier-in-out`）：屏上 A→B 位移、展开收起、视口平移
- **Duration**:
  - fast `150ms`（`--motion-fast` / `duration-150`）：hover、聚焦环、浮层进出、图标与文案换态
  - base `200ms`（`--motion-base` / `duration-200`）：遮罩、弹窗进场、内容交叉淡化
  - slow `300ms`（`--motion-slow` / `duration-300`）：展开收起、输入壳收放、位置移动
  - 跟手的操作（拖动、调整大小、滑杆）不加过渡
- **弹簧**（`MOTION_SPRING`）：`snappy` 无回弹，给选中滑块、布局移动、拖拽让位，中途打断时带速度接上；`pop`（轻回弹）只给 24px 以内的正向确认图标（喜欢、复制成功、保存成功的勾），功能开关的图标换态用平稳版。例外：画布创建句柄的磁吸归位允许轻微回弹（`magneticHandle.ts`），那是有意的磁吸手感
- **退场**：一律 fast 150ms + subtle，比进场短
- **出入方向**：浮层从触发器一侧滑出（读 Radix `data-side` 与 `--radix-popper-transform-origin`）；居中弹窗以中心从 96% 放大淡入（`.dialog-in`）
- **按下**：紧凑按钮按住缩到 97%；撑满容器的按钮（`w-full` / `h-full` / `flex-1`、列表选项、单选项、菜单项）不缩，反馈交给底色，其他大卡片式按钮加 `data-press="none"`
- **Hover 准则**：图片卡片可以 `scale-[1.02]`（微妙提示可点击）；按钮悬停只换颜色，不换大小
- **数字**：价格、用量、计数、耗时变化时直接换数，靠 `tabular-nums` 防抖，不做数字滚动
- **减弱动态效果**：去掉位移、缩放、尺寸动画，保留 150ms 以内的透明度与颜色淡变；表示进行中的转圈照转（停了分不清卡死还是在跑）
- **选中指示**：单选组的选中态是一个跟着选中项滑动的独立层（`SelectionHighlight`，snappy 弹簧）——分段、按钮组（`ToggleGroup sliding`）、页签（默认为底色，线型为 2px 下划线）、控制台侧栏（认 `aria-current`）都用它；选中不改字重，宽度不跳。菜单、下拉的高亮瞬切（macOS 式，不加过渡）
- **开关与勾选**：Switch 滑块、勾选框的勾、单选的圆点只在用户碰过控件之后才过渡（勾与圆点 150ms 缩放淡入）；进页面晚一步读回的值直接落位，打开一列已勾选的清单不集体弹
- **弹窗退场**：一律受控 `open`，关闭期间沿用最后一份内容（`ui/retained` 的 `useRetained`；带表单状态的用 `useRetainedSession` 的会话号作 key）；不写「条件渲染 + `open` 写死」，那样退场动画播不出来
- **慢一步才给的反馈**：短暂等待不出声——断线条 400ms 后才出现、恢复时淡出；启动页文案 300ms 后才出现，主内容第一次出现 200ms 淡入；刷新中的旧内容 150ms 后才降透明度。旧内容留到新内容就绪
- **生成中**：占位卡底部 2px 渐近细条（`scaleX`，按预期耗时逼近 90%，完成冲满后随占位淡出），**不显示百分比**——上游没有真实进度，台阶百分比会停死再骤跳
- **成功与失败**：成功是图标原位换成勾（`SwapIcon variant="pop"`），不配「已完成」字；只有没有原位锚点的后台完成才发 toast。失败是错误色 + 警示图标 + 触发失败的那个局部元素 250ms 水平微抖（`shakeOnError`），不抖整张卡或整个弹窗；减弱动态效果时不抖
- **表单校验失败**：错误说明行用 `Collapse` 展开，不生硬推挤；首个出错字段 `aria-invalid` 红框，不在可见区时平滑滚到中间再聚焦并微抖（`revealInvalidField`）
- **复制反馈**：`useCopyFeedback`（1.5 秒后自动退回）+ 图标 `SwapIcon pop` 换勾或按钮文案 `SwapLabel` 换「已复制」；不永远停在「已复制」
- **深浅色与主题色切换**：支持 View Transition 时整屏 200ms 交叉淡入（`lib/theme.ts` 的 `transitionTheme`）；不支持或减弱动态效果时一次到位。两种情况切换那一帧都关掉元素自己的过渡，同一屏不混着新旧主题
- **列表里结束的一项**：先在原位显示结果约 1 秒，再用 grid-rows 1fr→0fr 收起并淡出，不一闪就跳到别的分组；刚落到新分组的项在目标处描边高亮约 1.5 秒
- **滚动边缘渐隐**：`.scroll-fade-y` + `useScrollFade`，渐隐宽度随离顶 / 离底的距离连续变化，到头正好收成 0，不靠增删类名硬切
- **桌面壳窗口失焦**：`<html data-window-inactive>`，顶栏 150ms 降对比度；焦点进了插件 iframe 不算失焦
- **触屏（`hover: none`）**：Tailwind 的 `hover:` 只在能悬停的设备上生效，触屏不会粘住悬停态；`tokens.css` 里手写的 `:hover` 规则包在 `@media (hover: hover)` 里。只在悬停时出现的操作，触屏上至少让高频项（喜欢、使用）常驻（`[@media(hover:none)]:opacity-100`）
- **提示（toast）**：全站只挂一个 `Toaster`（AppShell，右上角顶栏下方），进退场时长与曲线走 token；页面只经 `lib/notify.ts` 发（`notify.error / undo / info`）。撤销提示 8 秒、悬停暂停、「撤销」按钮在右；toast 里不放上游原文
- **进程文案**：一律「X中…」，不用「正在X」，不拟人（「模型在画了…」→「生成中…」）。独立的进程标签、加载占位带中文省略号「…」；带数量或阶段的胶囊不加（「排队第 3 位」）。按钮里只写 2–3 字动词（「保存中…」「停止中…」，换态用 `SwapLabel`）；全屏 / 横幅级补 2–4 字对象（「启动中…」「恢复连接中…」「重启中…」）。同义词收口：读取 / 正在读取 → 加载中…；检测 / 正在检查 → 检查中…；凭证与格式校验 → 校验中…；任务响应 → 处理中…。延迟 300ms 才出现的文案也用同一句，不加「请稍候」之类安抚语
- **不用**：自动 loop 动画（进行中指示除外）、装饰性渐入、scroll-driven 效果（这是工具不是营销页）

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
| 2026-10-13 | 画布四角各管一类：左上项目与画布菜单（重命名 / 生成偏好 / 快捷键 / 设置 / 外观），右上生成中计数与 Agent，左下资产，右下小地图 / 缩放百分比 / 适应全部；删缩放滑杆。图片节点工具条直接露出前 4 个快捷工具 + 图生图 + 更多 + 保存 + 隐藏（工具条部分已由 2026-11-25 那行取代）；生成面板去标题行 | UI 评审第二轮（Mobbin：FLORA、Weavy、ElevenLabs Flows、Runway）：左下 5 个图标混了视图、内容、设置三类；工具条 13 项占 870px。飙哥定：生成面板保持跟随节点、不做撤销重做按钮与保存状态文字、连接线不换、保存与隐藏保持固定 |
| 2026-10-13 | 裁剪 / 切分弹窗改左图右栏（舞台用 container-type: size 让图片等比铺满，右栏 18rem）；裁剪框外四块遮罩压暗、三分线、L 形角手柄；尺寸只留宽高像素输入（失焦或回车提交），不做 X / Y；切分块编号 + 结果尺寸列表、行列步进、四个预设 | Mobbin 参考 Air、Telegram、Shopify、Squarespace 的裁剪器；原先竖排一列，图高时整个弹窗滚动，百分比输入不直观 |
| 2026-10-24 | 设置拆为七个控制台地址，用量统一展示个人与团队花费 | PRD D1–D13：配置、观测、资源、扩展分组，局域网额度仅在用量页出现 |
| 2026-11-17 | 画布视口里的浮层去掉背景模糊，改 `--canvas-chip` 平底（浏览器与桌面版一致） | WebKit 把含 `backdrop-filter` 的节点按 1 倍栅格化，画布放大到 300% 以上时图片与尺寸徽标发虚（桌面版实测，Safari 同样，Chrome 不受影响）；见 `.scratch/desktop-feel/PLAN.md` 第 3 节 |
| 2026-10-24 | 主色改为可配置、默认青柠，底色改为石墨；推翻 2026-05-18 和 2026-06-10 两条黄铜决定 | 暖棕加黄铜显旧显脏。主副色、固定数据色与状态色分离，详见 [主题色规范](docs/design/theme.md)；历史日志中的暖黑与黄铜记录不再作为现行规则。 |
| 2026-10-26 | 正文改用 Inter + Noto Sans SC，全部字体本地打包，等宽字体只留给技术信息；推翻 2026-06-10「Geist 留任、拒收 Inter」 | 中文原本落到系统字体，Mac 苹方与 Windows 雅黑不一致；Google Fonts 在国内不翻墙与离线安装包下加载失败；同类工具 Tapnow / Lovart / LibTV 均为 Inter + 中文网页字体（读其线上 CSS 得出）；创作台 93 处等宽字体让数据行与正文割裂 |
| 2026-10-29 | 页面禁写原生 input / select / textarea，补 `SecretInput` / `Select` / `Checkbox` / `Radio` / `Slider` / `FileInput`；原生 button、bare 控件、任意值间距走棘轮；界面规格拆到 `docs/design/surfaces.md`，组件选用写入 `docs/design/components.md` | 组件层已有但被绕开：78 处原生控件、32 个文件手抄防填充属性，密钥框的保存密码修法只留在单页；本文件混入大段界面交互，通用配方被冲淡 |
| 2026-11-08 | 图标从 Lucide 换成 Hugeicons Rounded Stroke，建语义注册表 `ui/icons.tsx`，尺寸收为 14/16/18/24 四档、描边固定 1.5，守卫禁止直接导入图标库与散写尺寸 / 描边 | 87 个文件各自导入 Lucide，同一含义有两个名字（HelpCircle / CircleHelp 等 8 组），尺寸 8 档、描边 5 种。Mobbin 同类工具（Framer、ElevenLabs Flows、Luma、Weavy）统一单一线性图标族、描边约 1.5；Hugeicons 的圆头圆角与圆角卡片、药丸导航一致 |
| 2026-11-08 | 浅色底从纯白改为浅灰 `#F2F2F3`，卡片 / panel / muted 改纯白，secondary / accent 改 `#E9E9EB`，侧栏与画布同色；作品图卡片加 `.media-edge` 内侧发丝边；推翻 2026-06-12「纯白画廊」 | 纯白底上白底作品图与页面连成一片，大面积纯白刺眼（飙哥反馈）。参考 Gamma / mymind / Luma：浅灰画布、白色内容面。选中性灰，避开 06-12 被否的暖米色；浅色阶梯与暗色统一为越靠背景越深 |
| 2026-10-30 | 原生 button / label 与 `title` 提示清零后改为硬禁止；Select / Checkbox / Slider / Switch 换成 Radix，补 Tooltip（`Hint`）/ Tabs / ToggleGroup / RadioGroup / Popover / AlertDialog / InputGroup / EditableText；任意值间距清零后禁写 | 原生 select 箭头与 range 进度条靠 tokens.css 全局样式兜底，各平台外观不一；原生 title 提示延迟长、样式不可控；263 处原生 button 各写一套焦点环 |
| 2026-11-16 | 浅色主题统一为「白面 + 发丝边 + 柔和投影」：border 黑 12%→8%、input 黑 20%→10%；导航选中药丸改白底 + 发丝边 + `--elevation-raised`，去掉金属描边环与斜面；`shell-glow` 与浮层在浅色下用 `--elevation-float`；主色 / 危险按钮平涂 100% 实色，outline 四边同色发丝边；深色不变 | 深色的顶部高光、斜面、描边环在浅色下只是被翻转，出现灰环、上亮下暗和偏黑粗框（飙哥反馈）。参考 Luma、Recraft、Canva、Base44 的浅色界面与 shadcn new-york 默认值；input 先取 12%，与导航胶囊并排后仍明显偏重，降到 10%。规格与截图在 `.scratch/light-theme/` |
| 2026-11-13 | 作品图透明区域显示棋盘格：`.media-checker` 挂在 `<img>` 自身背景上（创作台卡片、大图、首页作品墙、画布图片节点），格子色 = 前景 10% 混进 `--card`，深色主题深底浅格、浅色主题自动白底浅灰格，格子 10px | 透明 PNG 放在深色卡片上看不出透明（飙哥反馈）；Mobbin 参考 Leonardo（深色）、Canva / Adobe Express（浅色）；不透明图会整块盖住背景，所以不用逐张判断是否透明 |
| 2026-11-25 | 动效统一：JS 动画只留 motion（移除 GSAP 与未使用的 tw-animate-css）；Tailwind 过渡类默认值指向 `--motion-*` / `--ease-atelier-*`，曲线改为 out（quint）/ subtle / in-out 三条并取消 ease-in，新增弹簧 `snappy` / `pop`；浮层按弹出方向滑入，居中弹窗改中心放大；按下缩放只给紧凑按钮且不再覆盖按钮自带过渡；减弱动态效果改为只去位移缩放、保留淡变；主题色卡去掉无限漂移；提示共用一个 Provider | 全项目按「状态变化」审查：四套动画来源节奏不一；全局按下规则吃掉按钮的尺寸与焦点环过渡；向上弹的浮层从反方向掉下；散写过渡不响应减弱动态效果 |
| 2026-11-25 | 动效批 2–4：单选组选中统一为滑动独立层（Tabs、ToggleGroup sliding、控制台侧栏）、菜单高亮瞬切；弹窗一律受控 open + 缓存最后一份内容；慢反馈（断线 400ms、启动文案 300ms）；生成中 2px 渐近细条不显示百分比；失败局部微抖、校验失败滚入后微抖；触屏规则与进程文案「X中…」句式写进 Motion | 审查 01 / 05 与顾问意见 Q10–Q15；状态变化要有连续性，短暂等待不出声，同一类反馈全站一种做法 |
| 2026-11-27 | 画布文本节点只做预览，读写移到节点下方面板：面板顶部「内容 / 生成」切换（有正文默认「内容」）；「内容」页正文区 + 底部「改写」（选中一段只改这段，结果写回本节点、可撤销）；指针在节点正文上时滚轮滚正文（不论是否选中），其余位置滚画布；双击节点把光标交给面板正文 | 试用反馈：长文案在 220px 小框里难读；滚轮在只读态缩放、编辑态滚内容；只能整段重生成且每次另起新节点。Mobbin 参考 Coda / Confluence / Obvious 的「选中→指令→原位替换」与 StackAI / WRITER 的「节点预览 + 面板读全文」。飙哥定：采用「内容 / 生成」两页（不叫 Agent）、滚轮按指针位置判定、直接写回 + 撤销、双击跳到面板。规格见 `.scratch/canvas-text-node/DESIGN.md` |
| 2026-11-25 | 「复杂留给系统」：删除可恢复的不确认、给撤销——已付费的一轮、对话、项目进回收站（30 天），画布节点与连线走撤销栈，个人资产归档；只有真不可恢复（删供应商、彻底删除、清空回收站、卸载插件）才弹 `ConfirmDialog`，按钮写动作本身。画布维持不加常驻撤销 / 重做按钮（推翻提议、维持 10-13 决定），改为删除后撤销提示 + 右键菜单与画布菜单里的撤销 / 重做（带快捷键）。图片节点工具条改纯图标 + `Hint`：外露局部修改、AI 高清、抠图（本机不支持时换裁剪）、保存到资产、下载，分隔线后「更多」，其余进「更多」与节点右键菜单；局部修改与保存到资产固定外露，中间 5 项按「自定义工具条」的顺序取（默认 AI 高清、抠图、切分、下载、查看）；被遮盖的节点内容区右上保留「显示」，「隐藏」改称遮盖内容。创作台图片 / 视频模式与画布提示词框 `⌘↵ / Ctrl+↵` 生成、Enter 换行，Agent 模式 Enter 发送；输入法组合期间的 Enter 不处理 | 「复杂留给系统」审查 01–05 与顾问意见，飙哥定 D5、D11、U1、U2：可恢复的操作用撤销代替确认；多行提示词里 Enter 误提交会直接发起计费生成。规格见 `.scratch/ux-principles/spec.md` |
