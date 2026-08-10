# Screen Map 模板（项目页面清单 + 每页契约）

> 所有 `projects/<slug>/screens/screen-map.md` 遵循此格式。
> screen-map 是**项目页面全景**的事实源：清单表管范围与优先级，每页一节契约管结构基础——
> `ui-page` 写单页 brief 时从对应 `## screen.<id>` 节取基础，不凭空推。
> 上游是 prd 的「页面范围」表：screen-map 必须承接 prd 全部页面；旅程审计推出的新页面
> 经画师确认后**先回写 prd 再入 map**，两处不一致以 prd 为准。
> 与 spec 同纪律：禁止占位词（?、TBD、待定）；没问清的字段整行省略。

---

## 格式规范

### YAML frontmatter（必填元数据）

```yaml
---
project: <project-slug>
status: draft | approved
updated: YYYY-MM-DD
---
```

- `status: approved` = 画师已批准页面范围；逐页生成只做 approved 清单内的页。
- 修改 approved 的 screen-map（加页 / 删页 / 改优先级）必须先经画师确认。

### 页面清单表

```markdown
## 页面清单
| screen-id | 名称 | 分类 | 优先级 | 状态 | 依赖 |
|---|---|---|---|---|---|
| <小写连字符 id> | <中文名> | <taxonomy 分类> | must-have / genre-specific / optional | planned / generated / canonical | <前置 screen-id，无则留空> |
```

- `状态` 由生成进度推进：`planned`（仅契约）→ `generated`（已出图）→ `canonical`（已定稿）。
- `依赖` 指生成顺序依赖（延展页依赖基准页的结构与风格），不是玩法跳转关系。
- 生成批次按依赖与优先级排：先基准页，再高复用系统页，最后运营页。

### 每页一节契约

每个清单内页面一节，节名 `## screen.<screen-id>`，字段与 screen-brief 模板对齐
（`ui-page` 直接取用）：

```markdown
## screen.<screen-id>
- purpose: <一句话，这一页帮玩家完成什么>
- 玩家旅程: <从哪进来 / 完成后去哪>

### 布局分区
| 区域 | 位置 | 内容 |
|---|---|---|
| <区名> | <顶部 / 左侧 / 中央 / 底部…> | <放什么> |

### 组件
- <组件>: <形态与交互要点>

### 状态
- <状态名>: <UI 表现>
```

- 状态名沿用 `interaction.md` 对应节的契约，不另起新名。
- 开发实现字段（data_needs / entry_points 枚举 / edge_cases 清单）**不写**——
  异常态归 prd「边界与异常」，本契约只保留 prompt 能引用的结构信息。
