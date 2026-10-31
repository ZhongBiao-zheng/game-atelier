# 组件规范 — game-atelier

> 页面只组合 `web/src/components/ui/` 的组件。视觉 token 与配方见 [DESIGN.md](../../DESIGN.md)，具体界面见 [界面规格](surfaces.md)。
> 由 `web/src/test/nativeControlsGuard.test.ts` 守卫强制执行。

## 选用

| 需求 | 组件 | 说明 |
|---|---|---|
| 单行文字、数字、URL、颜色 | `Input` | 自带关闭浏览器与密码管理器自动填充 |
| 带图标、单位、按钮前后缀的输入框 | `InputGroup` + `InputGroupAddon` + `InputGroupInput` | 焦点环与错误态画在外框上 |
| API 密钥、令牌等敏感值 | `SecretInput` | 文本框 + 遮挡，`revealed` 控制明文；禁用 `type="password"` |
| 多行文字 | `Textarea` | 同 `Input`，自带关闭自动填充 |
| 标题就地重命名 | `EditableText` | 单击进入编辑，Enter / 失焦保存，Esc 取消；切应用造成的失焦不算结束 |
| 下拉选择 | `Select` + `SelectTrigger` / `SelectContent` / `SelectItem` | Radix Select；测试里用 `test/select.ts` 打开 |
| 多选 | `Checkbox` | 开关语义（立即生效的启用 / 停用）用 `Switch` |
| 单选 | `RadioGroup` + `RadioGroupItem` | 选项 ≤ 4 且需要并排比较时用；否则用 `Select` |
| 分段切换（视图、模式） | `ToggleGroup` + `ToggleGroupItem` | `type="single"` 再点已选项得到空值，调用方忽略空值以保持必选 |
| 单个按下 / 弹起 | `Toggle` | |
| 弹层里的紧凑参数（尺寸、档位、时长、开关） | `Segmented` + `SegmentedItem` | ToggleGroup 单选 + 滑动底色；选中态写在各项的 `selected` 上 |
| 内容分页 | `Tabs` + `TabsList` / `TabsTrigger` / `TabsContent` | |
| 数值拖动 | `Slider` | |
| 选文件 | `FileInput` | 隐藏，由按钮或拖放区 `ref.click()` 触发 |
| 按钮 | `Button` | `variant`：default / secondary / outline / ghost / destructive / link；`size`：default / sm / lg / icon |
| 文字标签 | `Label` | 页面不写原生 `<label>` |
| 悬停提示 | `Hint`（`ui/tooltip.tsx`） | 替代原生 `title`；测试里用 `test/hint.ts` 的 `hoverHint` |
| 弹窗 | `Dialog` | 确认类用 `ConfirmDialog`（基于 `AlertDialog`） |
| 浮层 | `Popover` | 控件 chip 的下拉面板用 `studio/ToolbarPopover`（基于 Popover，锚点移动时逐帧跟随） |
| 通知提示 | `Toaster` + `toast`（`ui/sonner.tsx`） | 需要独立一组时给 `Toaster` 传 `id`，`toast` 里用 `toasterId` |
| 菜单 | `DropdownMenu` | |
| 标签 | `Badge` / `MetaTag` | 参数标签用 `MetaTag` |

缺组件时先在 `components/ui/` 补齐再用，不在页面里写原生控件。

## 规则

- **`<form>` 一律 `autoComplete="off"`**：本工具没有登录表单，浏览器保存密码的弹窗都是误判。
- **`variant="bare"` 只给特殊表面**：画布内联编辑、提示词输入壳、标注文字等外观完全自定的位置。普通表单用默认配方，不传 `className` 改边框、圆角、高度。
- **页面禁写原生 `input` / `textarea` / `select` / `button` / `label` 与 `title` 属性**：焦点环、防自动填充、提示外观由 ui 组件统一。
- **间距只用刻度**：不写 `p-[…]`、`gap-[…]` 等任意值；v4 刻度支持小数（`pt-3.5` = 14px、`gap-4.5` = 18px）。
- **`variant="bare"` 走棘轮**：存量只许减少。改动让数量下降时，把守卫里的基线改成新数值。

## 新增组件

1. 文件放 `web/src/components/ui/<kebab-name>.tsx`，`React.forwardRef` + `cn(默认配方, className)`。
2. 文字类输入展开 `NO_AUTOFILL`（`ui/input.tsx` 导出）；可聚焦控件用 `ui/focus.ts` 的 `FOCUS_RING` / `INVALID_RING`。
3. 在本页「选用」表登记一行。
