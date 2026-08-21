# 01：项目索引与统一媒体读取模型

Type: feature

Status: done

Blocked by: none

## Scope

- 定义并同步 Pydantic / TypeScript / API 文档中的 ProjectIndexItem 与 GalleryMedia 判别联合类型。
- 新增项目索引聚合接口：四张最新未隐藏图片 + 项目活动时间。
- 新增项目画廊分页接口：聚合美术、UI 和视频成品，支持分类过滤、隐藏过滤与稳定倒序游标。
- ArtWorkspace 迁移到新接口的 art 过滤后删除旧 `/api/gallery/project`。
- 项目元数据、归属与画廊隐藏写入口触碰对应项目目录，活动时间无需第二份持久化状态。

## Acceptance

- 美术、UI、镜头视频和成片均被正确归属；参考图、源图、失败记录和越界文件均被排除。
- 少于/多于四张、隐藏最新图、无媒体项目的封面结果正确。
- 相同 mtime 下分页无重复、无遗漏；非法项目返回 404。
- schema 双端与 `docs/api-contract.md` 同步，后端定向测试通过。

## Comments

- 2026-08-21：新增项目索引、跨媒体画廊、单媒体恢复接口和稳定游标；旧项目美术聚合接口已移除。
