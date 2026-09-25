# 团队库目录格式（format_version 1）

团队库是一个普通目录，由团队自己的 SVN / Git / Perforce / 网盘 / NAS 在成员机器之间同步。本文写给要读写这个目录的工具作者：照这里的规则写出来的资产，game-atelier 能识别、采用；生成资产在 §3.3 所列条件下还能复刻。照这里的规则读，就能读懂 game-atelier 写出的资产。

本文与代码一致由 `tests/test_team_library_format_doc.py` 保证：下文带 `example` 标记的 JSON 会被拿去做 schema 校验并搭成真实目录扫描，两张后缀表与五条正则逐字比对代码。代码位置：`src/character_workflow/lib/schemas.py`（`TeamLibraryManifest` / `TeamAssetFile` 等）、`team_library.py`、`team_library_share.py`（写方）、`team_library_index.py`（读方）。

## 1. 目录布局

```
<mount>/
  .atelier-library.json                 # 清单：库身份
  shared/
    <author-slug>/
      <asset_id>/
        asset.json                      # 资产元数据（含冻结快照）
        <media file>                    # 成片或媒体本体，文件名见 §4.2
        thumb.webp                      # 可选，作者写的缩略图
        refs/                           # 仅 generation：快照引用的参考内容
          01-<sha256 前 12 位>.png
          02-<sha256 前 12 位>.jpg
  <其他任何目录与文件>                   # 原始团队资产：团队自己放的文件
```

- 挂载点就是被选中的那个目录。想只暴露某个子目录，就挂那个子目录；多个子目录挂成多个库，各有一份清单。
- 路径分隔一律 `/`；`asset.json` 里的路径都相对资产目录，不引用库外或任何本机路径。
- 只有 `<mount>/shared/`（库根下这一个）按分享资产解析。其下只认两层：`shared/<author-slug>/<asset_id>/`，且目录里有 `asset.json` 才是资产候选；没有 `asset.json` 的目录整个忽略。
- `<mount>/shared/` 之外、后缀在 §6.3 表内的文件都是原始团队资产。`shared/` 里的文件永远不算原始资产。
- `shared`、`asset.json`、`thumb.webp`、`refs` 必须是小写原名。大小写不敏感的文件系统上，`Shared/` 会同时被当成分享目录和原始资产目录。
- 文件名与目录名建议用 Unicode NFC；macOS 上常见的 NFD 名字在别的系统上可能对不上 `asset.json` 里记的文件名。

## 2. 清单 `.atelier-library.json`

UTF-8 JSON，不带 BOM（带 BOM 的文件本产品解析失败）。读模型忽略未知字段。

| 字段 | 类型 | 规则 |
|---|---|---|
| `format_version` | int | 固定 `1`；缺省视为 `1`，其他值 = 不可读 |
| `library_id` | string | `lib_` + 16 位小写 hex，正则 `^lib_[a-f0-9]{16}$` |
| `name` | string | 1–120 字符，库的显示名 |
| `created_at` | string | ISO-8601 时刻，见 §3.6 |
| `created_by` | string | 1–40 字符，创建者显示名 |

- 由第一个挂载该目录的人创建：目录里没有这个文件时写一份（`library_id` = `lib_` + 8 字节随机数的 hex），随目录进版本库。
- 目录里已有清单时只读不写。清单读不出来、字段不合规或 `format_version` 不是 1，挂载直接失败，不会被覆盖重建。
- 清单存在即「库可达」；同步工具把它删了，库就不可达。
- `library_id` 是库的身份。同一个库在不同人机器上的挂载路径可以不同。

<!-- example: manifest -->
```json
{
  "format_version": 1,
  "library_id": "lib_9f3c2a7b1e4d6058",
  "name": "买牌三国 · 角色参考",
  "created_at": "2026-09-20T02:00:00.000000+00:00",
  "created_by": "老王"
}
```

## 3. 分享资产 `asset.json`

UTF-8 JSON，不带 BOM。读模型对每一层都忽略未知字段（向前兼容）。本产品写出时省略值为 `null` 的字段，读方把「缺字段」与 `null` 同等对待。

### 3.1 顶层字段

