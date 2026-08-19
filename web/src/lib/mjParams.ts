/** Midjourney 出图参数（family=midjourney 专属）。
 *
 * MJ 的 body 里没有 size / quality 之类的字段，一切控制都在 prompt 尾部的 flag 里
 * （`--v 7 --stylize 100 --chaos 10 …`）。拼接由后端 `mj_image._append_flags` 负责，
 * 前端只管收集结构化值 —— 这样 job.prompt 保持画师原文，换到别的模型时不残留 MJ flag。
 *
 * 取值档位不是滑杆而是离散档：本仓没有 Slider 原语，而 MJ 这几个参数的实用取值本来就集中在
 * 少数几档（stylize 100 是默认、250/750 是常用的两级加强）。seed / 排除词 / 垫图权重需要
 * 精确值，走输入框。
 */
export type MjBotType = 'MID_JOURNEY' | 'NIJI_JOURNEY';
export type MjMode = 'FAST' | 'RELAX' | 'TURBO';

export interface MjParams {
  botType: MjBotType;
  mode: MjMode;
  version: string;
  stylize: number;
  chaos: number;
  weird: number;
  /** 空串 = 不发（输入框友好；MJ 的 seed 无「默认值」概念）。 */
  seed: string;
  no: string;
  tile: boolean;
  /** null = 不发。垫图权重只在有参考图时有意义。 */
  iw: number | null;
}

export const MJ_DEFAULTS: MjParams = {
  botType: 'MID_JOURNEY',
  mode: 'FAST',
  version: '8.2',
  stylize: 100,
  chaos: 0,
  weird: 0,
  seed: '',
  no: '',
  tile: false,
  iw: null,
};

export const MJ_BOT_TYPES: { value: MjBotType; label: string }[] = [
  { value: 'MID_JOURNEY', label: 'Midjourney' },
  { value: 'NIJI_JOURNEY', label: 'Niji（动漫）' },
];

// 速度档在这个协议里是 body 的 accountFilter.modes，不是 flag —— 但对画师是同一类选择，
// 所以放在同一个面板里。
export const MJ_MODES: { value: MjMode; label: string }[] = [
  { value: 'FAST', label: '快速' },
  { value: 'RELAX', label: '慢速' },
  { value: 'TURBO', label: '极速' },
];

// niji 与 Midjourney 是两套版本体系，flag 名和版本号都不通用（--v 7 vs --niji 6）。
// 后端 mj_image._version_flag 按 bot_type 决定 flag 名，这里按同一判据给档位。
export const MJ_VERSIONS = ['8.2', '8.1', '8', '7', '6.1', '6'];
export const NIJI_VERSIONS = ['7', '6', '5'];

export function versionsFor(botType: MjBotType): string[] {
  return botType === 'NIJI_JOURNEY' ? NIJI_VERSIONS : MJ_VERSIONS;
}

/** 切换模型时把版本纠到新体系里的合法值（原值合法就留着）。 */
export function normalizeVersion(botType: MjBotType, version: string): string {
  const allowed = versionsFor(botType);
  return allowed.includes(version) ? version : allowed[0];
}

export const MJ_STYLIZE_STEPS = [0, 100, 250, 500, 750, 1000];
export const MJ_CHAOS_STEPS = [0, 10, 25, 50, 100];
export const MJ_WEIRD_STEPS = [0, 250, 1000, 3000];
export const MJ_IW_STEPS = [0.5, 1, 2, 3];

/** 面板状态 → job params（键名与 schemas.py::JobParams 的 mj_* 字段一一对应）。
 *
 * version / stylize / chaos / weird 一律显式发，即使等于厂商默认值：这些参数直接决定产物
 * 外观，靠「省略等于默认」会在厂商改默认值的那天静默改掉所有出图（本仓在 Ark 的 watermark
 * 上踩过同一个坑）。seed / no / iw / tile 相反 —— 它们没有「默认值」，无值就是不该出现。
 */
export function mjParamsToJob(p: MjParams): Record<string, unknown> {
  const out: Record<string, unknown> = {
    bot_type: p.botType,
    mode: p.mode,
    mj_version: p.version,
    mj_stylize: p.stylize,
    mj_chaos: p.chaos,
    mj_weird: p.weird,
  };
  const seed = Number.parseInt(p.seed.trim(), 10);
  if (Number.isFinite(seed)) out.mj_seed = seed;
  if (p.no.trim()) out.mj_no = p.no.trim();
  if (p.tile) out.mj_tile = true;
  if (p.iw !== null) out.mj_iw = p.iw;
  return out;
}

/** job params → 面板状态（再次生成 / 编辑导入时还原画师上次的选择）。 */
export function mjParamsFromJob(params: Record<string, unknown> | undefined): MjParams {
  const p = params ?? {};
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const botType: MjBotType = p.bot_type === 'NIJI_JOURNEY' ? 'NIJI_JOURNEY' : 'MID_JOURNEY';
  return {
    botType,
    mode: p.mode === 'RELAX' || p.mode === 'TURBO' ? p.mode : 'FAST',
    // 版本要按 botType 纠：旧 job 可能存着另一套体系的版本号（如 niji job 存了 7）。
    version: normalizeVersion(botType, typeof p.mj_version === 'string' ? p.mj_version : ''),
    stylize: num(p.mj_stylize, MJ_DEFAULTS.stylize),
    chaos: num(p.mj_chaos, MJ_DEFAULTS.chaos),
    weird: num(p.mj_weird, MJ_DEFAULTS.weird),
    seed: typeof p.mj_seed === 'number' ? String(p.mj_seed) : '',
    no: typeof p.mj_no === 'string' ? p.mj_no : '',
    tile: p.mj_tile === true,
    iw: typeof p.mj_iw === 'number' ? p.mj_iw : null,
  };
}

/** 摘要按钮上的一行文字。 */
export function mjSummary(p: MjParams): string {
  const parts = [
    p.botType === 'NIJI_JOURNEY' ? `niji ${p.version}` : `v${p.version}`,
    MJ_MODES.find((m) => m.value === p.mode)?.label ?? p.mode,
    `s${p.stylize}`,
  ];
  if (p.chaos > 0) parts.push(`c${p.chaos}`);
  if (p.weird > 0) parts.push(`w${p.weird}`);
  if (p.tile) parts.push('平铺');
  return parts.join(' · ');
}
