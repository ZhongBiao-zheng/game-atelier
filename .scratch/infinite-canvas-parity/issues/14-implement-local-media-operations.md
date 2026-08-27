# 14：实现裁剪、切图与本地放大

Type: implement

Status: ready-for-human

Blocked by: 09-plan-media-tools, 13-implement-read-only-media-tools

## Goal

把图片节点的三种确定性派生操作接入同一个服务端命令：浏览器只保存可丢弃的交互参数，Pillow 从当前
Content Version 读取源图并生成项目拥有的不可变 PNG，服务端原子创建结果节点与 local-tool 派生连接。

## Included

- `POST /canvas/projects/{project_id}/media-operations` 的 crop / split / upscale discriminated union。
- Pillow 静态图解码、EXIF 归一、透明通道保留、像素/块数/输出体积限制与安全错误码。
- 项目级单操作、全局双操作门控，以及 derived 文件移动与 Canvas Document 提交的可恢复事务。
- 裁剪比例选项、2–12 行列切图、四档目标长边与三种重采样算法 Dialog。
- 成功后合并服务端 Document、选中新结果；一次 split 作为一次画布 undo/redo，不重跑图片处理。

## Excluded

- AI 超分、蒙版编辑、多角度、反推提示词与视频编辑。
- 媒体替换和工具栏个性化排序。
- 修改旧 Canvas v1 测试或增加兼容路径。

## Exit gate

- 隔离数据验证三种操作、透明/EXIF、源文件不变、跨项目/非法参数拒绝、冲突零写与事务恢复。
- 真实页面可打开三种 Dialog，键盘关闭、处理中防重复提交，结果节点/连接/历史行为正确。
- Ruff、设计守卫、生产构建与本阶段定向冒烟通过；源码不新增 TypeScript 错误。

## Verification

- 隔离数据冒烟通过：RGBA 裁剪、12×12/144 块切图、Lanczos 放大、非法切线/跨项目/冲突零写、
  EXIF 方向归一、64MP 拒绝、移动后崩溃恢复，以及 undo/redo 不改 derived 文件 mtime。
- 真实隔离页面通过：三种 Dialog、Escape 关闭、固定比例、切线内部 undo/redo、算法选择、处理中提交、
  一次 split 的画布撤销/重做；最终 9 个节点与 8 条派生边一致，控制台无错误。
- 发现并修复多次派生结果重叠：新批次保持内部布局，遇到现有节点时整组向下避让。
- 双轴复审补齐：浏览器按 EXIF 归一后的自然尺寸计算选区；非法参数和处理资源异常固定结构化错误码；
  窄节点把三项图片工具折入“更多”；处理前自动保存失败会在当前 Dialog 内就近公告。
- `ruff check src tests`、8 项设计漂移守卫、Vite 生产构建通过。
- 全量基线未回归：Python 仍为 10 failed / 940 passed / 3 skipped；Web 仍为
  16 failed / 387 passed / 13 errors，均为已知 Canvas v1 与文本模型分类旧测试，本阶段未修改测试文件。
