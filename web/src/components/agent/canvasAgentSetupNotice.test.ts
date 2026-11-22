import { describe, expect, it } from 'vitest';
import type { CanvasAgentGenerationModel } from '@/schema/canvas';
import { canvasAgentSetupNotice } from './canvasAgentSetupNotice';

const chat = [{ alias: 'Tuzi', model: 'claude', name: 'Claude', reasoning: null }];
const image: CanvasAgentGenerationModel = { alias: 'Tuzi', model: 'seedream', name: 'Seedream', kind: 'image' };
const video: CanvasAgentGenerationModel = { alias: 'tk', model: 'seedance', name: 'Seedance', kind: 'video' };
const base = { chatModels: chat, generationModels: [image, video], mode: 'all' as const, auto: true, preferred: [] };

describe('canvasAgentSetupNotice', () => {
  it('asks to configure a chat model first', () => {
    expect(canvasAgentSetupNotice({ ...base, chatModels: [] })?.action).toBe('settings');
  });

  it('stays quiet while lists are loading or everything is usable', () => {
    expect(canvasAgentSetupNotice({ ...base, chatModels: null, generationModels: null })).toBeNull();
    expect(canvasAgentSetupNotice(base)).toBeNull();
  });

  it('video mode without any video model points to settings', () => {
    expect(canvasAgentSetupNotice({ ...base, mode: 'video', generationModels: [image] }))
      .toEqual({ text: '还没有配置视频模型', action: 'settings' });
  });

  it('video mode with only image models picked offers switching back to auto', () => {
    expect(canvasAgentSetupNotice({
      ...base, mode: 'video', auto: false, preferred: [{ alias: 'Tuzi', model: 'seedream' }],
    })).toEqual({ text: '模型偏好里没选视频模型，Agent 无法生成', action: 'auto' });
  });

  it('all mode is fine as long as one kind is picked', () => {
    expect(canvasAgentSetupNotice({
      ...base, auto: false, preferred: [{ alias: 'Tuzi', model: 'seedream' }],
    })).toBeNull();
    expect(canvasAgentSetupNotice({ ...base, auto: false })?.action).toBe('auto');
  });
});
