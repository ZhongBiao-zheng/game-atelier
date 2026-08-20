# Screen Brief 模板（单页结构事实源）

> 所有 `projects/<slug>/ui/<scheme-id>/screens/<screen-id>.md` 遵循此格式。
> brief 是页面**结构**的事实源；prompt 是一次生成的快照（存 job JSON）——两者分离，
> 结构改动改 brief，生成参数不回写 brief。
> 禁止占位词；没问清的字段整行省略。

---

## 格式规范

### YAML frontmatter（必填元数据）

```yaml
---
project: <project-slug>
screen: <screen-id>
updated: YYYY-MM-DD
---
```

### 定位

```markdown
## 定位
- 页面目标: <一句话，这一页帮玩家完成什么>
- 玩家旅程: <从哪进来 / 完成后去哪>
```

### 布局分区

```markdown
## 布局分区
| 区域 | 位置 | 内容 |
|---|---|---|
| <区名> | <顶部 / 左侧 / 中央 / 底部…> | <放什么> |
```

### 组件

```markdown
## 组件
- <组件>: <形态与交互要点>
```

### 状态

```markdown
## 状态
- <状态名>: <UI 表现>
```

状态名沿用 `interaction.md` 对应 `## screen.<screen-id>` 节的契约，不另起新名。

### 反向限制

```markdown
## 反向限制
- <这一页不要出现的元素 / 风格禁项，逐条一行>
```