「必填」列为「否」的字段可以省略。

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `team_asset_version` | int | 否 | 固定 `1`；缺省视为 `1`，其他值 = 不可读 |
| `asset_id` | string | 是 | `ta_` + 26 位 Crockford base32（ULID），正则 `^ta_[0-9A-HJKMNP-TV-Z]{26}$`；**必须等于所在目录名** |
| `kind` | string | 是 | `generation` / `media` / `prompt` |
| `title` | string | 是 | 1–120 字符 |
| `tags` | string[] | 否 | 缺省为空；≤ 20 个；本产品写出时每个 ≤ 40 字符、去首尾空白、忽略大小写去重 |
| `author` | object | 是 | `{"display_name": string}`，1–40 字符 |
| `shared_at` | string | 是 | 首次分享时刻 |
| `updated_at` | string | 是 | 最后修改时刻；读方靠它判断「来源已更新」 |
| `media` | object | 按 `kind` | 见 §3.2 |
| `prompt` | object | 按 `kind` | 见 §3.5 |
| `snapshot` | object | 按 `kind` | 见 §3.3 |
| `origin` | object | 否 | `{"job_id"?: string, "canvas_project_id"?: string}`，只作追溯，任何工具都不应解析或依赖 |

`kind` 决定必带的载荷，缺了即不合规：

| `kind` | 必带 | 含义 |
|---|---|---|
| `generation` | `media` + `snapshot` | 生成结果 + 冻结快照，可复刻（条件见 §3.3） |
| `media` | `media` | 纯媒体文件 |
| `prompt` | `prompt` | 提示词，不带文件 |

写方只写该 `kind` 需要的载荷。

