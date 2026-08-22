# Project Style Contract 模板

> 所有 `projects/<slug>/style.md` 必须遵循此格式。
> 根 style.md 是**项目级视觉基线**：定死所有资产共享的视觉语言，角色与各 UI 方案都会注入，
> 专治连续生图的风格漂移。角色个体差异写各自 spec.md，不写在这里。
> 与 spec 同纪律：agent 读的机器可读文档；禁止占位词（?、TBD、待定）；没问清的字段整行省略。

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

- `status: draft` = 初稿，skill 可继续对话完善。
- `status: approved` = 画师已确认；**修改 approved 契约必须先经画师确认**，
  不得静默改写（项目下所有角色的一致性都锚在这份文件上）。

### style（画风工艺）

```markdown
## style
- render: <画风档（如：宝可梦官方图鉴卡通 / 厚涂写实 / 赛璐璐）>
- line: <线条工艺（如：清晰黑轮廓线 / 无线稿软边）>
- shading: <上色工艺（如：水彩平涂 + 柔和边缘阴影）>
```

### palette（项目色板，带语义）

每条 = 颜色 + 它在项目里的语义用途（阵营 / 品质 / 情绪），不是零散好看色。

```markdown
## palette
- <颜色>: <语义用途>
- <颜色>: <语义用途>
```

### camera（默认镜头规范）

```markdown
## camera
- angle: <默认镜头角度>
- framing: <默认取景（全身 / 半身 / 特写倾向）>
```

### background（背景规范）

```markdown
## background
- default: <默认背景处理>
```

### taboo（项目级反向约束）

全项目所有资产的禁止项；角色个体禁止项仍写各自 spec 的 `## prohibit`。

```markdown
## taboo
- <禁止项>
- <禁止项>
```

### ui.*（写入具体 UI 方案）

UI 专属规则不写进项目根文件，而是写入
`projects/<slug>/ui/<scheme-id>/style.md`。该文件复用相同 frontmatter，并只承载当前方案的 UI
差异；生成 prompt 按“项目根基线 → 方案 style”组合：

```markdown
## ui.typography
- <字体气质 / 层级规范>

## ui.geometry
- <圆角 / 描边 / 材质规范>

## ui.states
- <组件状态视觉规范（normal / hover / pressed / disabled）>
```

---

## 完整示例

```yaml
---
project: pokemon-style-elf-game
status: approved
updated: 2026-08-10
---

## style
- render: 宝可梦官方图鉴卡通
- line: 清晰黑轮廓线
- shading: 水彩平涂 + 柔和边缘阴影

## palette
- 翠绿: 草属性精灵主色
- 栗红: 火属性精灵主色
- 天青: 水属性精灵主色
- 暖橙: 点缀色（腹部 / 尾尖等局部）

## camera
- angle: 3/4 侧身
- framing: 全身

## background
- default: 纯白简约 + 接地阴影

## taboo
- 写实 / 厚涂质感
- 人类服装 / 武器
- 血腥 / 恐怖元素
```
