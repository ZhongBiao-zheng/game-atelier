# 29：补齐节点跟随式悬浮工具条

Type: implement

Status: completed

Blocked by: 28-implement-directed-connections

## Goal

补齐 C12/I04：参考项目的节点动作必须位于节点上方的独立浮层，并随节点移动；标题行只承载节点类型、
标题与重命名，不再混入操作按钮。

## Included

- 文本、图片、视频、音频、配置、分组、插件七类节点共用一个 Atelier 玻璃浮层容器。
- 浮层在节点 hover、focus-within 或 selected 时显示，节点到浮层之间保持可移动的命中走廊，不闪退。
- 所有节点提供详情/选中与删除；有内容节点按能力提供存入资产库、预览、下载、复制提示词、替换与视频编辑。
- 图片继续遵循用户保存的快捷工具顺序、标签与窄节点折叠偏好。
- 空图片/视频/音频节点提供同类型上传入口，上传后直接填充原节点并保留不可变版本历史。
- 操作按钮具备中文 aria-label、tooltip、键盘焦点与禁用态；窄节点/小视口不产生页面横向溢出。

## Excluded

- 节点运行状态与错误重试（C14/C15）、生成面板重构（D01/I05）、右键菜单、批量工具条。

## Exit gate

- 标题行内不存在操作按钮；七类节点均有独立、跟随式上方工具条。
- selected 状态不依赖鼠标 hover 也可见；鼠标从节点移入工具条不闪退，键盘可访问全部动作。
- 空媒体上传、已有媒体替换、删除、预览与图片偏好均不回归；连接柄、拖动、重命名与下方生成面板不受影响。
- 375/768/桌面及 React Flow 既有 8%–250% 缩放实机无横向溢出或遮挡主操作。
- 前后端定向测试、源码类型、Ruff、设计守卫、生产 dist、全量基线、差异检查与代码审查通过；
  不修改旧测试源。

## Verification

- 七类节点统一使用 React Flow `NodeToolbar`：标题行仅保留类型、标题与重命名，工具条在
  hover、selected、focus-within 及图片菜单/设置 Portal 打开期间持续挂载。
- 工具条采用 roving tabindex，可用方向键、Home/End 导航；在 8%、适应画布与 250% 缩放下
  保持 102 × 38 px 屏幕尺寸，并在左右 16 px 边界钳位、顶部空间不足时翻转到节点下方。
- 375、768 与桌面视口实机无页面横向溢出；鼠标从节点进入工具条、再进入 Portal 菜单均不闪退。
- 空图片/视频/音频节点可上传同类媒体并原位填充；跨类型上传零写入。后端定向测试 2/2、
  前端工具条测试 3/3、设计守卫 8/8、Ruff 与 `git diff --check` 通过。
- 全量 Python 基线为 13 failed、943 passed、3 skipped；全量 Web 基线为 4 failed files、
  39 passed files、22 failed tests、388 passed tests、13 errors。失败均为范围外既有 Canvas v1、
  keys 与 CLI 漂移；`pnpm lint` 也只保留同一批旧 Canvas v1 测试类型错误。
- Vite 生产构建与 dist 归一化通过；Standards Review 与 Spec Review 的 P1/P2/P3 均清零。
