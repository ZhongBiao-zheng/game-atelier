# GDD 模板（游戏策划方案）

> 所有 `projects/<slug>/design/gdd.md` 遵循此格式。
> 三锚文档之一（gdd / prd / interaction），是 UI 生成前的**正式门禁**：
> 三文档 `status: approved` 前 ui-page 不生图；确需跳过必须显式记录到 `design/waiver.md`。
> 与 spec 同纪律：agent 读的机器可读文档；禁止占位词（?、TBD、待定）；没问清的字段整行省略。
> 已有外部产出的 GDD（如 game-concept skill 的成稿）可直接放入此路径，ui-anchor 不重写、只补缺节。

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

### 定位（一句话说清是什么游戏）

```markdown
## 定位
- 名称: <游戏名>
- 品类: <品类>
- 核心体验: <一句话>
- 目标用户: <一句话>
- 核心卖点: <≤3 条，分号分隔>
```

### 核心循环（页面清单从这里推导）

```markdown
## 核心循环
<一行箭头链，如：登录 → 备战 → 对局 → 结算成长 → 商店补给 → 回流>

| 环节 | 玩家目标 | 主要界面 |
|---|---|---|
| <环节> | <目标> | <界面名> |
```

### 系统清单（带优先级，prd 页面范围的上游）

```markdown
## 系统清单
| 系统 | 优先级 | 说明 |
|---|---|---|
| <系统名> | must-have / genre-specific / optional | <一句话> |
```

### 世界观（UI 所需最小集，详细世界观在 worldview.md）

```markdown
## 世界观
- 时代气质: <一句话>
- 阵营势力: <有则列，无则省略此行>
- 文案语气: <一句话>
```

### 约束

```markdown
## 约束
- <版权 / 题材敏感点 / 美术成本约束，每条一行>
```

### 下游对应

- 需求与页面范围 → `design/prd.md`
- 页面交互与状态机 → `design/interaction.md`
- 视觉契约 → `style.md`（角色与 UI 共用，UI 节为 `ui.*`）
