# 组件规范 — game-atelier

> 页面只组合 `web/src/components/ui/` 的组件。视觉 token 与配方见 [DESIGN.md](../../DESIGN.md)，具体界面见 [界面规格](surfaces.md)。
> 由 `web/src/test/nativeControlsGuard.test.ts` 守卫强制执行。

## 选用

| 需求 | 组件 | 说明 |
|---|---|---|
| 单行文字、数字、URL、颜色 | `Input` | 自带关闭浏览器与密码管理器自动填充 |
| API 密钥、令牌等敏感值 | `SecretInput` | 文本框 + 遮挡，`revealed` 控制明文；禁用 `type="password"` |
| 多行文字 | `Textarea` | 同 `Input`，自带关闭自动填充 |
| 下拉选择 | `Select` | 原生 select，箭头由 `tokens.css` 统一 |
| 多选 | `Checkbox` | 开关语义（立即生效的启用 / 停用）用 `Switch` |
| 单选 | `Radio` | 选项 ≤ 4 且需要并排比较时用；否则用 `Select` |
| 数值拖动 | `Slider` | 原生 range |
| 选文件 | `FileInput` | 隐藏，由按钮或拖放区 `ref.click()` 触发 |
| 按钮 | `Button` | `variant`：default / secondary / outline / ghost / destructive / link；`size`：default / sm / lg / icon |
| 弹窗 | `Dialog` | 确认类用 `ConfirmDialog` |
| 菜单 | `DropdownMenu` | |
| 标签 | `Badge` / `MetaTag` | 参数标签用 `MetaTag` |

缺组件时先在 `components/ui/` 补齐再用，不在页面里写原生控件。

## 规则

- **`<form>` 一律 `autoComplete="off"`**：本工具没有登录表单，浏览器保存密码的弹窗都是误判。
- **`variant="bare"` 只给特殊表面**：画布内联编辑、提示词输入壳、标注文字等外观完全自定的位置。普通表单用默认配方，不传 `className` 改边框、圆角、高度。
- **存量债务走棘轮**：原生 `<button>`、`variant="bare"`、任意值间距（`p-[…]`、`gap-[…]` 等）只许减少。改动让数量下降时，把守卫里的基线改成新数值。

## 新增组件

1. 文件放 `web/src/components/ui/<kebab-name>.tsx`，`React.forwardRef` + `cn(默认配方, className)`。
2. 文字类输入展开 `NO_AUTOFILL`（`ui/input.tsx` 导出）。
3. 在本页「选用」表登记一行。
