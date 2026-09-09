import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImageSizeFields } from './ImageSizeFields';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { imageSizeError, imageSizeSummary, normalizeImageSizeParams, prepareImageSizeSubmission } from '@/lib/imageSizeMode';
import { normalizeImagePixelSize } from '@/lib/studioSize';
import type { JobParams } from '@/schema/jobs';

function Harness({ baseUrl }: { baseUrl?: string } = {}) {
  const [params, setParams] = useState<JobParams>({ size_mode: 'ratio', ratio: '2:3', size: '1360x2048' });
  return <><output>{imageSizeSummary(params)}</output><ImageSizeFields caps={imageControlCaps('gpt-image-2', 'openai', baseUrl)}
    model="gpt-image-2" baseUrl={baseUrl} params={params}
    onPatch={patch => setParams(current => normalizeImageSizeParams('gpt-image-2', 'openai', baseUrl, { ...current, ...patch }))} /></>;
}

describe('image size intent', () => {
  it('shows all Tuzi Nano ratios and emits the selected ratio without custom pixels', () => {
    const onPatch = vi.fn();
    render(<ImageSizeFields model="nano-banana-pro" caps={imageControlCaps('nano-banana-pro', 'custom', 'https://api.tu-zi.com')}
      params={{ ratio: '1:1' }} onPatch={onPatch} />);
    expect(screen.getAllByRole('option')).toHaveLength(10);
    for (const ratio of ['4:5', '5:4', '21:9']) {
      fireEvent.click(screen.getByRole('option', { name: ratio }));
      expect(onPatch).toHaveBeenLastCalledWith({ size_mode: 'ratio', ratio, size: undefined });
    }
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
  });
  it('offers OpenRouter resolution tiers without silently picking a billed tier', () => {
    const model = 'google/gemini-3.1-flash-image-preview';
    const onPatch = vi.fn();
    render(<ImageSizeFields model={model} caps={imageControlCaps(model, 'openrouter', 'https://openrouter.ai')}
      params={{ ratio: '1:1' }} onPatch={onPatch} />);
    expect(screen.getByRole('option', { name: '默认' })).toHaveAttribute('aria-selected', 'true');
    for (const value of ['1:8', '8:1', '512', '1K', '2K', '4K']) expect(screen.getByRole('option', { name: value })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '512' }));
    expect(onPatch).toHaveBeenLastCalledWith({ resolution: '512', size: undefined });
    fireEvent.click(screen.getByRole('option', { name: '默认' }));
    expect(onPatch).toHaveBeenLastCalledWith({ resolution: undefined, size: undefined });
  });
  it.each([
    ['openai', null, 'gpt-image-2'],
    ['custom', 'https://api.tu-zi.com/v1', 'gpt-image-2'],
    ['custom', 'https://api.openai-hk.com', 'gpt-image-2'],
    ['openrouter', 'https://openrouter.ai/api/v1', 'openai/gpt-image-2.5-flare'],
  ])('defaults fresh drafts to AUTO for %s / %s', (provider, baseUrl, model) => {
    expect(normalizeImageSizeParams(model!, provider, baseUrl, { n: 2 })).toMatchObject({
      size_mode: 'auto', size: 'auto', n: 2,
    });
    expect(prepareImageSizeSubmission(model!, provider, baseUrl, { n: 2 })).toEqual({
      params: { size_mode: 'auto', size: 'auto', n: 2 },
    });
  });
  it('keeps unsupported models and explicit saved sizing on their existing rule', () => {
    expect(normalizeImageSizeParams('nano-banana-pro', 'custom', 'https://api.tu-zi.com', {}))
      .toMatchObject({ size_mode: 'ratio', ratio: '1:1' });
    for (const params of [{ ratio: '2:3' }, { size: '1024x1536' }, { resolution: '2K' }]) {
      expect(normalizeImageSizeParams('gpt-image-2', 'openai', null, params).size_mode).toBe('ratio');
    }
  });
  it.each(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'])('accepts Tuzi AUTO for %s without inactive dimensions', model => {
    expect(imageControlCaps(model, 'custom', 'https://api.tu-zi.com/v1').showAutoSize).toBe(true);
    expect(prepareImageSizeSubmission(model, 'custom', 'https://api.tu-zi.com/v1', {
      size_mode: 'auto', size: '1360x2048', ratio: '2:3', resolution: '2K', custom_size: '1360x2048',
    }).params).toEqual({ size_mode: 'auto', size: 'auto' });
  });
  it.each(['gpt-image-2-vip', 'gpt-image-2-1k', 'nano-banana-pro'])('does not infer AUTO for Tuzi alias %s', model => {
    expect(imageControlCaps(model, 'custom', 'https://api.tu-zi.com/v1').showAutoSize).toBe(false);
  });
  it('offers Tuzi AUTO in the shared controls and retains its custom draft', () => {
    render(<Harness baseUrl="https://api.tu-zi.com/v1" />);
    fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '1024' } });
    fireEvent.click(screen.getByRole('option', { name: 'AUTO' }));
    expect(screen.getByRole('status')).toHaveTextContent('AUTO');
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '自定义' }));
    expect(screen.getByLabelText('输出宽度')).toHaveValue(1024);
    expect(imageControlCaps('gpt-image-2', 'custom', 'https://tu-zi.com.example/v1').showAutoSize).toBe(false);
  });
  it('prepares only the active submission rule and rejects unsupported or invalid intent', () => {
    expect(prepareImageSizeSubmission('gpt-image-2', 'openai', null,
      { size_mode: 'auto', ratio: '2:3', resolution: '2K', custom_size: '1024x1024' }).params)
      .toEqual({ size_mode: 'auto', size: 'auto' });
    expect(prepareImageSizeSubmission('gpt-image-2', 'custom', 'https://api.openai-hk.com',
      { size_mode: 'custom', size: '1360x2048', ratio: '2:3', resolution: '2K' }).params)
      .toEqual({ size_mode: 'custom', size: '1376x2064' });
    expect(prepareImageSizeSubmission('gpt-image-2', 'custom', 'https://unknown.example', { size_mode: 'auto' }).error).toBeTruthy();
    expect(prepareImageSizeSubmission('gpt-image-2', 'openai', null, { size_mode: 'custom', size: 'x2048' }).error).toBeTruthy();
  });
  it('does not snap dimensions while moving between width and height', () => {
    render(<Harness baseUrl="https://api.openai-hk.com" />);
    const width = screen.getByLabelText('输出宽度');
    const height = screen.getByLabelText('输出高度');
    fireEvent.change(width, { target: { value: '1024' } });
    fireEvent.blur(width, { relatedTarget: height });
    expect(width).toHaveValue(1024);
    expect(height).toHaveValue(2048);
    fireEvent.change(height, { target: { value: '1024' } });
    fireEvent.blur(height);
    expect(width).toHaveValue(1024);
    expect(height).toHaveValue(1024);
    expect(imageSizeError({ size_mode: 'custom', size: '100x1000' }, 'gpt-image-2')).not.toBeNull();
  });
  it('selects custom only on editing, preserves exact intent and restores its draft across AUTO and presets', () => {
    render(<Harness />);
    const width = screen.getByLabelText('输出宽度');
    fireEvent.focus(width);
    expect(screen.getByRole('option', { name: '2:3' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(width, { target: { value: '1024' } });
    expect(screen.getByRole('option', { name: '自定义' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '2:3' })).toHaveAttribute('aria-selected', 'false');
    fireEvent.change(screen.getByLabelText('输出高度'), { target: { value: '1536' } });
    fireEvent.blur(screen.getByLabelText('输出高度'));
    expect(screen.getByRole('status')).toHaveTextContent('1024×1536');
    fireEvent.click(screen.getByRole('option', { name: 'AUTO' }));
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('AUTO');
    fireEvent.click(screen.getByRole('option', { name: '1:1' }));
    expect(screen.getByLabelText('输出宽度')).toHaveValue(2048);
    fireEvent.click(screen.getByRole('option', { name: '自定义' }));
    expect(screen.getByLabelText('输出宽度')).toHaveValue(1024);
    expect(screen.getByLabelText('输出高度')).toHaveValue(1536);
  });

  it('keeps incomplete input visible and invalid instead of silently restoring an old size', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '' } });
    fireEvent.blur(screen.getByLabelText('输出宽度'));
    expect(screen.getByLabelText('输出宽度')).toHaveValue(null);
    expect(screen.getByRole('alert')).toHaveTextContent('整数');
    expect(imageSizeError({ size_mode: 'custom', size: 'x2048' })).not.toBeNull();
  });

  it('only offers AUTO for verified models and channels, and previews HK submission sizes', () => {
    expect(imageControlCaps('gpt-image-2', 'custom', 'https://api.openai-hk.com').showAutoSize).toBe(true);
    expect(imageControlCaps('gpt-image-2', 'custom', 'https://api.tu-zi.com').showAutoSize).toBe(true);
    expect(imageControlCaps('openai/gpt-image-2.5-flare', 'openrouter', 'https://openrouter.ai/api/v1').showAutoSize).toBe(true);
    expect(imageControlCaps('openai/gpt-image-2.5-flare', 'openrouter', 'https://unknown.test').showAutoSize).toBe(false);
    expect(imageControlCaps('unknown', 'openai').showAutoSize).toBe(false);
    expect(normalizeImagePixelSize('1360x2048', 'gpt-image-2', 'https://api.openai-hk.com')).toBe('1376x2064');
    expect(normalizeImagePixelSize('1360x2048', 'gpt-image-2', 'https://api.tu-zi.com')).toBe('1360x2048');
  });
});
