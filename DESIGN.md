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

生成面板只保留当前素材、提示词、模型参数与操作。禁止追加“原任务输入／本轮冻结输入”等重复模型和提示词的解释区块；历史信息留在现有详情入口，不替换成新的说明卡片。

| 组件 | 配方 |
|---|---|
| Primary 按钮 | `bg-primary text-primary-foreground rounded-md hover:bg-primary/90`（每屏一处） |
| 次要按钮 | `bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80` |
| Outline 按钮 | `border border-border bg-transparent rounded-md hover:bg-accent` |
| 卡片 | `bg-card border border-border rounded-lg` |
| 媒体瓦片 | `rounded-lg overflow-hidden border border-border`（框架隐形，让图说话） |
| 选项弹窗（输入框控件 popover） | 面板 `bg-card border border-border rounded-xl`（**不透明**——内含可选项时玻璃透底会让选项难辨）；选项轨道 `bg-popover`（比面板亮一档）；选项 chip 默认透明贴轨道、左右贴紧（多行只留 `gap-y-1`），`hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60`。层级铁律：**越靠背景越深**，画布 → 输入壳 → 面板 → 轨道 → 选中/hover 单调变亮 |
| 控件下拉面板限高 | `ToolbarPopover` 把定位算出的可用高度写在内联 style 上，会盖过 className 里的 `max-h-*`；要限高传 `maxHeight` prop（厂商 / 模型列表 400，生成模式 280） |
| 玻璃浮层（无选项的悬浮 panel/菜单） | `bg-glass backdrop-blur-glass border border-border rounded-xl` |
| Studio 输入壳（滚动联动收放） | 浮于历史滚动区上（wrapper `pointer-events-none`，壳 `pointer-events-auto`，两侧视觉与交互都穿透）；`rounded-xl` 收放两态一致（胶囊 `rounded-full` 试装后被否——过圆），展开 `min-h-[174px]`，距底 >160px 收成单行条：控件行 `grid-rows-[0fr] opacity-0` 折叠、textarea 单行、参考堆叠 `scale-80`，全程 `transition 300ms`；点击收缩壳展开但**不回滚**，「回到底部」独立玻璃 pill 出现在壳右上方，点击**瞬时跳底**不播滚动过程 |
| Studio 生成记录 | 单列，一条记录上下三段，列表上限 1024px：① 信息：提示词一行（参考图在提示词左侧，多张时向右展开）+ 参数标签行 ② 结果 ③ 操作行。标签行与操作行始终从最左缘开始，有没有参考图都一样。参数标签实底 `rounded-sm bg-card px-2 py-0.5 text-xs`，来源是同一行里的描边标签，MJ flags 另起一行等宽灰字。操作按钮 `h-8 px-2 text-xs` 无底色、宽度随文字，整行 `-ml-2` 让文字贴左缘，上方不加分隔线；耗时 · 时分 · 费用等宽靠右。日期由分组标题承担（按北京日期分组，每组第一条上方一行 `text-xs tabular-nums`）。更多菜单向右弹。**两栏（结果左 / 信息右）试过后撤回**：右栏只有 20rem，参考图一多 hover 展开放不下 |
| 玻璃 pill（顶栏 tab） | `bg-glass backdrop-blur-glass border border-border rounded-full` |
| 顶栏圆形 icon 钮（主题切换 / 设置） | `h-10 w-10 rounded-full bg-glass backdrop-blur-glass text-muted-foreground hover:bg-secondary/60 hover:text-foreground`，icon 18px |
| 遮罩层（lightbox） | `fixed inset-0 z-50 bg-scrim` |
| 状态徽章 | `text-xs` + `text-[color:var(--status-*)]`（同字号靠颜色分语义） |
| 输入框 | `border border-input bg-transparent rounded-md focus-visible:ring-1 focus-visible:ring-ring` |
| 原生下拉 `<select>` | 外观由 `tokens.css` 的 base 规则统一（去系统箭头、`--select-chevron` 发丝箭头、右内边距 2rem）；tsx 只写与输入框相同的边框 / 圆角 / 高度类，不再各自画箭头 |
| 控制台 | 左侧 220px 分组导航，组距 18px、组名 `text-xs text-subtle-foreground`；选中行 `bg-popover` + 24px 主色图标块，未选中中性灰。右侧 `.console-panel m-2 rounded-2xl border border-border bg-panel`，面包屑替代独立大标题。小于 768px 导航置顶横向滚动、隐藏组名。 |
| 用量卡片 | `bg-card rounded-xl border border-border`；KPI `text-base font-semibold`；范围选中用主色，其他筛选用 secondary；类型胶囊用 brand，排行圆点和条用固定 chart 色并带文字标签；历史柱主色 30%，当前桶实色，空日 2px 边线色，三条虚线网格。 |
| 网关状态卡 | 状态点、标题与运行胶囊、模型/在用成员/月花费摘要、地址复制、开关同排并允许窄屏换行；新建密钥主按钮；额度条正常主色、超过 85% 用运行警告色；任务前置类型胶囊，计时主色。 |
| 外观设置 | 模式分段、44px 四色色卡、四项原生取色器与 hex 草稿、恢复默认、迷你控制台预览；修改即应用，主色对卡片低于 3:1 提示，不阻止应用。 |
| 小帽标签 | 拉丁 `text-xs uppercase tracking-label text-muted-foreground`；中文 `text-xs text-muted-foreground` |
| 空状态 | `font-display text-display italic text-foreground/70` + 一行 `text-sm text-muted-foreground` 说明 |
| 无限画布 chrome | React Flow 只占平面层；项目切换、工具条、MiniMap 与节点设置统一使用 `bg-glass backdrop-blur-glass border border-border`，节点本体用 `bg-card border-border rounded-lg`。素材名固定显示在节点左上方；节点选中后，功能工具条固定出现在节点上方，完整图片快捷工具不再按节点宽度折叠。空图片/视频/音频只在上方工具条保留一个上传入口，节点正文不重复放上传按钮；自身取得当前 Content Version 后恢复完整工具。空文本从创建起即持有真实的空 Content Version，必须保留输出连接点、出现在下游素材条与 `@` 候选中，允许先建立 Input Connection 再填写内容。选中框四边与缩放手柄均向节点外扩 1px，避免描边压住内容边缘。768px 起生成设置作为节点下方独立浮层。选中节点在渲染时临时提升到全部持久化节点之上，保证工具条与生成面板不会被其他节点遮盖，但不改写项目内 `z_index`。当前 Content Version 来源为 `upload` 的图片是纯素材节点：选中后不挂载桌面或移动端生成设置，只显示上方工具条，不额外显示替换动作。视频画面单击只选择节点并阻止浏览器切换播放状态；播放/暂停、进度、音量与全屏由节点内确定性的自有控制条操作，不猜测浏览器原生控制条几何。图片多结果在节点卡片展开，生成设置不重复预览。视频不使用候选堆叠或主结果切换，生成结果直接成为独立节点。批量执行按项与轮纵向展开普通节点链路，各行只连接本批上游；保留现有节点样式，不添加结果容器。生成设置的提示词上方使用 48px 素材缩略条展示当前 Input Connection，图片与视频分别显示图片和视频首帧；文本连接到全能参考视频时同步补入对应 `@` token，断开连接时同步移除，若只剩引用则提示词回到空字符串；其他素材连接不自动改写提示词。进入画布选材后，合法素材 hover 时点亮边框，“选择 + 节点名”以固定屏幕尺寸跟随光标；键盘聚焦时提示显示在节点起始位置。已对接素材和提示词内的 `@` token 在 hover 或键盘聚焦时复用同一固定屏幕尺寸详情，图片放大预览、视频静音循环预览、文本/音频显示摘要。两块跟随浮层都反向补偿画布缩放，保持固定屏幕尺寸，并允许随节点移出视口而被自然裁切，不做翻边或边缘钳位。文本生成设置标题只显示“文本”，提供 1–4 个结果；第一个覆盖原节点，第二个放右侧，第三个放左下，第四个放右下，新增结果均为携带相同 Draft 与输入连接的独立文本节点。文本模型可理解的图片、视频和音频先由 KEY 中的显式能力开关决定，caller 再核对当前供应商协议是否有对应传输格式；不支持时只在提交时给一条短消息，不增加常驻说明。所有模态的生成面板底部只保留生成动作，不渲染完成状态、配置状态或阻塞原因；按钮仅在提交过程中禁用，配置问题在点击后统一由画布中上方反馈，失败后按当前设置整批重新提交。生成中节点使用旋转与呼吸组合的动态指示，并尊重 `prefers-reduced-motion`；生成记录只展示解析后的用户内容，内部冻结模板的 `【文本N】` 编号不得暴露，但不得改写真实请求快照。375px 下生成设置降级为带 safe-area 的底部面板；MiniMap 与缩放 Controls 不占手机底部空间。触控板双指平移、捏合缩放，画布在 capture 阶段接管横向非 pinch wheel 并禁用 overscroll history navigation，避免手势起于 `nowheel` 节点或浮层时触发浏览器前进/后退；鼠标左键拖框选择，触屏单指平移、双指缩放。LLM 生成合并进文本节点，人工正文与生成结果共用同一 Content Version 表面；Chat Completions 显示随机性和最大输出长度，Responses 显示推理强度和最大输出长度。菜单打开后焦点进入首项，Esc 逐层关闭并回到触发器或画布。媒体双击或预览按钮进入有焦点陷阱的 Dialog。节点列表必须启用可见区域渲染、稳定对象 memo，图片原生 lazy，视频/音频接近视区后才绑定 `src` |

