import { describe, expect, it } from 'vitest';

import type { KeyView } from '@/api/keys';
import type { GenerationRecipe, RecipeInput } from '@/schema/creationAssets';
import type { Job } from '@/schema/jobs';
import { configForJob, isOmniVideoConfig } from './studioJobConfig';
import { recipeToDraft, resolveRecipeModel } from './studioRecipe';

function key(alias: string, provider: string, modelIds: string[]): KeyView {
  return {
    alias,
    provider,
    base_url: null,
    access_key: '***',
    secret_key: null,
    capabilities: [],
    models: modelIds.map((id) => ({ id, name: `${id} 名` })),
    notes: '',
    created_at: '2026-09-01T00:00:00Z',
  };
}

function recipe(overrides: Partial<GenerationRecipe> = {}): GenerationRecipe {
  return {
    mode: 'image',
    model: 'gpt-image-2',
    provider: 'openai',
    alias: 'work',
    final_prompt: '一只橘猫',
    draft_prompt: null,
    params: {},
    inputs: [],
    cost_cny: 0.21,
    cost_basis: 'actual',
    submitted_at: '2026-09-20T10:00:00Z',
    ...overrides,
  };
}

function input(order: number, role: RecipeInput['role'], kind: RecipeInput['kind'] = 'image'): RecipeInput {
  return { order, role, kind, sha256: String(order).padStart(64, 'a'), mime_type: `${kind}/x` };
}

function jobFor(r: GenerationRecipe, alias: string | null, provider: string | null): Job {
  return {
    job_id: 'recipe',
    character_id: '',
    prompt: r.final_prompt,
    submitted_at: r.submitted_at,
    model: r.model,
    params: r.params,
    output_paths: [],
    status: 'done',
    error: null,
    kind: r.mode,
    namespace: 'studio',
    alias,
    provider,
  };
}

describe('resolveRecipeModel', () => {
  it('同 provider + 同 alias 优先', () => {
    const keys = [
      key('other', 'tuzi', ['gpt-image-2']),
      key('backup', 'openai', ['gpt-image-2']),
      key('work', 'openai', ['gpt-image-2']),
    ];
    expect(resolveRecipeModel(recipe(), keys)).toEqual({ alias: 'work', model: 'gpt-image-2' });
  });

  it('alias 不同时取同 provider', () => {
    const keys = [key('other', 'tuzi', ['gpt-image-2']), key('mine', 'openai', ['gpt-image-2'])];
    expect(resolveRecipeModel(recipe(), keys)).toEqual({ alias: 'mine', model: 'gpt-image-2' });
  });

  it('同 alias 但 provider 不同不算第一级', () => {
    const keys = [key('work', 'tuzi', ['gpt-image-2']), key('mine', 'openai', ['gpt-image-2'])];
    expect(resolveRecipeModel(recipe(), keys)).toEqual({ alias: 'mine', model: 'gpt-image-2' });
  });

  it('没有同 provider 时取任意含该模型 id 的 key', () => {
    const keys = [key('a', 'openai', ['dall-e-3']), key('b', 'tuzi', ['gpt-image-2'])];
    expect(resolveRecipeModel(recipe(), keys)).toEqual({ alias: 'b', model: 'gpt-image-2' });
  });

  it('同 provider + 同 alias 但没有该模型时不匹配', () => {
    const keys = [key('work', 'openai', ['dall-e-3'])];
    expect(resolveRecipeModel(recipe(), keys)).toBeNull();
  });

  it('按模型 id 匹配，不按模型名', () => {
    const keys = [{ ...key('work', 'openai', []), models: [{ id: 'x', name: 'gpt-image-2' }] }];
    expect(resolveRecipeModel(recipe(), keys)).toBeNull();
    expect(resolveRecipeModel(recipe(), [])).toBeNull();
  });
});

