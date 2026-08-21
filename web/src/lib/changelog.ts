/** 版本更新日志 —— 顶栏「更新」入口的数据源。
 *
 * 为什么放前端常量而不是后端接口：更新日志是随代码一起发布的静态内容，跟版本同生命周期。
 * 走接口就要多一份运行时数据、多一条失败路径，而它永远不会在运行期变化。
 *
 * **发版时怎么加**：在数组**开头**插一条（新版在前），version 与 `.claude-plugin/plugin.json`
 * 的 version 保持一致 —— 两处真值必然漂移，所以 changelog.test.ts 里有一条断言把它们钉死，
 * 忘了同步会红。文案写给画师看：说这版能做什么，不是 commit message。
 */
export type ChangeKind = 'feat' | 'fix';

export interface ChangelogChange {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** 一句话概括这版的主题，显示在版本号下方。 */
  headline: string;
  changes: ChangelogChange[];
}

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  feat: '新增',
  fix: '修复',
};

/** 新版在前。第一条的 version 即当前版本。 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '5.27.0',
    date: '2026-08-21',
    headline: '工坊从项目卡片进入，首页集中展示全部作品',
    changes: [
      { kind: 'feat', text: '工坊首页改为项目卡片墙，自动用最近四张未隐藏图片拼成项目封面；新建、重命名和删除项目都在卡片墙完成' },
      { kind: 'feat', text: '进入项目后，左侧先切换项目，再浏览项目首页、个人文件夹和美术、UI、视频资产，不再重复显示一排工作区按钮' },
      { kind: 'feat', text: '项目首页恢复世界观阅读态，并新增跨美术、UI、视频的项目画廊，可筛选、连续预览、隐藏作品并进入真实资产详情' },
      { kind: 'fix', text: '项目世界观未保存时，切换项目、点击链接或浏览器后退都会先提醒；失效项目链接也能明确返回全部项目' },
      { kind: 'fix', text: 'UI 页面图、视频镜头和成片从项目画廊隐藏后，可以在各自资产详情恢复展示' },
      { kind: 'fix', text: '空白视频工作区不再导向自由试验；现在可以直接复制指令建立正式视频企划' },
    ],
  },
  {
    version: '5.26.0',
    date: '2026-08-20',
    headline: '视频镜头可以直接引用项目定稿了',
    changes: [
      { kind: 'feat', text: '视频镜头页可以直接浏览并选择项目里的角色、皮肤和 UI 页面定稿，下一次生成自动带上这些参考素材' },
      { kind: 'feat', text: '每次视频生成都会把实际参考路径写进 Job 历史；之后改选定稿，旧镜头记录仍保持当时使用的版本' },
      { kind: 'fix', text: '从个人文件夹进入角色、UI 或视频后会保留返回入口，继续查看镜头和页面也不会丢失原文件夹上下文' },
    ],
  },
  {
    version: '5.25.0',
    date: '2026-08-20',
    headline: '同一个项目可以并存多套 UI 方案了',
    changes: [
      { kind: 'feat', text: 'UI 工作区可以并存 V1、V2 等多套方案；每套方案独立保存风格说明、页面地图、页面版本和定稿' },
      { kind: 'feat', text: '新建方案时可以从当前方案复制风格、页面地图和指定页面，复制后两套方案继续独立演进' },
      { kind: 'feat', text: '可以切换默认打开的 UI 方案，也能把整套方案或方案内的具体页面整理进个人文件夹' },
    ],
  },
  {
    version: '5.24.0',
    date: '2026-08-20',
    headline: '角色皮肤有自己的完整工作流了',
    changes: [
      { kind: 'feat', text: '可以从资产库或个人文件夹为母角色新建皮肤；皮肤会显示在母角色下方，也能同时整理进多个文件夹' },
      { kind: 'feat', text: '每个皮肤独立拥有立绘、美宣、三视图、定稿、反馈和出图历史，同时继承项目画风与母角色身份锚' },
      { kind: 'feat', text: '皮肤详情会显示母角色关系；角色或皮肤改名、删除时，文件夹引用和母子关系会同步维护' },
    ],
  },
  {
    version: '5.23.0',
    date: '2026-08-20',
    headline: '项目内容可以按自己的方式整理了',
    changes: [
      { kind: 'feat', text: '项目内可以新建个人文件夹，把角色、UI 页面和视频企划混合整理在一起；同一资产也能同时放进多个文件夹' },
      { kind: 'feat', text: '文件夹支持改名、备注、排序和概览/美术/UI/视频过滤；移除内容或删除文件夹都不会删除原资产和历史' },
    ],
  },
  {
    version: '5.22.0',
    date: '2026-08-20',
    headline: '一个游戏，一座完整工坊',
    changes: [
      { kind: 'feat', text: '工坊按游戏项目组织，项目内固定提供概览、美术、UI、视频四个工作区；原「出图」改名为「创作台」，自由试验与正式资产边界更清楚' },
      { kind: 'feat', text: 'UI 工作区会从策划锚、视觉规范、页面地图与定稿文件推导真实进度，并只提示当前唯一下一步' },
      { kind: 'feat', text: '新增项目视频企划与单镜头工作流：可建立 brief 和镜头表、生成镜头版本，并在视频工作区选用版本' },
    ],
  },
  {
    version: '5.21.1',
    date: '2026-08-20',
    headline: '一键启动不再把更新弄脏',
    changes: [
      { kind: 'fix', text: 'Mac 和 Windows 一键启动直接使用随项目发布的 Web 界面，不再要求 Node / pnpm，也不会在每次启动时重写 web/dist' },
      { kind: 'feat', text: '新增 Mac / Windows 一键修复：自动诊断并只还原 web/dist，再安全更新；角色资产、配置和其他本地改动都不会被清理' },
    ],
  },
  {
    version: '5.21.0',
    date: '2026-08-20',
    headline: '多角色参考图不再互相认错',
    changes: [
      { kind: 'feat', text: '立绘、美宣、三视图都能一次带多张参考图；多角色默认每个角色各带一张，场景和构图参考还能继续追加' },
      { kind: 'fix', text: '提示词会按上传顺序给每张图补一句外观或场景描述，不再只说「图一、图二」让模型自己猜' },
      { kind: 'feat', text: '新建角色时上传的现成立绘或三视图会同时备份进素材库和对应图廊，不再只拿来当头像' },
      { kind: 'feat', text: '没有立绘也能做美宣：三视图或临时上传的角色参考图都可以作为身份锚' },
    ],
  },
  {
    version: '5.20.1',
    date: '2026-08-20',
    headline: 'Codex 的 Skill 会跟着更新补齐',
    changes: [
      { kind: 'fix', text: '源码更新新增或删除 Skill 时，一键启动会自动同步 Codex 命令，不用再手动补装' },
      { kind: 'fix', text: '同步会保护其他工具管理的同名 Skill，只提示冲突，不覆盖或误删' },
    ],
  },
  {
    version: '5.20.0',
    date: '2026-08-20',
    headline: '报错说人话',
    changes: [
      {
        kind: 'fix',
        text: '出错时不再只给一句英文加状态码：现在会说清是哪一步失败、到底哪里不合规。比如参考图传不上去，会告诉你「这张图 11MB、12000×8000 像素，超过上限 10MB，请压缩或缩小长边」',
      },
      { kind: 'fix', text: '参考图被厂商拒收、尺寸不合规这两类出图失败，也翻成中文并给出该怎么改' },
      { kind: 'fix', text: '左侧名册的报错以前落在长列表末尾、屏幕上看不见（改名失败只像是没反应），现在固定在名册下方' },
      { kind: 'fix', text: '图卡「编辑」导入参考图不再弹任何提示条，槽位本身就是反馈' },
    ],
  },
  {
    version: '5.19.0',
    date: '2026-08-20',
    headline: '参考图槽位顺手了',
    changes: [
      {
        kind: 'fix',
        text: '图卡左下角的「编辑」现在按当前模式送图：常规参考图进参考堆叠，Midjourney 进垫图槽，视频首尾帧进首帧，全能参考进参考素材 —— 以前在后三种模式下导进去是看不见也发不出去的',
      },
      { kind: 'fix', text: '同一张图连点「编辑」不再叠出好几份' },
      { kind: 'feat', text: '输入框左侧的参考图和首尾帧、Midjourney 四个槽，点一下就看大图' },
      { kind: 'feat', text: '参考图 hover 会微微放大，多张时左右交替倾斜成扇形' },
    ],
  },
  {
    version: '5.18.0',
    date: '2026-08-19',
    headline: '出图台接入 Midjourney',
    changes: [
      { kind: 'feat', text: '模型里多了 Midjourney，一次出四张，四张都会入库' },
      {
        kind: 'feat',
        text: '全套参数面板：版本（v8.2 / v8.1 / v8 / v7 / v6.1 / v6 与 niji 7 / 6 / 5）、速度、风格化、混乱度、怪异度、种子、排除词、平铺',
      },
      {
        kind: 'feat',
        text: '四种参考图分槽：图片（垫图）、风格、角色、Omni，各自带权重控件，只在该槽有图时出现',
      },
      { kind: 'feat', text: '出图记录会显示这次实际用的参数串，方便复现和对照' },
      { kind: 'fix', text: '当前版本不支持的参考图槽会直接置灰，不再等到出图失败才知道' },
    ],
  },
  {
    version: '5.17.0',
    date: '2026-08-17',
    headline: '一个入口进所有工作流',
    changes: [
      {
        kind: 'feat',
        text: '新增总控命令 /game-atelier:game-atelier，说想做什么就会带到对应的工作流',
      },
    ],
  },
  {
    version: '5.16.0',
    date: '2026-08-17',
    headline: '出图记录能直接复用',
    changes: [
      { kind: 'feat', text: '图卡上可以把这次的提示词和参考图一键导入输入框，改了再出' },
      { kind: 'feat', text: '首页作品点进去会定位到它所在的那条出图记录' },
      { kind: 'fix', text: '导入后输入壳会自动展开，不用手动点开才看得见' },
    ],
  },
  {
    version: '5.15.0',
    date: '2026-08-16',
    headline: '插件有新版会主动提醒',
    changes: [{ kind: 'feat', text: '用 skill 时顺路检查插件新版本，有更新会提示' }],
  },
  {
    version: '5.14.0',
    date: '2026-08-14',
    headline: '启动与尺寸记忆的一批修复',
    changes: [
      { kind: 'fix', text: '尺寸按上次记录的选择恢复，不再因为默认值变了被改掉' },
      { kind: 'fix', text: '依赖清单变化时自动补装前端依赖，不用手动跑安装' },
      { kind: 'fix', text: '更新检查失败时会明确报出来，不再静默跳过' },
    ],
  },
];

export const CURRENT_VERSION = CHANGELOG[0].version;

/** 展示顺序固定「先新增、后修复」，不按录入顺序 —— 画师先关心多了什么能力。 */
const KIND_ORDER: ChangeKind[] = ['feat', 'fix'];

/** 把一版的改动按类型归堆。
 *
 * 版式上这一步是关键：不分组的话「新增」标签会在同一版里重复四五次，正文左缘被标签顶得
 * 参差不齐；归堆后标签只出现一次，下面的条目共用一条左缘，一眼看得出这版加了几件事。
 */
export function groupChanges(changes: ChangelogChange[]): [ChangeKind, ChangelogChange[]][] {
  return KIND_ORDER.map(
    (kind) => [kind, changes.filter((c) => c.kind === kind)] as [ChangeKind, ChangelogChange[]],
  ).filter(([, list]) => list.length > 0);
}

const SEEN_KEY = 'atelier:changelog-seen';

export function loadSeenVersion(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function saveSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, version);
  } catch {
    // 隐私模式 / 存储写满：读不到就是每次都当已读，不该因此让顶栏崩掉
  }
}

/** 是否有没读过的更新。
 *
 * 首次使用（没有任何记录）**不算未读** —— 新用户不该一进来就被历史更新日志拦住，
 * 调用方会静默把当前版本写成已读。只有「读过旧版本、之后升级了」才提示。
 */
export function hasUnreadChangelog(seen: string | null): boolean {
  return seen !== null && seen !== CURRENT_VERSION;
}
