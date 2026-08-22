import { describe, expect, it } from 'vitest';

import type { Job } from '@/schema/jobs';
import type { RoundState } from '@/components/studio/RoundList';
import { deriveGenMode, filterRounds, DEFAULT_HISTORY_FILTERS } from './historyFilters';

function job(p: Partial<Job>): Job {
  return {
    job_id: 'j', character_id: 'c', prompt: '', submitted_at: '2026-06-16T00:00:00Z',
    model: 'm', params: {}, output_paths: [], status: 'done',
    error: null, asset_slot: 'portrait', kind: 'image', namespace: 'studio',
    source_image: null, alias: null, provider: null, retry_of: null, progress_phase: null,
    ...p,
  } as Job;
}

describe('deriveGenMode', () => {
  it('非 studio namespace → skill（不分资产类型）', () => {
    expect(deriveGenMode(job({ namespace: 'character', kind: 'image' }))).toBe('skill');
    expect(deriveGenMode(job({ namespace: 'ui', kind: 'image' }))).toBe('skill');
    expect(deriveGenMode(job({ namespace: 'video', kind: 'video' }))).toBe('skill');
  });
  it('Studio 归档副本沿用原媒体模式，不冒充 Skill 产物', () => {
    expect(deriveGenMode(job({
      namespace: 'character',
      kind: 'image',
      params: { archived_from_job_id: 'studio-image' },
    }))).toBe('image');
    expect(deriveGenMode(job({
      namespace: 'video',
      kind: 'video',
      params: { archived_from_job_id: 'studio-video' },
    }))).toBe('video');
  });
  it('studio video → video', () => {
    expect(deriveGenMode(job({ namespace: 'studio', kind: 'video' }))).toBe('video');
  });
  it('studio image → image', () => {
    expect(deriveGenMode(job({ namespace: 'studio', kind: 'image' }))).toBe('image');
  });
});

function doneRound(p: Partial<Extract<RoundState, { kind: 'done' }>>): RoundState {
  return {
    kind: 'done', jobId: 'j', submittedAt: '2026-06-16T00:00:00Z',
    imagePaths: ['studio/j/v1.png'], mode: 'image',
    config: { prompt: 'a dragon', model: 'm', referenceImages: [] },
    ...p,
  };
}

describe('filterRounds', () => {
  const favs = ['studio/j/v1.png'];
  const hidden = ['studio/h/v1.png'];

  it('默认放行全部', () => {
    const rounds = [doneRound({}), doneRound({ jobId: 'k' })];
    expect(filterRounds(rounds, DEFAULT_HISTORY_FILTERS, favs, hidden)).toHaveLength(2);
  });
  it('搜索按 prompt 子串（大小写不敏感）', () => {
    const rounds = [doneRound({ config: { prompt: 'A Dragon', model: 'm', referenceImages: [] } })];
    expect(filterRounds(rounds, { ...DEFAULT_HISTORY_FILTERS, search: 'dragon' }, favs, hidden)).toHaveLength(1);
    expect(filterRounds(rounds, { ...DEFAULT_HISTORY_FILTERS, search: 'cat' }, favs, hidden)).toHaveLength(0);
  });
  it('modes 用 OR 语义保留所有已选生成模式', () => {
    const rounds = [
      doneRound({ jobId: 'i', mode: 'image' }),
      doneRound({ jobId: 'v', mode: 'video' }),
      doneRound({ jobId: 's', mode: 'skill' }),
    ];
    const out = filterRounds(
      rounds,
      { ...DEFAULT_HISTORY_FILTERS, modes: ['image', 'video'] },
      favs,
      hidden,
    );
    expect(out.map((round) => round.mode)).toEqual(['image', 'video']);
  });
  it('op=favorite 只留含收藏图的轮', () => {
    const rounds = [doneRound({ imagePaths: ['studio/j/v1.png'] }), doneRound({ jobId: 'k', imagePaths: ['studio/x/v1.png'] })];
    const out = filterRounds(rounds, { ...DEFAULT_HISTORY_FILTERS, op: 'favorite' }, favs, hidden);
    expect(out).toHaveLength(1);
    expect((out[0] as { jobId: string }).jobId).toBe('j');
  });
  it('op=favorite 排除无产物的 pending 轮', () => {
    const pending: RoundState = { kind: 'pending', startedAt: Date.parse('2026-06-16T00:00:00Z'), mode: 'image', config: { prompt: 'x', model: 'm', referenceImages: [] } };
    expect(filterRounds([pending], { ...DEFAULT_HISTORY_FILTERS, op: 'favorite' }, favs, hidden)).toHaveLength(0);
  });
});
