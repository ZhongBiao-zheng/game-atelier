import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CanvasAgentPlan } from '@/schema/canvas';
import { CanvasAgentPlanList } from './CanvasAgentPlanList';

const PLAN: CanvasAgentPlan = {
  schema_version: 1,
  updated_at: '2026-11-20T08:00:00+00:00',
  items: [
    { title: '读角色规范', status: 'completed' },
    { title: '批量出 4 张立绘', status: 'in_progress' },
    { title: '核对尺寸与透明', status: 'pending' },
  ],
};

describe('CanvasAgentPlanList', () => {
  it('列出每条待办与完成数，可收起', () => {
    render(<CanvasAgentPlanList plan={PLAN} running />);
    expect(screen.getByRole('button', { name: /待办\s*1\/3/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listitem', { name: '读角色规范：已完成' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '批量出 4 张立绘：进行中' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '核对尺寸与透明：未开始' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /待办/ }));
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByRole('button', { name: /待办/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('进行中的那条只在这一轮运行时转圈', () => {
    const { container, rerender } = render(<CanvasAgentPlanList plan={PLAN} running />);
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
    rerender(<CanvasAgentPlanList plan={PLAN} running={false} />);
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0);
  });

  it('没有待办时不占位置', () => {
    const { container, rerender } = render(<CanvasAgentPlanList plan={null} running={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CanvasAgentPlanList plan={{ ...PLAN, items: [] }} running={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
