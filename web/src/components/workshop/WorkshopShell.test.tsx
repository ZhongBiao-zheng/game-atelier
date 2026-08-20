import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { describe, expect, it } from 'vitest';

import { WorkshopShell } from './WorkshopShell';

describe('WorkshopShell', () => {
  it('从文件夹进入资产后保留显式返回路径，工作区切换也不丢上下文', () => {
    const location = memoryLocation({
      path: '/workshop/p1/video/pv?fromFolder=folder-summer&fromView=overview',
      static: false,
    });
    render(
      <Router hook={location.hook}>
        <WorkshopShell
          project={{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }}
          workspace="video"
        >
          <p>视频企划</p>
        </WorkshopShell>
      </Router>,
    );

    expect(screen.getByRole('link', { name: '返回文件夹' })).toHaveAttribute(
      'href', '/workshop/p1/folders/folder-summer/overview',
    );
    expect(screen.getByRole('link', { name: 'UI' })).toHaveAttribute(
      'href', '/workshop/p1/ui?fromFolder=folder-summer&fromView=overview',
    );
  });
});
