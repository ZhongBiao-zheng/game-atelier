import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { describe, expect, it } from 'vitest';

import { WorkshopShell } from './WorkshopShell';

describe('WorkshopShell', () => {
  it('只显示稳定面包屑，不重复显示工作区标签栏', () => {
    const location = memoryLocation({
      path: '/workshop/p1/video/pv',
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

    expect(screen.getByRole('link', { name: '项目一' })).toHaveAttribute('href', '/workshop/p1/overview');
    expect(screen.getByText('视频')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('navigation', { name: '项目工作区' })).not.toBeInTheDocument();
  });
});