`asset_id` 的 ULID：48 位毫秒时间戳 + 80 位随机数，按 Crockford 字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ` 编成 26 位大写。任何能产生全局唯一、符合正则的值都可以；读方不从 id 里解时间。

### 3.2 `media`

| 字段 | 类型 | 规则 |
|---|---|---|
| `filename` | string | 1–255 字符，资产目录内的文件名，命名见 §4.2 |
| `mime_type` | string | 以 `image/`、`video/` 或 `audio/` 开头；写方只写 §4.4 表内的类型 |
| `bytes` | int | ≥ 1，文件字节数 |
| `sha256` | string | 文件内容的 sha256，小写 hex，正则 `^[a-f0-9]{64}$` |

`mime_type` 按文件内容认定，不按后缀：本机常有 `.png` 实为 JPEG 的文件。

### 3.3 `snapshot`（仅 generation）

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `mode` | string | 是 | `image` / `video` |
| `model` | string | 是 | 1–200 字符，模型 id |
| `provider` | string | 否 | 供应商 id |
| `alias` | string | 否 | 模型别名 |
| `final_prompt` | string | 是 | 实际提交的提示词 |
| `draft_prompt` | string | 否 | 提交前的草稿提示词 |
| `params` | object | 否 | 缺省为 `{}`；提交参数 |
| `cost_cny` | number | 否 | ≥ 0，人民币 |
| `cost_basis` | string | 否 | `actual` / `estimated`；与 `cost_cny` **成对**：同时有值或同时缺省 |
| `submitted_at` | string | 是 | 提交时刻 |
| `inputs` | array | 否 | 缺省为空；≤ 64 份参考，见 §3.4 |

`params` 由本产品写出时只含生成参数（尺寸、比例、质量、时长、seed 等），不含本机路径、费用、运行后回写的状态。读 `asset.json` 时它是不透明对象，任意键都能通过校验、原样保留。首尾帧视频的参考顺序由 `params.frame_mode` 解释。

复刻比读更严。本产品复刻时：

- 只取本产品画布该 `mode` 支持的参数键，其余键丢弃；
- 已知键的值类型不对（比如 `n` 写成字符串 `"两张"`），复刻失败；
- `model` 须是本产品已接入的模型 id，否则复刻出的配置没有可用模型。

### 3.4 `snapshot.inputs[]`

| 字段 | 类型 | 规则 |
|---|---|---|
| `order` | int | 数组必须按 `order` 升序、从 0 连续编号（第 i 项的 `order` 就是 i） |
| `role` | string | `reference` / `mask` / `mj_sref` / `mj_cref` / `mj_oref` |
| `kind` | string | `image` / `video` / `audio`，必须等于 `mime_type` 的主类型 |
| `sha256` | string | 参考文件内容的 sha256，正则同上 |
| `mime_type` | string | 必须是 §4.4 表内的类型 |
| `path` | string | 相对资产目录，正则 `^refs/[0-9]{2}-[a-f0-9]{12}\.[a-z0-9]{2,5}$`，命名见 §4.3 |

快照里的参考一律拷进 `refs/`：这是「记录在别人机器上也完整」的保证。

### 3.5 `prompt`（仅 prompt）

```
{"kind": "prompt", "segments": [ <段>, ... ]}
```

`kind` 固定 `"prompt"`，不能省。`segments` 1–400 段，每段按 `kind` 分两种：

| 段 `kind` | 字段 | 规则 |
|---|---|---|
| `text` | `text` | 1–40000 字符，原样文本 |
| `variable` | `name`、`default_value` | `name` 1–40 字符，`default_value` 1–40000 字符；使用时可替换的变量 |

整段提示词 = 各段按顺序拼接（变量段取其值）。

### 3.6 时间戳

`shared_at` / `updated_at` / `submitted_at` / `created_at` 都是 ISO-8601 字符串。本产品写 UTC、带 `+00:00` 与微秒（如 `2026-09-25T02:13:45.123456+00:00`）。判断来源是否更新时按时刻比：`Z`、`+00:00`、`+08:00` 都接受，不带时区的当 UTC；解析不了的当「未知」（本产品不据此提示更新）。其他场合（如列表排序）不保证按时刻比，写方请统一写 UTC。

## 4. 命名规则

### 4.1 作者目录 `<author-slug>`

由 `author.display_name` 得来：

1. Unicode NFC 规范化；
2. 每个不属于 `[\w-]` 的字符（`\w` 为 Unicode 字母、数字、下划线，含中文）换成 `-`；
3. 去掉首尾 `-`；截到前 60 个字符后再去一次首尾 `-`；
4. 结果为空则用 `author`。

例：`老王` → `老王`，`Wang Lei` → `Wang-Lei`，`!!!` → `author`。

作者身份以 `asset.json` 里的 `author.display_name` 为准，不从目录名反推。两个显示名可能落到同一个目录（`老王!` 与 `老王?`），各自只认 `display_name` 与自己相同的资产。

### 4.2 成片文件名

从原文件名依次处理：

1. 只取文件名部分（丢掉目录）。后缀（忽略大小写，`.jpeg` 也算 `image/jpeg`）已对应真实类型就保留，否则保留主名、改成 §4.4 表里真实类型的后缀；
2. `<>:"/\|?*` 与控制字符 `\x00`–`\x1f` 换成 `-`，去首尾空格与 `.`；
3. 结果为空、以 `.` 开头，或忽略大小写等于 `asset.json` / `thumb.webp` / `refs` → 改为 `media<小写后缀>`；
4. 第一个 `.` 之前的部分（去尾部空格后、忽略大小写）是 Windows 保留名 `CON` `PRN` `AUX` `NUL` `COM1`–`COM9` `LPT1`–`LPT9` → 前面加 `media-`；
5. UTF-8 超过 255 字节 → 截主名、保留后缀，截完去掉主名尾部的空格与 `.`。

读方不重新推导文件名，只按 `media.filename` 找文件。

### 4.3 参考文件名

`refs/NN-<sha12>.<ext>`：

- `NN` = `order + 1`，两位补零（`order` 0 → `01`）；
- `<sha12>` = 该文件 sha256 的前 12 位；
- `<ext>` = §4.4 表里该 `mime_type` 的后缀。

### 4.4 媒体类型与后缀（写方）

`media.mime_type` 与 `inputs[].mime_type` 只用这张表里的类型；参考文件名的后缀取这里的后缀。

| mime_type | 后缀 |
|---|---|
| `image/png` | `.png` |
| `image/jpeg` | `.jpg` |
| `image/webp` | `.webp` |
| `image/gif` | `.gif` |
| `video/mp4` | `.mp4` |
| `video/webm` | `.webm` |
| `video/quicktime` | `.mov` |
| `audio/mpeg` | `.mp3` |
| `audio/wav` | `.wav` |
| `audio/mp4` | `.m4a` |

