import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasAgentApproval } from '@/schema/canvas';
import { CanvasAgentApprovalCard } from './CanvasAgentApprovalCard';

const approval = (call_id: string, tool: string, summary: string): CanvasAgentApproval => ({
  call_id, tool, summary, arguments: '{}',
});
const LABELS = { apply_changes: '修改画布', run_generation: '生成' };

describe('CanvasAgentApprovalCard', () => {
  it('executes only the checked calls and rejects the rest', () => {
    const onDecide = vi.fn();
    render(<CanvasAgentApprovalCard labels={LABELS} onDecide={onDecide} approvals={[
      approval('c1', 'apply_changes', 'add_surface 猫'),
      approval('c2', 'run_generation', '在节点 cat-1 上生成 1 个结果\nseedream · 预计 12.5¥'),
    ]} />);
    expect(screen.getByText(/预计 12.5¥/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '执行：生成' }));
    fireEvent.click(screen.getByRole('button', { name: '执行 1 项' }));
    expect([...onDecide.mock.calls[0][0]]).toEqual(['c1']);
  });

  it('rejects everything and cannot execute an empty selection', () => {
    const onDecide = vi.fn();
    render(<CanvasAgentApprovalCard labels={LABELS} onDecide={onDecide} approvals={[
      approval('c1', 'apply_changes', 'a'), approval('c2', 'apply_changes', 'b'),
    ]} />);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    expect(screen.getByRole('button', { name: '执行 0 项' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect([...onDecide.mock.calls[0][0]]).toEqual([]);
  });

  it('keeps a single call to plain execute / reject', () => {
    const onDecide = vi.fn();
    render(<CanvasAgentApprovalCard labels={LABELS} onDecide={onDecide}
      approvals={[approval('c1', 'run_generation', 'x')]} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '执行' }));
    expect([...onDecide.mock.calls[0][0]]).toEqual(['c1']);
  });
});

describe('CanvasAgentApprovalCard · 很长的摘要', () => {
  it('先显示前 12 行，能展开看全并收起', () => {
    const script = Array.from({ length: 20 }, (_, index) => `  line${index + 1};`).join('\n');
    render(<CanvasAgentApprovalCard labels={LABELS} onDecide={vi.fn()} approvals={[
      approval('c1', 'plugin_ps_bridge_execute', `（插件：PS 联动）执行脚本\n${script}`),
    ]} />);
    expect(screen.queryByText(/line20;/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开全文（共 21 行）' }));
    expect(screen.getByText(/line20;/)).toBeInTheDocument();
    expect(screen.getByText(/line20;/).textContent).toContain('\n  line1;');
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText(/line20;/)).toBeNull();
  });
});
