# Design System — game-atelier

> 永远先读这份文档再做任何视觉 / UI 决定。
> 字体、颜色、间距、美学方向都在这里定义。
> 改动需明确同意，QA 模式要标记不符合本文档的代码。

---

## Product Context

- **What this is**: 游戏角色资产工作流 —— 画师 / 设计师可视化管理角色档案与 AI 出图的本地工具
- **Who it's for**: 主理人（开发者本人）+ 1-2 位合作画师
- **Space/industry**: 创意 / 游戏美术 / AI 辅助设计
- **Project type**: 本地桌面级 web 工具（不是 SaaS dashboard）

## Aesthetic Direction — "Atelier"（工坊 / 画廊）

- **Direction**: Editorial / Gallery — 暗色画廊为主，serif 点缀
- **Decoration level**: Minimal —— 排版 + 暖调做活，不堆装饰
- **Mood**: 安静、温暖、有匠气；让 AI 生成的角色艺术做主角；像 Procreate / ArtStation / 摄影画册，不像 Linear / Notion / SaaS dashboard
- **Memorable thing**: 一间安静的暖色画廊，每张图都有呼吸的空间

## Typography

- **Display / Hero**: **Instrument Serif** — 板块大标题、角色名、空状态主文案；衬线让这个工具显得是"创意软件"而非"通用工具"
- **Body / UI**: **Geist** — 所有按钮、标签、表单、正文；现代无衬线，可读性极高
- **Data / Tables**: **Geist** with `tabular-nums` — 数字对齐
- **Code / Technical**: **JetBrains Mono** — job_id、文件路径、seed、URL、命令片段
- **Loading**: 通过 `bunny.net` 自托管，避免 Google Fonts CORS（备选 Google Fonts CDN）

**Scale**（以 14px 基准）：
| Token | Size | Usage |
|---|---|---|
| `text-xs` | 12px | 元数据、tag、状态标签 |
| `text-sm` | 14px | 主 UI 文本（按钮、标签） |
| `text-base` | 16px | 正文 |
| `text-lg` | 18px | 卡片标题 |
| `text-xl` | 20px | 子板块标题 |
| `text-2xl` | 24px | 板块标题（serif） |
| `text-3xl` | 30px | 页面 hero（serif） |

**Font-weight 策略**：
- Geist：400（正文）/ 500（按钮、强调）/ 600（小标题）
- Instrument Serif：400 only（衬线粗体会失去优雅）
- JetBrains Mono：400 / 500

## Color — Warm Atelier Palette

**方法**：restrained — 单一强调色（aged brass / 黄铜）+ 暖中性色

| Token | Hex | Usage |
|---|---|---|
| `--background` | `#0F0E0D` | 主背景（暖黑，R略>B） |
| `--foreground` | `#EDEAE3` | 主文本（暖白） |
| `--card` | `#1B1917` | 卡片、面板、左栏 |
| `--card-foreground` | `#EDEAE3` | 卡片内文本 |
| `--popover` | `#1B1917` | 弹出层 |
| `--popover-foreground` | `#EDEAE3` | 弹出层文本 |
| `--primary` | `#D4A574` | 黄铜 —— 主按钮、聚焦、链接、激活态 |
| `--primary-foreground` | `#1B1917` | 黄铜按钮上的文字（深色） |
| `--secondary` | `#2A2725` | 次要按钮、hover 背景 |
| `--secondary-foreground` | `#EDEAE3` | 次要按钮文字 |
| `--muted` | `#1B1917` | 不重要的区域背景 |
| `--muted-foreground` | `#94908B` | 元数据、placeholder、辅助文字 |
| `--accent` | `#2A2725` | hover 高亮 |
| `--accent-foreground` | `#EDEAE3` | accent 上的文字 |
| `--destructive` | `#C95C5C` | 删除、错误（暖红，less aggressive than ramp red） |
| `--destructive-foreground` | `#FFFFFF` | 删除按钮文字 |
| `--border` | `#2A2725` | 低对比度边框 |
| `--input` | `#2A2725` | 输入框边框 |
| `--ring` | `#D4A574` | 聚焦环（黄铜） |

**Status colors**（任务状态语义色，暖调对齐）：

| Token | Hex | Usage |
|---|---|---|
| `--status-pending` | `#6B6967` | 等待中 |
| `--status-running` | `#E5B570` | 进行中（暖琥珀，跟 primary 同族不抢戏） |
| `--status-done` | `#7FB069` | 完成（鼠尾草绿，比霓虹绿温和） |
| `--status-failed` | `#C95C5C` | 失败（暖红，跟 destructive 一致） |

**对比度验证**（WCAG AA 4.5:1 normal text）：
- `#EDEAE3` on `#0F0E0D` ≈ 16:1 ✓
- `#94908B` on `#0F0E0D` ≈ 5.5:1 ✓
- `#D4A574` on `#0F0E0D` ≈ 9:1 ✓
- `#1B1917` on `#D4A574` ≈ 7:1 ✓（primary 按钮）

**dark mode 策略**：项目无 light mode；dark-first，所有视觉都按暗色调校。

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
  - 左栏：固定 280px（项目/角色树）
  - 中栏：fluid（gallery）
  - 右栏（可选）：固定 360px（spec form / image detail）
- **Max content width**: 无硬上限（gallery 需要充满）；详情页内文限 720px
- **Border radius**（hierarchical）:
  | Token | px | 用途 |
  |---|---|---|
  | `rounded-sm` | 4 | 小标签、tag |
  | `rounded-md` | 6 | 按钮、输入框 |
  | `rounded-lg` | 8 | 卡片、图片框、面板（默认） |
  | `rounded-xl` | 12 | hero 卡片 |
  | `rounded-full` | 9999 | 删除按钮、avatar |

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

1. **空状态用 serif** —— "请在左栏选择角色" 这样的空状态文案用 Instrument Serif，瞬间让工具变画廊
2. **角色名用 serif** —— 详情页 / 卡片顶部的角色名也用衬线，加深"作品集"质感
3. **黄铜聚焦环** —— focus state 用 `ring-2 ring-primary`，配合 #D4A574 是这个工具最独特的视觉签名
4. **图片框无边框（仅 1px border）** —— 让图本身说话，框架尽量隐形
5. **mono 字体处理 job_id / 路径** —— 技术细节用 mono，跟主 UI 文字形成清晰对比

## 反 AI Slop 清单（绝不出现在本项目）

- ❌ 紫色 / 蓝紫渐变（最 SaaS 的 cliché）
- ❌ 3 列 feature grid + 彩色圆圈图标
- ❌ 居中一切、统一 bubble border-radius
- ❌ Inter / Roboto / Arial 作为正文字体
- ❌ system-ui 作为 display 字体（"我放弃了排版"信号）
- ❌ 渐变按钮（用纯色）
- ❌ "Built for X" 营销文案

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-18 | 创建初版 Atelier 设计系统 | 由 `/design-consultation` 在 Tailwind v4 + shadcn 迁移完成后生成。画师 = 创意用户，工具应有创意软件氛围而非 SaaS 通用感。 |
| 2026-05-18 | 用 Instrument Serif 做 display | 内部工具几乎都用 sans-serif，serif 让这个工具显得是"创意软件" |
| 2026-05-18 | primary 换 #D4A574 黄铜（替换 #3B82F6 蓝） | 通用蓝过于 generic；黄铜暖、独特、暗示"工艺/贵重" |
| 2026-05-18 | background 由 #0F0F0F 偏到 #0F0E0D 暖黑 | R略大于B，整体气质从"电子屏幕"偏向"画廊空间" |
