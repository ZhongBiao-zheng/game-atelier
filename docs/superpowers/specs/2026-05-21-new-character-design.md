# 新建角色功能设计

**日期：** 2026-05-21
**范围：** Web UI 新建角色入口 + 后端创建端点

---

## 背景

当前 Web 只能新建项目（用于角色分类），无法直接在 Web 上创建角色。角色只能由 `/character-workflow` Skill 在终端对话中建档。画师需要一个轻量的 Web 入口：输入名字即可创建角色骨架，后续再通过 Skill 补全 spec。

---

## 目标

- Web 上通过名字创建角色目录结构 + 空 spec.md
- 创建后自动选中新角色，进入画廊视图
- 不引入额外表单字段，保持"对话驱动 spec"的哲学

---

## 后端

### `POST /api/characters`

**请求体：**
```json
{ "name": "烈拳猴" }
```

**逻辑：**
1. 校验 `name` 非空（否则 422）
2. 生成 `id = f"char-{int(time.time())}"`
3. 创建目录：
   - `characters/<id>/portrait/`
   - `characters/<id>/promo/`
   - `characters/<id>/turnaround/`
   - `characters/<id>/source/`
4. 写 `characters/<id>/spec.md`：
   ```markdown
   # <name>

   （尚无档案 — 请在终端 /character-workflow 对话补全）
   ```
5. 调 `write_active(id)` 设为活跃角色
6. 返回 `CharacterEntry`（与 `GET /api/characters` 列表元素格式相同）

**错误处理：**
- `name` 为空 → HTTP 422
- 目录创建失败 → HTTP 500，返回 `{ detail: "..." }`
- 重名允许（ID 不同，时间戳保证唯一）

---

## 前端

### LeftSidebar.tsx 改动

**1. BrandHeader 新增"新角色"按钮**

- 图标：`UserPlus`（来自 lucide-react）
- 和已有"新项目"按钮并排，样式相同（`h-7 px-2 text-xs variant="outline"`）
- 有角色/无角色两个状态下都显示

**2. 内联输入（同"新项目"UX）**

- 点击"新角色"→ 角色列表顶部出现 Input
- `placeholder="角色名（如：烈拳猴）"`
- Enter / blur → 提交
- Escape / 空名字 → 取消
- 提交成功 → `onSelect(id, name)` 自动跳到新角色
- 提交失败 → 显示 error 提示（复用现有 `error` state）

**3. 修复空状态按钮**

- 空状态的"新建角色"按钮当前无 onClick，接入同一套 `startNewCharacter()` 函数

### 新增状态

```ts
const [creatingCharacter, setCreatingCharacter] = useState(false);
const [newCharacterName, setNewCharacterName] = useState('');
const newCharInputRef = useRef<HTMLInputElement | null>(null);
```

### 数据流

```
用户点击"新角色"
→ setCreatingCharacter(true)
→ Input 自动 focus

用户输入名字 → Enter / blur
→ POST /api/characters { name }
→ 成功：onSelect(id, name)
→ 失败：setError(...)

SSE sseSignal 触发 → 角色列表刷新，新角色出现在列表中
```

---

## 不在范围内

- 角色删除
- spec 字段表单（靠 `/character-workflow` 对话补全）
- 角色 ID 自定义输入
- 角色头像上传（source/ 上传由 GalleryUpload 负责）

---

## 文件改动清单

| 文件 | 改动 |
|---|---|
| `skill/viewer_server/routes.py` | 新增 `POST /api/characters` 端点 |
| `web/src/components/LeftSidebar.tsx` | 新增"新角色"按钮 + 内联输入 + 空状态按钮接入 |