## 5. 写方规则

- **只写自己的目录**：`shared/<自己的 author-slug>/`。别人的目录永远不碰。清单是唯一的例外，且只在首次挂载时写一次。
- **新资产**：在作者目录下建 `.tmp-<asset_id>/`，把成片、`refs/`、`thumb.webp`、`asset.json` 全部写进去，再整体改名成 `<asset_id>/`；中途失败删掉临时目录。读方跳过点目录，永远读不到半成品。
- **更新**：只改自己资产的 `asset.json` 里的 `title` / `tags` / `updated_at`，其余字段与未知字段原样保留（在原始 JSON 上改，不经由自己的模型重新序列化）；先写临时文件再替换。成片与快照不改：内容变了就撤回再分享一条新的。
- **撤回**：把 `<asset_id>/` 改名成 `.tmp-del-<asset_id>`（已有同名残留先删），再删除。改名成功即撤回完成；删不干净只剩一个点目录，读方看不到。
- **不写任何缓存、索引、日志**进库。读方的索引与缩略图缓存都在各自本机。
- **缩略图**：只有作者为自己的图片资产写 `thumb.webp`，长边 ≤ 512px 的 webp；视频、音频、提示词没有。它是可选的：本产品读方目前自己在本机生成缩略图，不依赖它。
- 写方在 `shared/` 下只产生 `<author-slug>/<asset_id>/` 与上面两种临时点目录。`.svn` / `.git` 这类版本工具目录由同步工具自己管，读方一律跳过。

## 6. 读方规则

### 6.1 通用

- 忽略所有以 `.` 开头的目录与文件（`.svn`、`.git`、`.tmp-*`、`.tmp-del-*` 等）。
- 库内指向库外的 symlink 不属于这个库：扫描与读取都不认。资产目录里的文件必须真在该资产目录内（不含 `..`，不经由指向外面的链接）。
- 扫描原始资产时不进入任何 symlink 目录（指向库内的也不进）；symlink 文件只在指向库内时被识别。
- 未知字段忽略。`format_version` 不是 1 的清单不可读（本产品拒绝挂载）；`team_asset_version` 不是 1 的 `asset.json` 不可读（按下条「未就绪」处理）。

### 6.2 分享资产的就绪判定

以下任一情况，该资产**未就绪**（本产品显示 incomplete，不可采用）：

- `asset.json` 读不出、不是合法 JSON，或不符合 §3 的规则；
- `asset_id` 与目录名不同（手工拷贝 / 改名的目录）；
- `media.filename` 指的文件不存在；
- `snapshot.inputs[]` 任一 `path` 指的文件不存在。

未就绪通常是同步工具还没把整个目录拉完，下次扫描可能就绪。就绪只看文件在不在；使用前要按 `sha256` 校验内容，对不上当作还没同步完（本产品采用时就这样拒绝）。

`media.mime_type` 不在 §4.4 表内、按文件内容也认不出表内类型的资产，显示为就绪，但本产品不能采用。

### 6.3 原始团队资产

`<mount>/shared/` 之外的每个文件，同时满足以下条件就是一条原始团队资产：不以 `.` 开头、不在点目录里；文件名不以冲突副本后缀 `.mine` 或 `.r<数字>` 结尾（正则 `\.(mine|r\d+)$`）；后缀（忽略大小写）在下表内；不是指向库外的 symlink；路径上没有 symlink 目录。

| 后缀 | mime_type |
|---|---|
| `.png` | `image/png` |
| `.jpg` | `image/jpeg` |
| `.jpeg` | `image/jpeg` |
| `.webp` | `image/webp` |
| `.gif` | `image/gif` |
| `.mp4` | `video/mp4` |
| `.webm` | `video/webm` |
| `.mov` | `video/quicktime` |
| `.mp3` | `audio/mpeg` |
| `.wav` | `audio/wav` |
| `.m4a` | `audio/mp4` |

- 类型按后缀认定，时刻取文件修改时间。
- 身份 = `library_id` + 库内相对路径（`/` 分隔）。改名或移动即新资产，旧的视为已撤回。本产品的条目 id 是 `raw_` + 相对路径 UTF-8 字节的 sha1 前 24 位。
- 判断采用副本是否过期时，同一路径的内容以文件 sha256 为准：修改时间变了但 sha256 没变（版本工具重新检出）不算过期。索引层只看修改时间，mtime 一变就发 `updated` 事件。

