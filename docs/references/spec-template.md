# Character Spec 模板

> 所有 `characters/<id>/spec.md` 必须遵循此格式。
> spec 是 agent 读的机器可读文档，不是人读的说明书。
> 禁止写占位词（?、TBD、待定）；没问清的字段整行省略，不写空值。

---

## 格式规范

### YAML frontmatter（必填元数据）

```yaml
---
id: <character-id>
name: <显示名>
project: <project-slug>
created: YYYY-MM-DD
---
```

### identity（角色身份）

```markdown
## identity
- role: <职业 / 类型>
- archetype: <原型描述>
- temperament: <气质关键词>
```

### visual_dna（视觉 DNA，跨资产共享）

```markdown
## visual_dna
- style: <风格档（画风 + 线条 + 上色工艺）>
- palette: <主色（用途）/ 辅色（用途）/ 点缀色（用途，限定部位）>
- body: <体型特征>
- head: <头部特征>
- props: <核心道具>（无则省略此字段）
```

### anchors（视觉锚点）

跨所有资产类型必须保留的视觉元素，编号排列，最强记忆点在第 1 条。

```markdown
## anchors
1. <锚点——最强记忆点>
2. <锚点>
3. <锚点>
4. <锚点>
```

### asset.* 节（按资产类型，按需存在）

第一次出某类资产时由 Skill 追加对应节；没出过该类型则无该节。
新增资产类型直接追加 `## asset.<type>` 节，不改模板结构。

**立绘：**
```markdown
## asset.portrait
- size: <宽×高>
- angle: <镜头角度>
- background: <背景>
- pose: <姿势>
- expression: <表情>
```

**美宣：**
```markdown
## asset.promo
- size: <宽×高>
- format: <横版 KV / 竖版单卡 / ...>
```

**三视图：**
```markdown
## asset.turnaround
- size: 1536×1024
- views: <正/侧/背 + 可选追加项>
- extras: <武器拆解 / 表情包 / 无>
- background: <背景>
```

### prohibit（生成禁止项）

```markdown
## prohibit
- <禁止项>
- <禁止项>
```

---

## 完整示例

```yaml
---
id: huo-li-hu
name: 火栗狐
project: pokemon-style-elf-game
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

## asset.promo
- size: 1536×1024
- format: 横版 KV

## prohibit
- 明火/火苗/烟雾
- 人类服装/饰品/武器
- 双足人型化
- 写实/厚涂质感
```
```
