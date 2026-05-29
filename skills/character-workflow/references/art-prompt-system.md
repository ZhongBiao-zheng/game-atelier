# 游戏美术 Prompt 系统规范

所有角色出图 Prompt 的共享底层。立绘（portrait）、美宣（promo）、三视图（turnaround）均继承此规范，各自附加专属控制逻辑。

---

## 一、spec.md 视觉锚点协议

每次写 prompt 前，必须从 `spec.md` 中提取以下锚点字段。**锚点一旦在 spec 中确立，未经画师明确授权不得在 prompt 中修改或"优化重写"。**

| 锚点字段 | 冻结级别 | 说明 |
|---|---|---|
| 发色 / 发型轮廓 | 🔴 硬锁定 | 立绘首张确立后不得变 |
| 瞳色 | 🔴 硬锁定 | 同上 |
| 服装主色调 + 整体轮廓 | 🔴 硬锁定 | 颜色和剪影不动 |
| 风格档（写实/半写实/卡通） | 🔴 硬锁定 | 整个角色生命周期内不变 |
| 武器 / 标志性道具形态 | 🟡 强参考 | 形状保留，局部细节可演绎 |
| 头身比 | 🟡 强参考 | 三视图中升为硬锁定 |

**检查规则**：发现 prompt 初稿与 spec 锚点不符 → **停下，问画师"这次要重定义视觉吗？"**，不要默默改，不要假设"这次微调可以"。改了配色就是另一张概念图，不是变体。

---

## 二、generation_mode（生成模式）

| 模式 | 触发条件 | 约束强度 |
|---|---|---|
| `first_gen` | 该角色该图类从未出过图 | 中。spec 尚不完整时可合理推断，但必须把推断内容告知画师。 |
| `variation` | 画师说"再来几张"/"换个角度"/"换个情绪" | 中。允许视角/姿势/场景变化，锚点字段严格不变。 |
| `refinement` | 画师给出具体改点（"把背景改成黄昏"/"发色再深一点"） | 高。只改画师指定内容，prompt 中其余锚点字段必须原文保留，不得"顺手优化"。 |

**refinement 模式的硬规则**：prompt 里凡是未被本轮改点涉及的锚点，逐字继承上一轮 prompt 原文。不允许"改过之后整体润色一遍"。

---

## 三、consistency_level（一致性级别）

每种图类有固定的一致性级别，不因画师要求而降低：

| 级别 | 适用图类 | 含义 |
|---|---|---|
| `strict` | 三视图 | 所有锚点全部冻结，不允许任何创意延伸 |
| `standard` | 立绘 | 锚点冻结，姿势/视角/道具演绎空间适度开放 |
| `loose` | 美宣 | 锚点冻结，场景/光线/情绪大幅自由 |

---

## 四、通用禁止项

以下内容无论图类均**禁止**出现在 prompt 中：

- 禁止写 `masterpiece` `best quality` `8k` `高质量` `影视级` 等空洞质量词
- 禁止写 `凄美绝色` `倾国倾城` `绝世容颜` 等网文滥词
- 禁止在未获授权的情况下修改任何 spec 锚点
- 禁止在同一 prompt 中写相互矛盾的描述（如"浅色背景"＋"深夜氛围"）
- 禁止省略排除段（negative prompt）—— 每张图必须有
- 禁止在 refinement 模式下对未改动字段进行任何重写或"润色"

---

## 五、参考图协议（reference image protocol）

写 prompt 前必须确认本次出图的参考图配置。参考图不是"塞进去就好"，而是需要语义化区分。

### 5.1 两种角色：subject_image vs reference_image

| 角色 | 作用 | 在画面中的地位 |
|---|---|---|
| `subject_image` | 主体保留图 —— 提供最终画面的核心主体（外观、结构、颜色、材质、关键识别特征） | 是最终画面的"谁" |
| `reference_image` | 视觉参考图 —— 提供风格、构图、色彩、光影、版式、氛围 | 决定最终画面"长什么样的风格/氛围" |

**关键规则**：当 subject_image 存在时，reference_image 中出现的人物或主体**不得替换 subject_image 的核心主体**。reference_image 只贡献视觉语言，不贡献身份。

### 5.2 当前基础设施约束

jobs schema 当前只有单 `source_image` 字段（`--source-image <绝对路径>`），未原生区分 subject / reference。所以本协议在 **prompt 文本层** 做语义区分，让模型读懂上传图的角色：

- 上传图作为 subject_image → prompt 中明确写"以上传图中的主体作为最终画面核心，保留其外观/服装/比例/关键识别特征"
- 上传图作为 reference_image → prompt 中明确写"上传图仅提供风格/构图/氛围参考，不复制其中的主体身份"
- 双图模式（未来扩展）：jobs schema 升级支持双图字段后，本协议无需改动

