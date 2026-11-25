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
| 分段切换（视图、模式） | `ToggleGroup` + `ToggleGroupItem` | `type="single"` 再点已选项得到空值，调用方忽略空值以保持必选；`sliding` 让选中底色滑动（选项自带选中外观的组不开） |
| 单个按下 / 弹起 | `Toggle` | |
| 弹层里的紧凑参数（尺寸、档位、时长、开关） | `Segmented` + `SegmentedItem` | ToggleGroup 单选 + 滑动底色；选中态写在各项的 `selected` 上 |
| 内容分页 | `Tabs` + `TabsList` / `TabsTrigger` / `TabsContent` | 文字下划线页签给 List 与 Trigger 传 `variant="line"`；选中底色 / 下划线自带滑动，选中不改字重 |
| 单选组的选中底色 | `SelectionHighlight` | 放进 `relative isolate` 的组容器，跟随 `aria-selected / pressed / checked / current` 的子项滑动；Segmented、Tabs、ToggleGroup sliding 已内置 |
| 数值拖动 | `Slider` | 刻度数字用 `SliderMarks`（与滑钮中心对齐、当前值高亮） |
| 数字步进（带单位与上下箭头） | `NumberInput` | 方向键 / 箭头按 step 增减，回车或失焦夹到 [min, max]；常与 `Slider` 并排联动 |
| 选文件 | `FileInput` | 隐藏，由按钮或拖放区 `ref.click()` 触发 |
| 按钮 | `Button` | `variant`：default / secondary / outline / ghost / destructive / link / solid；`size`：default / sm / lg / icon |
| 图标 | `ui/icons` 的语义图标（`CloseIcon`…） | `size`：sm / md / lg / xl；新图标先在注册表登记，规则见 DESIGN.md「图标」 |
| 文字标签 | `Label` | 页面不写原生 `<label>` |
| 悬停提示 | `Hint`（`ui/tooltip.tsx`） | 替代原生 `title`；测试里用 `test/hint.ts` 的 `hoverHint` |
| 弹窗 | `Dialog` | 确认类用 `ConfirmDialog`（基于 `AlertDialog`，`confirmText` 必填、写动作本身）；一律受控 `open`，内容读 `useRetained` 缓存的最后一份，带表单状态的用 `useRetainedSession` 的会话号作 key（`ui/retained.ts`）；有未保存输入时给 `DialogContent` 传 `dirty`：点外面不关，Esc 与右上角关闭先问「放弃未保存的修改？」 |
| 浮层 | `Popover` | 控件 chip 的下拉面板用 `studio/ToolbarPopover`（基于 Popover，锚点移动时逐帧跟随） |
| 通知提示 | `notify`（`lib/notify.ts`） | 全站只有 AppShell 挂的一个 `Toaster`（右上角顶栏下方）；页面只调 `notify.error / undo / info`，不直接调 `toast`。异常转文案用 `errorText(e)`（`lib/errorText.ts`），失败任务用 `presentJobError`（`lib/errorPresentation.ts`） |
| 看大图 | `Lightbox` | 可选动作 `onDownload` / `onUseAsReference` / `onCopyPrompt` / `onDelete`（⌫），不传不显示 |
| 菜单 | `DropdownMenu` | |
| 标签 | `Badge` / `MetaTag` | 参数标签用 `MetaTag` |
| 展开收起 | `Collapse` | 高度 0↔auto，收起播完再卸载，中途反向从当前高度接上；`appear` 挂载即展开（新到的报错条）；`keepMounted` 收起后留在 DOM 里 |
| 折叠区（替代原生 `<details>`） | `Disclosure` | 标题行是带 `aria-expanded` 的按钮，内容走 `Collapse keepMounted`；受控传 `open` + `onOpenChange`，非受控传 `defaultOpen` |
| 滚动区上下渐隐 | `.scroll-fade-y` + `useScrollFade`（`ui/scroll-fade.ts`） | 回调 ref 挂到滚动容器上，渐隐宽度随滚动连续变化 |
| 表单校验失败定位 | `revealInvalidField`（`ui/invalid-field.ts`） | 首个 `aria-invalid` 字段不在可见区时平滑滚入，再聚焦并微抖 |
| 图标换态 | `SwapIcon` | `swapKey` 变化时新图标淡入放大；`variant="pop"` 只给喜欢、复制成功等正向确认 |
| 按钮文案换态 | `SwapLabel` | 两段文案叠格占宽，切换时按钮不跳 |
| 图片出现 | `RevealImage` | 解码完成再淡入，已缓存的不播；`onReady` 供父级交叉淡化后卸掉旧层 |

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

`Button variant="solid"`：无边框主色胶囊，只用于瓦片上的悬浮操作。

`SelectTrigger variant="inline"`：表格文字原位编辑；箭头在行 hover、键盘聚焦或触屏时显示。
