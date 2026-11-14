import { describe, expect, it } from 'vitest';
import cases from '../../../tests/fixtures/audio_caps_cases.json';
import { AUDIO_CAPS, audioProtocolOf, normalizeSpeechParams } from './audioCaps';

// 与 tests/test_audio_speech.py 读同一份夹具：协议解析与参数归一两端必须逐条同义。
describe('shared Python / TypeScript audio capabilities', () => {
  it.each(cases.protocol)('$model_id ($protocol) → $expected', ({ provider, model_id, protocol, expected }) => {
    expect(audioProtocolOf(model_id, provider, protocol)).toBe(expected);
  });

  it.each(cases.normalize)('normalizes $protocol params', ({ protocol, params, expected }) => {
    expect(normalizeSpeechParams(AUDIO_CAPS[protocol], params)).toEqual(expected);
  });
});
