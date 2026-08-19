import { describe, expect, it } from 'vitest';

import {
  MJ_DEFAULTS,
  mjParamsFromJob,
  mjParamsToJob,
  mjSummary,
  normalizeVersion,
  versionsFor,
  type MjParams,
} from './mjParams';

describe('mjParamsToJob', () => {
  it('决定产物外观的参数一律显式发，即使等于厂商默认值', () => {
    // 「省略等于默认」会在厂商改默认值那天静默改掉所有出图（本仓在 Ark 的 watermark 上踩过）。
    const out = mjParamsToJob(MJ_DEFAULTS);
    expect(out).toMatchObject({
      bot_type: 'MID_JOURNEY',
      mode: 'FAST',
      mj_version: '8.2',
      mj_stylize: 100,
      mj_chaos: 0,
      mj_weird: 0,
    });
  });

  it('没有默认值概念的参数无值就不发', () => {
    const out = mjParamsToJob(MJ_DEFAULTS);
    expect(out).not.toHaveProperty('mj_seed');
    expect(out).not.toHaveProperty('mj_no');
    expect(out).not.toHaveProperty('mj_iw');
    expect(out).not.toHaveProperty('mj_tile');
  });

  it('给了值就发，seed 走整数、no 去空白', () => {
    const out = mjParamsToJob({
      ...MJ_DEFAULTS,
      seed: '12345',
      no: '  text, watermark  ',
      tile: true,
      iw: 1.5,
    });
    expect(out.mj_seed).toBe(12345);
    expect(out.mj_no).toBe('text, watermark');
    expect(out.mj_tile).toBe(true);
    expect(out.mj_iw).toBe(1.5);
  });

  it('seed 是非数字文本时不发（输入框可能留着半截内容）', () => {
    expect(mjParamsToJob({ ...MJ_DEFAULTS, seed: 'abc' })).not.toHaveProperty('mj_seed');
    expect(mjParamsToJob({ ...MJ_DEFAULTS, seed: '   ' })).not.toHaveProperty('mj_seed');
  });

  it('tile=false 不发 —— flag 是开关，关就是不加', () => {
    expect(mjParamsToJob({ ...MJ_DEFAULTS, tile: false })).not.toHaveProperty('mj_tile');
  });
});

describe('mjParamsFromJob', () => {
  it('往返不丢：面板 → job params → 面板', () => {
    const original: MjParams = {
      botType: 'NIJI_JOURNEY',
      mode: 'TURBO',
      version: '7', // niji 体系的合法版本；填 MJ 的版本号会被纠正，那是另一条用例在管
      stylize: 750,
      chaos: 25,
      weird: 1000,
      seed: '999',
      no: 'blur',
      tile: true,
      iw: 2,
    };
    expect(mjParamsFromJob(mjParamsToJob(original))).toEqual(original);
  });

  it('旧 job / 空 params 回落到默认值', () => {
    expect(mjParamsFromJob(undefined)).toEqual(MJ_DEFAULTS);
    expect(mjParamsFromJob({})).toEqual(MJ_DEFAULTS);
  });

  it('脏数据不污染面板状态', () => {
    const restored = mjParamsFromJob({
      bot_type: 'WHATEVER',
      mode: 'std', // kling 的档位落到 MJ 字段上
      mj_stylize: 'high',
      mj_chaos: null,
      mj_version: '',
    });
    expect(restored.botType).toBe('MID_JOURNEY');
    expect(restored.mode).toBe('FAST');
    expect(restored.stylize).toBe(MJ_DEFAULTS.stylize);
    expect(restored.chaos).toBe(MJ_DEFAULTS.chaos);
    expect(restored.version).toBe(MJ_DEFAULTS.version);
  });
});

describe('版本体系随模型切换', () => {
  it('两套版本档位不通用', () => {
    expect(versionsFor('MID_JOURNEY')).toEqual(['8.2', '8.1', '8', '7', '6.1', '6']);
    expect(versionsFor('NIJI_JOURNEY')).toEqual(['7', '6', '5']);
  });

  it('切到 niji 时把不合法的版本纠到 niji 的首档', () => {
    // 留着 7 会让后端拼出 `--niji 7` —— 一个不存在的组合。
    expect(normalizeVersion('NIJI_JOURNEY', '6.1')).toBe('7'); // 6.1 只有 MJ 有
    expect(normalizeVersion('NIJI_JOURNEY', '6')).toBe('6');   // 6 两边都有，留着
    expect(normalizeVersion('MID_JOURNEY', '5')).toBe('8.2');  // 5 只有 niji 有
    expect(normalizeVersion('MID_JOURNEY', '8.1')).toBe('8.1');
  });

  it('从 job 还原时也按 botType 纠版本（旧 job 可能存着另一套的版本号）', () => {
    const restored = mjParamsFromJob({ bot_type: 'NIJI_JOURNEY', mj_version: '6.1' });
    expect(restored.version).toBe('7');
  });
});

describe('mjSummary', () => {
  it('默认态只显示模型版本 / 速度档 / 风格化', () => {
    expect(mjSummary(MJ_DEFAULTS)).toBe('v8.2 · 快速 · s100');
  });

  it('niji 与非零的 chaos / weird / tile 才出现在摘要里', () => {
    const s = mjSummary({
      ...MJ_DEFAULTS,
      botType: 'NIJI_JOURNEY',
      version: '7',
      mode: 'RELAX',
      chaos: 10,
      weird: 250,
      tile: true,
    });
    expect(s).toBe('niji 7 · 慢速 · s100 · c10 · w250 · 平铺');
  });
});
