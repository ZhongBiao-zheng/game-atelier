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

describe('CanvasAgentApprovalCard · 批量生成', () => {
  const batch = approval('g1', 'run_generations', [
    '批量生成 3 项，共 4 张',
    '1. 角色1 · seedream · 1 张 · 预计 6¥',
    '2. 角色2 · seedream · 2 张 · 预计 12¥',
    '3. 角色3 · unknown · 1 张 · 未计价',
    '合计预计 18¥（1 项未计价）',
    '超过确认金额 10¥',
  ].join('\n'));
  batch.arguments = JSON.stringify({ items: [{ surface_node_id: 'a' }, { surface_node_id: 'b' }, { surface_node_id: 'c' }] });
  const labels = { ...LABELS, run_generations: '批量生成' };

  it('每项一个勾选框，合计与超额写在下面，去掉勾的项按拒绝', () => {
    const onDecide = vi.fn();
    render(<CanvasAgentApprovalCard labels={labels} onDecide={onDecide} approvals={[batch]} />);
    expect(screen.getByRole('checkbox', { name: '执行第 2 项' })).toBeChecked();
    expect(screen.getByText('角色2 · seedream · 2 张 · 预计 12¥')).toBeInTheDocument();
    expect(screen.getByText(/合计预计 18¥/).textContent).toBe('合计预计 18¥（1 项未计价）\n超过确认金额 10¥');
    expect(screen.getByRole('button', { name: '执行' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '执行第 2 项' }));
    fireEvent.click(screen.getByRole('button', { name: '执行 2 项' }));
    const [calls, items] = onDecide.mock.calls[0];
    expect([...calls]).toEqual(['g1']);
    expect([...items]).toEqual([['g1', [0, 2]]]);
  });

  it('全选时不带逐项选择，全部去掉勾等于拒绝这次调用', () => {
    const onDecide = vi.fn();
    render(<CanvasAgentApprovalCard labels={labels} onDecide={onDecide}
      approvals={[batch, approval('m1', 'apply_changes', 'move a')]} />);
    fireEvent.click(screen.getByRole('button', { name: '执行' }));
    expect([...onDecide.mock.calls[0][0]].sort()).toEqual(['g1', 'm1']);
    expect([...onDecide.mock.calls[0][1]]).toEqual([]);
    for (const index of [1, 2, 3]) fireEvent.click(screen.getByRole('checkbox', { name: `执行第 ${index} 项` }));
    fireEvent.click(screen.getByRole('button', { name: '执行 1 项' }));
    expect([...onDecide.mock.calls[1][0]]).toEqual(['m1']);
  });
});
