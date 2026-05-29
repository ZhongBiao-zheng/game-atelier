# Spec Template 设计文档

**日期**：2026-05-29
**状态**：已审批，待实施

---

## 背景与动机

现有 `characters/<id>/spec.md` 混杂了三类内容：

| 类型 | 示例 | 问题 |
|---|---|---|
| 设计定义 | 角色定位、外观锚点 | ✅ 应该在 spec |
| 生成就绪 prompt | "当前 spec(出图用)" 大文本块 | ❌ job JSON 已有，冗余 |
| 操作日志 | 出图记录、美宣记录、job_id | ❌ job 系统已有，冗余 |
| 项目级规则 | 品质皮肤系统、per-skin 设计段 | ❌ 属于项目 MEMORY，不属于角色 spec |

此外 `worldview.md` 与 `projects/<slug>/MEMORY.md` 边界模糊，造成双文件维护负担。

---

## 设计决策

### 1. spec.md 职责收窄

**spec.md = 角色身份定义文档**，只记录"这个角色是谁、长什么样"，不含任何派生内容或操作日志。

移出 spec 的内容：
- **出图/美宣/三视图记录**（job_id、日期、文件路径）→ 已在 job 系统，无需重复
- **出图用 prompt 正文**（大文本块）→ 已在 job JSON，无需重复
- **皮肤设计段 + 品质皮肤规则**（如"绿色品质皮肤：青袍谋主"）→ 项目级内容，迁入项目 MEMORY

### 2. spec.md 格式：YAML frontmatter + 结构化 markdown

spec 是 agent 读的，不是人读的。使用 YAML frontmatter 存元数据，markdown 节存结构化字段。

### 3. asset.* 节可扩展设计

每种资产类型（立绘/美宣/三视图/未来类型）一个 `## asset.<type>` 节，按需存在，统一前缀方便 agent 扫描。第一次出某类资产时由 Skill 追加对应节。

### 4. worldview.md 废除，并入项目 MEMORY

`projects/<slug>/worldview.md` 删除，内容迁入 `projects/<slug>/MEMORY.md`，后者增加标准分节结构。

---

## spec.md 模板

**位置**：`docs/references/spec-template.md`（仓库级，与 `art-prompt-system.md` 同级）

```yaml
---
id: <character-id>
name: <显示名>
project: <project-slug>
created: YYYY-MM-DD
---

## identity
- role: <职业 / 类型>
- archetype: <原型描述>
- temperament: <气质关键词>

## visual_dna
- style: <风格档（画风 + 线条 + 上色工艺）>
- palette: <主色（用途）/ 辅色（用途）/ 点缀色（用途，限定部位）>
- body: <体型特征>
- head: <头部特征>
- props: <核心道具>（无则省略此字段）

## anchors
1. <锚点——最强记忆点>
2. <锚点>
3. <锚点>
4. <锚点>

## asset.portrait
- size: <宽×高>
- angle: <镜头角度>
- background: <背景>
- pose: <姿势>
- expression: <表情>

## asset.promo
- size: <宽×高>
- format: <横版 KV / 竖版单卡 / ...>

## asset.turnaround
- size: 1536×1024
- views: <正/侧/背 + 可选追加项>
- extras: <武器拆解 / 表情包 / 无>
- background: <背景>

## prohibit
- <禁止项>
- <禁止项>
```

**字段规则**：
- 所有字段必须有实际值，不写占位词（`?` / TBD / 待定）
- 没问清的字段整行省略，不写空值
- `asset.*` 节只在该资产类型第一次出图后由 Skill 追加
- 新资产类型直接追加 `## asset.<type>` 节，不改模板结构

---

## 填充示例（火栗狐）

```yaml
---
id: huo-li-hu
name: 火栗狐
project: pokemon-adventure
created: 2026-05-21
---

## identity
- role: 火属性精灵 / 初阶进化形态
- archetype: 幼年小狐狸（四足兽形，非人形化）
- temperament: 顽皮灵巧、少年感

## visual_dna
- style: 宝可梦官方图鉴卡通（清晰黑轮廓线 + 水彩平涂 + 柔和边缘阴影）
- palette: 栗红（主毛）/ 暖橙（尾/腹/额毛）/ 蓬松白（胸领）/ 翠绿（眼瞳，唯一冷色）
- body: 四足幼狐、大头身比、四肢短粗
- head: 大圆耳、圆脸颊、额头火焰形毛束

## anchors
1. 胸前蓬松外撑白色毛领——最强记忆点
2. 大尾巴橙红双色环纹、尾尖橙色、长度接近体长
3. 额头向上翘起的火焰形毛束
4. 翠绿眼瞳与红橙皮毛强对比

## asset.portrait
- size: 1024×1536
- angle: 3/4 侧身
- background: 纯白简约 + 接地阴影
- pose: 四足站立微前倾、左前爪轻抬、尾巴 S 形上翘
- expression: 机灵带笑意、嘴角微翘露小巧獠牙

## prohibit
- 明火/火苗/烟雾
- 人类服装/饰品/武器
- 双足人型化
- 写实/厚涂质感
```

---

## Skills 引用方式

**character-workflow**（写 spec）的"写出图 prompt"节：

```
**spec 格式** → `docs/references/spec-template.md`
创建新 spec 时严格按模板 YAML 字段写；`asset.*` 节按需追加，问清才写，不写占位。
```

**character-promo / character-turnaround**（读 spec）的"写 prompt"节：

```
**spec 格式** → `docs/references/spec-template.md`
从 `visual_dna` + `anchors` 提取角色视觉信息；
从 `asset.promo` / `asset.turnaround` 读该资产类型的固定参数。
```

---

## 项目 MEMORY 新结构

`projects/<slug>/MEMORY.md` 吸收 worldview 内容，标准分节：

```markdown
# 项目记忆 — <project-name>

## 世界观与设计语言
（世界设定、整体美术风格、IP 一致性原则）

## 项目规则
（品质皮肤系统、角色设计约束、特殊工作流规定）

## 角色名册
（已建立角色的 id + 一句话定位，快速索引）

## 工作经验
（生图踩坑、prompt 技巧、跨角色通用发现）
```

### worldview 废除连带变更

| 影响点 | 变更内容 |
|---|---|
| Skills 启动必读（三个 SKILL.md） | 删掉 `worldview.md` 这行，只读 `MEMORY.md` |
| `turn-start` 返回字段 | `worldview_project` 字段改为 `project_memory` |
| 现有 worldview.md 文件 | 内容手动迁入 MEMORY.md 对应节，原文件 trash |
| CLAUDE.md 主文件 | Memory 三层说明删掉 `worldview.md` 引用 |

---

## 实施范围

本设计不涉及：
- job 系统 schema（不改）
- Web UI（不改）
- viewer-server（不改）

需要修改的文件：
1. **新建** `docs/references/spec-template.md`
2. **更新** `skills/character-workflow/SKILL.md`
3. **更新** `skills/character-promo/SKILL.md`
4. **更新** `skills/character-turnaround/SKILL.md`
5. **更新** `CLAUDE.md`（仓库根）和 `~/.claude/CLAUDE.md`（全局，worldview 引用）
6. **更新** `src/character_workflow/__main__.py`（turn-start worldview → project_memory）
7. **迁移** 现有 worldview.md → 各项目 MEMORY.md，trash 原文件
8. **迁移** 现有 spec.md 文件（移除日志段、prompt 段、皮肤段）
