# 12：实现项目资产库与本地提示词库

Type: implement

Status: ready-for-human

Blocked by: 05-resolve-project-assets-prompts-sync, 11-implement-project-package-lifecycle

## Goal

让当前 Canvas Project 内已经登记的 Content Version 能被收藏、搜索、编辑元数据并再次插入画布；
让用户能维护项目本地提示词，并以不可变 Text Content Version 插入画布。两类 sidecar 都必须使用独立
revision 和 `If-Match`，不得把创作库状态塞进热路径 `canvas.json`。

## Included

- 当前项目资产库的读取、保存、去重、重命名、标签、移出与插入。
- 当前项目本地提示词的读取、创建、编辑、标签、删除与插入。
- 编辑器左侧独立创作库面板、搜索、点击插入、拖拽到指定画布坐标。
- 节点悬浮工具条和 Inspector 的“存入资产库”入口。
- 资产条目复用同项目 Content Version；提示词插入创建新的 Text Content Version。
- sidecar/document revision 冲突显式返回 409。

## Excluded

- 跨画布、创作台或工坊 transfer copy。
- 公共提示词源抓取与缓存。
- WebDAV、发布到工坊、直接上传到资产库。
- 资产内容替换与项目级物理去重。

## Exit gate

- 真实领域层与 HTTP 冒烟覆盖资产/提示词 CRUD、重复收藏、插入和 revision 冲突。
- 前端类型检查不新增源代码错误，设计漂移检查、生产构建通过。
- 浏览器中可从节点收藏内容，并通过按钮或拖拽从项目创作库插回画布。
