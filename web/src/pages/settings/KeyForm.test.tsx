import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { KeyForm } from './KeyForm';

describe('KeyForm 视频协议', () => {
  it('视频模型行渲染协议下拉，图片模型行不渲染', () => {
    render(
      <KeyForm
        initial={{
          alias: 'cu',
          provider: 'custom',
          base_url: 'https://api.example.com/v1',
          access_key: '***',
          secret_key: null,
          capabilities: [],
          notes: '',
          models: [
            { name: '视频', id: 'foo-vid', modality: 'video' },
            { name: '图片', id: 'foo-img', modality: 'image' },
          ],
        }}
        onCreated={() => {}}
        onCancel={() => {}}
        mode="edit"
      />,
    );
    // 行 1 是视频模型 → 协议下拉存在；行 2 是图片模型 → 不渲染协议下拉
    expect(screen.getByLabelText(/视频协议 1/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/视频协议 2/)).not.toBeInTheDocument();
  });
});