模型菜单的耗时与价格、Studio 历史参数共用 `MetaTag` 实底标签。耗时按 10 秒向上取整并只显示秒，全站金额共用同一格式：最多两位小数、去末尾零、`¥` 后置且无空格。历史参数逐项点击复用，能力判断沿用当前模型能力表；禁用时无 hover 态并设 `aria-disabled`；模型失效提示「该模型已不可用」，模式不匹配提示切换到对应模式，其余能力不支持提示「当前模型不支持」。模型标签和当前模型按钮使用同源品牌图标，供应商图标按预设身份统一，全部单色并跟随文字色；位图去背景后作为遮罩，最大64px，资源随应用打包。

### 画布图片表面例外

图片节点工具条提供「标注」入口，进入后在节点下方 12px 显示一条浮动工具栏，替换常规节点工具。
顺序为选择/框选/箭头/画笔/文字、五色点和尺寸浮层、撤回/重做/删除/展开、去改图。
工具按钮 36px，当前工具反白；工具栏采用玻璃表面，无第二行参数、侧栏或补充提示词框。
线宽与字号入口显示名称和当前数值，提供三档预设和滑杆；图形完成后保持当前工具并选中新图形；任何工具下指到已有标注（框按描边、文字按范围、箭头与画笔按路径）光标变为移动，按住即拖动，空白处照常绘制；指到标注时滚轮或双指滚动调整其线宽（文字调字号），停手后记一次撤回，双指捏合仍缩放画布；矩形可拖动四角独立调整宽高；箭头显示两端控制点，拖动任一端调整方向和长度，保持线宽。
文字输入时不显示边框，结束后选中才显示四角缩放控件，缩放同步改变字号；文字默认深色描边，可开启同色实心底。绘图颜色属于用户内容。
标注期间收起节点生成面板，退出后恢复原草稿，避免与标注工具栏重叠。
节点右上常显「标注 N」胶囊控制显隐；编辑外圈为主题主色描边。指针不在标注上时，滚轮与空格平移沿用画布行为。工具、颜色与尺寸偏好在所有节点间共用。
全屏使用不透明背景、顶部收起与尺寸、底部同一工具栏，复用编辑状态；Esc 返回就地态。
标注自动保存，每个完整动作参与画布撤回。带标注连线使用主题主色与画笔徽标，素材芯片预览合成图并标记画笔。

节点顶部工具栏不提供删除、存资产、复制提示词、反推提示词、替换和局部编辑，图片快捷工具配置也不列出这些项；已上传图片不再额外显示替换按钮。空媒体节点仍保留唯一上传入口，分组保留“解散”。这只收敛节点入口，不删除资产或处理历史。

图片“更多”菜单提供“扩图”和“局部修改”，共用视口内的编辑浮层，不增加顶部按钮。通用编辑以源图/目标画框尺寸为准，不使用 AUTO；选区撤销仅在编辑器内部。原图不覆盖，结果可按住对比。MJ 原生模式只显示原任务实际开放的动作，不承诺与通用编辑相同的像素保护。

取得图片 Content Version 的图片节点及图片候选卡片不铺底色，透明像素直接透出画布；堆叠候选的装饰卡片也不铺底色。空节点、非图片节点与状态提示保留原有可读性背景。左栏不显示撤销、重做按钮；保留撤销/重做快捷键。

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
