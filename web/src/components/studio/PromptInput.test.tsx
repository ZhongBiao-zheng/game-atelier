import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { PromptInput } from './PromptInput';
import type { KeyView } from '@/api/keys';

const hkKey: KeyView = {
  alias: 'hk',
  provider: 'custom',
  base_url: 'https://api.openai-hk.com',
  access_key: 'hk...key',
  secret_key: null,
  capabilities: ['portrait'],
  models: [
    { name: 'GPT Image 2', id: 'gpt-image-2' },
    { name: 'Nano Banana', id: 'nano-banana' },
  ],
  notes: '',
  created_at: '2026-05-25T00:00:00Z',
  is_default: true,
};

function renderWith(model: string) {
  return render(
    <PromptInput
      onSubmit={vi.fn()}
      providers={[hkKey]}
      providerAlias="hk"
      model={model}
    />,
  );
}

describe('PromptInput 尺寸面板按模型族渲染', () => {
  it('gpt-image: 显示自定义尺寸 + 质量，不显示分辨率', () => {
    renderWith('gpt-image-2');
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByLabelText('输出宽度')).toBeInTheDocument();
    expect(screen.getByLabelText('选择质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    cleanup();
  });

  it('nano-banana: 仅显示质量，不显示分辨率/自定义尺寸', () => {
    renderWith('nano-banana');
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByLabelText('选择质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
    cleanup();
  });
});
