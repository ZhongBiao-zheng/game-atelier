# 主题色规范

2026-10-24 定稿；使用规则见 [DESIGN.md](../../DESIGN.md)。所有 hex 为暗色原始值。

## 固定石墨表面

| Token | 值 |
|---|---|
| background | #0A0A0B |
| panel | #111113 |
| card / muted | #18181B |
| popover | #1C1C1F |
| secondary / accent | #26262A |
| foreground | #EDEDEF |
| muted-foreground | #8E8E93 |
| subtle-foreground | #5C5C61 |
| border / input | rgba(255,255,255,0.08) / rgba(255,255,255,0.14) |
| glass / scrim | rgba(17,17,19,0.66) / rgba(0,0,0,0.62) |
| hairline-inset / nav-ring-stroke | rgba(255,255,255,0.12) / rgba(255,255,255,0.45) |

## 七套主题色组

| 名称 | 主色 | 副色 1 | 副色 2 | 副色 3 |
|---|---|---|---|---|
| **青柠（默认）** | #D4F53C | #6FD6F0 | #F5D06A | #A99FF5 |
| 电光紫 | #A98BFF | #7DD3FC | #FCD34D | #F9A8D4 |
| 信号橙 | #FF6B2C | #7DD3FC | #FCD34D | #C4B5FD |
| 冰川青 | #3EE6D0 | #A78BFA | #FCD34D | #FDA4AF |
| 珊瑚粉 | #FF5C8A | #C4B5FD | #FCD34D | #86EFAC |
| 柠檬黄 | #FFD23F | #93C5FD | #FDBA74 | #F9A8D4 |
| 钴蓝 | #6F8BFF | #67E8F9 | #FDBA74 | #F9A8D4 |

主色对应 primary / ring，副色 1–3 对应 brand-2/3/4。主色字在 #0A0A0B 和 #FFFFFF 之间取对比度更高者。冰蓝未形成完整色组，不作为预设；不提供黄铜预设。

## 固定数据色与状态色

| Token | 暗色 | 用法 |
|---|---|---|
| chart-1 | #6FD6F0 | 冰青 |
| chart-2 | #F58FBD | 糖果粉 |
| chart-3 | #CDEB4A | 青柠 |
| chart-4 | #A99FF5 | 薰衣草紫 |
| chart-5 | #F5D06A | 奶油黄 |
| status-pending | #5C5C61 | 等待 |
| status-running | #F2A33A | 运行、额度警告 |
| status-done | #52AB69 | 完成 |
| status-failed / destructive | #E5534B | 失败、错误 |

排行每张卡独立按行序分配五色，色块必须配文字标签。类型标签跟随主题副色：图片 brand-2、视频 brand-3、文本 brand-4；与固定数据色分开。

## 浅色派生与存储

浅色背景仍为 #FFFFFF，卡片 #FAFAFA，popover #FFFFFF，secondary/accent #F0F0F0，muted #F5F5F5；文字 #000000 / #595959，subtle #707075。主色和三个副色在 OKLCH 中设置 L=0.5，保持 C/h；固定数据色设置 L=0.55。主副色与数据色均需对白底达到 3:1。

浅色状态沿用固定值：pending #767676、running #A3742D、done #4F7C3E、failed/destructive #B04A4A。这些值只随明暗变化，不随主题预设变化。

localStorage `atelier:accent` 保存 `{"preset":"lime"}` 或 `{"custom":{"primary":"#…","brand2":"#…","brand3":"#…","brand4":"#…"}}`，坏值回落青柠。浅色派生不存储。`atelier:theme` 保存 dark / light / system；未设置为 dark。

主色派生：上涨胶囊底 14%、历史趋势柱 30%、控制台右上径向光晕 6%。全部写在 tokens.css 中。