### 5.3 reference_mode（参考范围）

每次使用 reference_image 时必须显式声明 mode，在 prompt 中体现：

| mode | 含义 | 典型场景 |
|---|---|---|
| `full_reference` | 综合参考：风格 + 构图 + 色彩 + 光影 + 版式 + 氛围 | 美宣承接画师上传的"我想要这种感觉的图" |
| `style_only` | 只参考：风格、视觉气质、材质感、笔触 | 画师贴一张参考画派截图（"Loish 风格"） |
| `composition_only` | 只参考：构图、主体位置、画面重心、视角、留白 | 三视图参考一张 ArtStation 设定集布局 |
| `color_lighting_only` | 只参考：色彩系统、冷暖关系、光影氛围 | 美宣"我想要这张图的色调" |
| `pose_only` | 只参考：姿势、动作、肢体关系 | 立绘"按这个姿势画我的角色" |

### 5.4 在 prompt 文本中如何表达参考关系

**单图模式（仅 reference_image，无 subject_image）**：
- prompt 第1段末尾加一句："参考上传图的 [对应 mode 内容]，不复制其中的主体身份"
- 例：`...以此外观作为角色视觉基准。参考上传图的整体风格、笔触和色调（style_only），不复制其中的人物身份。`

**双图模式（subject_image + reference_image 同时存在）**：
- prompt 第1段说明 subject_image 决定核心主体："以上传主体图中的角色为画面核心，保留其外观、服装、关键识别特征"
- prompt 中另起一句说明 reference_image 的参考范围："参考风格图的 [对应 mode 内容]，不复制其中的主体"
- **禁止**写"不要使用参考图人物"/"删除人物" —— 应写"重新生成符合主体的人物，保留参考图中人物参与展示的画面关系"

**人物保留规则（双图 full_reference 模式专属）**：
当 reference_image 中存在人物且 mode = full_reference 时，必须保留参考图人物的基础属性（性别、大致年龄段、人数、气质、广告展示角色），但不复制其身份、面部、原始姿势或服装。

### 5.5 各图类的默认参考图行为

| 图类 | 隐式 subject_image | 画师上传图默认 mode |
|---|---|---|
| 立绘 first_gen | 无 | reference_image, `style_only` |
| 立绘 variation/refinement | `characters/<id>/portrait/v<n-1>.png` | reference_image, `full_reference` |
| 美宣 | `characters/<id>/portrait/v_latest.png`（必须，保证角色锚定） | reference_image, `full_reference` |
| 三视图 | `characters/<id>/portrait/v_latest.png`（强制，保证主体不变） | reference_image, `composition_only` |

**美宣 / 三视图的隐式 subject_image 规则**：即使画师没有上传 subject_image，最新立绘也必须作为隐式锚点 —— prompt 第1段必须明确继承 spec 的全部锚点字段（发色/瞳色/服装主色/风格档），等价于"以 spec 描述的角色为 subject_image"。

---

## 六、输出格式协议

所有 prompt 以**自然段式中文**输出，3～4 段，每段 1～3 句话。

**例外：参考图编辑 / refinement**

当本轮是基于现有图做编辑，尤其是皮肤、换色、局部服装修改时，prompt 不使用完整立绘模板。因为参考图已经承载角色身份、比例、表情、姿态、画风，文本只需要提供差异指令。

此模式输出 1～3 段，总字数约 120～260 中文字：
- 第 1 句说明参考图与目标主题
- 中间只写本轮要改的颜色 / 服装局部 / 背景
- 最后 1 句写必要边界，如"不改武器、不加特效、不改动作"
- 禁止把 spec 锚点完整重述一遍
- 禁止套用 first_gen 的身份、服装、姿势、风格四段模板

**绝对禁止**：
- 禁止使用【】模块标题（如【主体】【光线】【风格】）
- 禁止逐项列表、清单式结构、分号罗列
- 禁止超过 4 段正文
- 禁止将 spec 锚点照抄成流水账（锚点应融入句子，不要单独枚举）

排除段（negative prompt）**单独附在正文之后**，以 `排除：` 开头，一行写完，不换行。

---

## 七、per-skill 专项规则位置

| 图类 | 专项规则文件 |
|---|---|
| 立绘 | `skills/character-workflow/references/prompt-zh.md` |
| 美宣 | `skills/character-promo/references/prompt-promo-zh.md` |
| 三视图 | `skills/character-turnaround/references/prompt-turnaround-zh.md` |

各专项文件继承本文件所有规则，并补充该图类独有的输入协议、段落结构和质量门控。
