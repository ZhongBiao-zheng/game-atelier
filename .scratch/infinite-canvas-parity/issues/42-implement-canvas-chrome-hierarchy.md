# 42：收口画布顶部状态区与底部工具坞

Type: implement

Status: in-progress

Blocked by: 41-implement-generation-default-preferences

## Goal

关闭固定参考基线 I01：桌面画布把项目与保存状态收在顶部左侧，把资产、提示词、生成偏好、外观和快捷键
收在顶部右侧配置区，把选择、历史、节点创建、上传和适应画布收在底部居中工具坞；继续使用 Atelier
语义 token 与现有功能真源。

## Reference boundary

- 固定参考：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61` 的 runtime screenshots。
- 学习顶部信息/配置与底部操作的空间层级，不复制 Ant Design、白色工具条、品牌色、字体或图标细节。
- 不改变 Canvas Domain、节点/连接、项目 revision、生成调用、Agent/资源面板的状态归属。

## Acceptance

1. 桌面顶部左侧同组展示返回、项目切换/改名与保存状态；顶部右侧同组展示资产库、提示词库、生成偏好、画布外观和快捷键。
2. 桌面底部居中 dock 提供选择、撤销/重做、文本/图片/视频/音频/生成配置创建、上传和适应全部；中等宽度使用紧凑“添加”入口，避免与左下缩放 dock 重叠。
3. 小于 768px 继续使用可达的左侧纵向降级，不压住底部 Inspector/Composer；375px 不产生横向溢出。
4. 添加菜单、Radix 菜单、Dialog 的方向、焦点恢复、Escape 和 aria 状态不退化；资源面板跟随新 chrome 左缘，不保留旧 rail 空位。
5. 768/1024/桌面下顶部区、工具 dock、缩放、小地图和 Inspector 不重叠；safe-area inset 生效。
6. 纯 chrome 重排不修改 Document、undo/redo、项目 revision 或任何偏好 schema。
7. 聚焦测试、源码 TypeScript、设计守卫、production build、真实桌面/中屏/手机和双轴代码审查通过；I01 gap 归零。

## Non-goals

- 不新增节点类型、生成能力、快捷键或后端字段。
- 不逐像素复制参考项目，不改变三栏折叠/调整、节点工具条、独立 composer 或缩放逻辑。
- 不修复既有 Canvas v1 测试债或用户工作树文件。

## Rollback

回滚本票提交即可恢复原左侧纵向 rail；Canvas Document、项目边车、Job/Snapshot 与偏好文件均不变。

## Verification

待完成。