describe('recipeToDraft', () => {
  it('图片配方还原 size / quality / n，与 configForJob 同一 synthetic Job 一致', () => {
    const r = recipe({ params: { size_mode: 'custom', size: '1536x1024', quality: 'high', n: 3, ratio: '3:2' } });
    const keys = [key('work', 'openai', ['gpt-image-2'])];
    const draft = recipeToDraft(r, keys);
    expect(draft.model).toEqual({ alias: 'work', model: 'gpt-image-2' });
    expect(draft.config).toEqual(configForJob(jobFor(r, 'work', 'openai'), keys));
    expect(draft.config).toMatchObject({
      kind: 'image',
      prompt: '一只橘猫',
      model: 'gpt-image-2',
      alias: 'work',
      modelName: 'gpt-image-2 名',
      size: '1536x1024',
      sizeMode: 'custom',
      quality: 'high',
      n: 3,
    });
  });

  it('MJ 配方还原 MJ 参数', () => {
    const r = recipe({
      model: 'mj_fast_imagine',
      provider: 'tuzi',
      alias: 'mj',
      params: { ratio: '4:3', mj_version: '7', mj_stylize: 250, mj_chaos: 10, bot_type: 'MID_JOURNEY', mode: 'RELAX' },
    });
    const keys = [key('mj', 'tuzi', ['mj_fast_imagine'])];
    const draft = recipeToDraft(r, keys);
    const expected = configForJob(jobFor(r, 'mj', 'tuzi'), keys);
    expect(draft.config.mjParams).toEqual(expected.mjParams);
    expect(draft.config.mjParams).toMatchObject({ stylize: 250, chaos: 10, mode: 'RELAX' });
    expect(draft.config.ratio).toBe('4:3');
    expect(draft.config.mjRefPaths).toEqual({ sref: [], cref: [], oref: [] });
  });

  it('视频配方还原 duration / frameMode / videoResolution', () => {
    const r = recipe({
      mode: 'video',
      model: 'doubao-seedance-2-0-260128',
      provider: 'volces',
      alias: 'ark',
      params: { duration: 8, frame_mode: 'firstlast', resolution: '1080p', ratio: '16:9', generate_audio: true },
    });
    const keys = [key('ark', 'volces', ['doubao-seedance-2-0-260128'])];
    const draft = recipeToDraft(r, keys);
    expect(draft.config).toEqual(configForJob(jobFor(r, 'ark', 'volces'), keys));
    expect(draft.config).toMatchObject({
      kind: 'video',
      duration: 8,
      frameMode: 'firstlast',
      videoResolution: '1080p',
      ratio: '16:9',
      generateAudio: true,
    });
  });

  it('视频配方 frame_mode auto + 视频参考：保留 auto，按输入数量判为全能参考', () => {
    const r = recipe({
      mode: 'video',
      model: 'doubao-seedance-2-0-260128',
      provider: 'volces',
      alias: 'ark',
      params: { duration: 5, frame_mode: 'auto' },
      inputs: [input(0, 'reference', 'image'), input(1, 'reference', 'video')],
    });
    const draft = recipeToDraft(r, [key('ark', 'volces', ['doubao-seedance-2-0-260128'])]);
    expect(draft.config.frameMode).toBe('auto');
    expect(draft.config.referenceVideos).toEqual([]);
    expect(draft.inputs.images.map((item) => item.order)).toEqual([0]);
    expect(draft.inputs.videos.map((item) => item.order)).toEqual([1]);
    const counts = {
      images: draft.inputs.images.length,
      videos: draft.inputs.videos.length,
      audios: draft.inputs.audios.length,
    };
    expect(isOmniVideoConfig(draft.config.frameMode, counts)).toBe(true);
  });

  it('inputs 按 role 与 kind 分组，组内按 order 升序', () => {
    const r = recipe({
      inputs: [
        input(5, 'reference', 'image'),
        input(1, 'reference', 'image'),
        input(3, 'reference', 'video'),
        input(2, 'reference', 'audio'),
        input(0, 'reference', 'video'),
        input(6, 'mj_sref'),
        input(4, 'mj_cref'),
        input(7, 'mj_oref'),
      ],
    });
    const { inputs } = recipeToDraft(r, []);
    expect(inputs.images.map((item) => item.order)).toEqual([1, 5]);
    expect(inputs.videos.map((item) => item.order)).toEqual([0, 3]);
    expect(inputs.audios.map((item) => item.order)).toEqual([2]);
    expect(inputs.mj.sref.map((item) => item.order)).toEqual([6]);
    expect(inputs.mj.cref.map((item) => item.order)).toEqual([4]);
    expect(inputs.mj.oref.map((item) => item.order)).toEqual([7]);
  });

  it('mask 输入不带入，并加一条 warning', () => {
    const r = recipe({ params: { warnings: ['尺寸已归一化'] }, inputs: [input(0, 'reference'), input(1, 'mask')] });
    const draft = recipeToDraft(r, []);
    expect(draft.inputs.images.map((item) => item.order)).toEqual([0]);
    expect(draft.config.warnings).toEqual(['尺寸已归一化', '遮罩参考未带入']);
    expect(recipeToDraft(recipe(), []).config.warnings).toEqual([]);
  });

  it('config 的参考路径字段为空', () => {
    const image = recipeToDraft(recipe({
      model: 'mj_fast_imagine',
      params: { reference_images: ['a.png'], mj_sref: ['s.png'], mj_cref: ['c.png'], mj_oref: ['o.png'] },
    }), []);
    expect(image.config.referenceImages).toEqual([]);
    expect(image.config.mjRefPaths).toEqual({ sref: [], cref: [], oref: [] });
    const video = recipeToDraft(recipe({
      mode: 'video',
      model: 'doubao-seedance-2-0-260128',
      params: { reference_images: ['a.png'], reference_videos: ['v.mp4'], reference_audios: ['a.mp3'] },
    }), []);
    expect(video.config.referenceImages).toEqual([]);
    expect(video.config.referenceVideos).toEqual([]);
    expect(video.config.referenceAudios).toEqual([]);
  });

  it('缺模型：model 为 null，config 保留配方模型 id、不带 alias 与 provider', () => {
    const draft = recipeToDraft(recipe(), [key('work', 'openai', ['dall-e-3'])]);
    expect(draft.model).toBeNull();
    expect(draft.config.model).toBe('gpt-image-2');
    expect(draft.config.alias).toBeNull();
    expect(draft.config.provider).toBeNull();
    expect(draft.config.modelName).toBeUndefined();
  });

  it('跨 provider 匹配时 config 用本机 key 的 alias 与 provider', () => {
    const draft = recipeToDraft(recipe(), [key('b', 'tuzi', ['gpt-image-2'])]);
    expect(draft.config).toMatchObject({ alias: 'b', provider: 'tuzi', modelName: 'gpt-image-2 名' });
  });
});
