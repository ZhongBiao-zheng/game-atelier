import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CanvasAgentMessage } from '@/schema/canvas';

const agentState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/components/agent/useWorkspaceAgent', () => ({ useCanvasAgent: () => agentState.current }));

import { CanvasAgentPanel } from './CanvasAgentPanel';

const message = (role: CanvasAgentMessage['role'], text: string, sequence: number): CanvasAgentMessage => ({
  role, text, sequence, turn_id: 't1', message_id: String(sequence), references: [], title: null,
  reasoning_summary: null, created_at: `2026-11-24T10:00:0${sequence}Z`,
});

function renderPanel(status: string, messages: CanvasAgentMessage[]) {
  agentState.current = {
    session: { session_id: 's1', title: '对话', status, messages, pending_approvals: [], model: null, model_alias: null },
    streaming: '', tool: null, loading: false, outgoing: null, pending: false, error: null, draft: {}, models: null, generationModels: [],
    usage: null, plan: null, sessions: [], skills: [], confirmAbove: null,
    clearError: vi.fn(), decide: vi.fn(), newSession: vi.fn(), reloadSkills: vi.fn(), selectSession: vi.fn(),
    send: vi.fn(), stop: vi.fn(), updateConfirmAbove: vi.fn(), updateSettings: vi.fn(),
  };
  return render(<CanvasAgentPanel projectId="p1" selectedNodes={[]} onClose={vi.fn()} onUpload={vi.fn()} onOpenKeySettings={vi.fn()} />);
}

it('最后一条回复末尾的箭头行显示为推荐追问，正文里不再出现，点击回填输入框', () => {
  renderPanel('idle', [message('user', '看看这版构图', 1), message('assistant', '落日右移一点更安静。\n→ 试试日落后的蓝调', 2)]);
  expect(screen.getByText('落日右移一点更安静。')).toBeInTheDocument();
  expect(screen.queryByText(/→ 试试日落后的蓝调/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /试试日落后的蓝调/ }));
  expect(screen.getByRole('textbox')).toHaveValue('试试日落后的蓝调');
});

it('运行中或最后一条不是 Agent 回复时不显示推荐追问', () => {
  const reply = message('assistant', '好的\n→ 加一层薄雾', 2);
  const view = renderPanel('running', [message('user', '画山', 1), reply]);
  expect(screen.queryByText('继续探索')).toBeNull();
  view.unmount();
  renderPanel('idle', [message('user', '画山', 1), reply, message('user', '再来一张', 3)]);
  expect(screen.queryByText('继续探索')).toBeNull();
});
