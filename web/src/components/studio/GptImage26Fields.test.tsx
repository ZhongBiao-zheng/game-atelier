import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GptImage26Fields, gifSummary } from './GptImage26Fields';
import { imageControlCaps } from '@/lib/imageControlCaps';
import type { JobParams } from '@/schema/jobs';

function Harness({ model, hasReferences = false }: { model: string; hasReferences?: boolean }) {
  const [params, setParams] = useState<JobParams>({});
  return <>
    <output>{JSON.stringify(params)}</output>
    <GptImage26Fields caps={imageControlCaps(model, 'openai')} params={params} hasReferences={hasReferences}
      onPatch={patch => setParams(current => ({ ...current, ...patch }))} />
  </>;
}

describe('GptImage26Fields', () => {
  it('renders nothing for models without the capabilities', () => {
    render(<Harness model="gpt-image-2.5-flare" />);
    expect(screen.queryByRole('radiogroup', { name: '选择规划强度' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '选择输出格式' })).toBeNull();
  });

  it('writes complexity and GIF frame settings into params', () => {
    render(<Harness model="gpt-image-2.6-flare" />);
    expect(screen.getByRole('radio', { name: '高' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: '低' }));
    expect(JSON.parse(screen.getByRole('status').textContent ?? '{}')).toMatchObject({ complexity: 'low' });

    fireEvent.click(screen.getByRole('radio', { name: 'GIF' }));
    let params = JSON.parse(screen.getByRole('status').textContent ?? '{}');
    expect(params).toMatchObject({ output_format: 'gif', frame_count: 9, frame_duration_ms: 200 });

    fireEvent.change(screen.getByLabelText('帧数'), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText('帧间隔 ms'), { target: { value: '5' } });
    params = JSON.parse(screen.getByRole('status').textContent ?? '{}');
    expect(params).toMatchObject({ frame_count: 64, frame_duration_ms: 20 });
    expect(gifSummary(params)).toBe('GIF 64 帧 · 20ms');

    fireEvent.click(screen.getByRole('radio', { name: '图片' }));
    params = JSON.parse(screen.getByRole('status').textContent ?? '{}');
    expect(params.output_format).toBeUndefined();
    expect(gifSummary(params)).toBeNull();
  });

  it('disables GIF while reference images are attached', () => {
    render(<Harness model="gpt-image-2.6-sunburst" hasReferences />);
    expect(screen.getByRole('radio', { name: 'GIF' })).toBeDisabled();
  });
});