## 7. 权限

「只有作者能改、能撤回」是界面层约定：本产品只在 `shared/<自己的 author-slug>/` 里、且 `author.display_name` 等于本机显示名时才允许改或撤回。文件层不设防，任何能写这个目录的人或工具都能改任何文件。这是有意的取舍，见 [ADR-0020](adr/0020-team-library-is-a-synced-folder.md)。

## 8. 完整示例

一个库：清单见 §2；作者 `老王` 分享了一条生成资产和一条提示词；库里另有团队自己放的 `角色/董卓/idle.png`。

```
<mount>/
  .atelier-library.json
  shared/
    老王/
      ta_01J8Z3K7M2Q9R4T6V8W0X1Y2Z3/
        asset.json
        dongzhuo-green-idle.png
        thumb.webp
        refs/
          01-1f2ad1a37047.png
          02-f7ae3d69686d.jpg
      ta_01J8Z4A0B1C2D3E4F5G6H7J8K9/
        asset.json
  角色/
    董卓/
      idle.png
```

生成资产：

<!-- example: asset -->
```json
{
  "team_asset_version": 1,
  "asset_id": "ta_01J8Z3K7M2Q9R4T6V8W0X1Y2Z3",
  "kind": "generation",
  "title": "董卓 绿色品质 待机",
  "tags": ["皮肤", "绿色"],
  "author": {"display_name": "老王"},
  "shared_at": "2026-09-25T02:13:45.123456+00:00",
  "updated_at": "2026-09-25T02:13:45.123456+00:00",
  "media": {
    "filename": "dongzhuo-green-idle.png",
    "mime_type": "image/png",
    "bytes": 64,
    "sha256": "258c15d8f13fe719c3028a66286a190ade94d1818f64487517fa3f2251a4d878"
  },
  "snapshot": {
    "mode": "image",
    "model": "gpt-image-2",
    "provider": "tuzi",
    "final_prompt": "董卓，绿色品质皮肤，待机姿势，全身立绘",
    "draft_prompt": "董卓 绿色皮肤 待机",
    "params": {"size": "1024x1536", "quality": "high", "n": 1},
    "cost_cny": 0.21,
    "cost_basis": "actual",
    "submitted_at": "2026-09-25T02:10:02.004211+00:00",
    "inputs": [
      {
        "order": 0,
        "role": "reference",
        "kind": "image",
        "sha256": "1f2ad1a37047f879456c4095eee65d9592ddc5e4da6bfe995ae83bfc95a5554c",
        "mime_type": "image/png",
        "path": "refs/01-1f2ad1a37047.png"
      },
      {
        "order": 1,
        "role": "reference",
        "kind": "image",
        "sha256": "f7ae3d69686def4a89271988f9770f00fb3563df486fd7a31edab515d399589f",
        "mime_type": "image/jpeg",
        "path": "refs/02-f7ae3d69686d.jpg"
      }
    ]
  },
  "origin": {"job_id": "job-20260925-021002-a1b2c3"}
}
```

提示词资产：

<!-- example: asset -->
```json
{
  "team_asset_version": 1,
  "asset_id": "ta_01J8Z4A0B1C2D3E4F5G6H7J8K9",
  "kind": "prompt",
  "title": "三国武将立绘模板",
  "tags": ["模板"],
  "author": {"display_name": "老王"},
  "shared_at": "2026-09-25T03:00:00.000000+00:00",
  "updated_at": "2026-09-25T03:20:31.500000+00:00",
  "prompt": {
    "kind": "prompt",
    "segments": [
      {"kind": "text", "text": "三国武将"},
      {"kind": "variable", "name": "角色", "default_value": "董卓"},
      {"kind": "text", "text": "，全身立绘，"},
      {"kind": "variable", "name": "品质", "default_value": "绿色品质"},
      {"kind": "text", "text": "皮肤，纯色背景"}
    ]
  }
}
```

示例里的 `sha256` 与 `bytes` 由测试生成的占位字节计算得出。
