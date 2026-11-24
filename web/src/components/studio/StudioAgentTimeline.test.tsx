import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CanvasAgentMessage, StudioAgentSession, StudioAgentTurn } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { StudioComposerState } from './StudioComposer';
import { StudioSessionControls } from './StudioSessionControls';
import { within } from '@testing-library/react';
import { parseAgentReply } from '@/components/agent/AgentSuggestions';
import { StudioAgentTurnCard } from './StudioAgentTimeline';

import { mixedTimeline } from '@/lib/historyFilters';
import type { ComponentProps } from 'react';

function TurnCards({agent, jobs, renderJob, onPickSuggestion}: Pick<ComponentProps<typeof StudioAgentTurnCard>, 'agent' | 'jobs' | 'renderJob' | 'onPickSuggestion'>) {
  const session = agent.session as StudioAgentSession;
  const timeline = mixedTimeline([], session, jobs);
  return timeline.map((entry, i) => entry.kind === 'agent' && <StudioAgentTurnCard key={entry.turn.turn_id}
    agent={agent} session={session} {...entry} renderJob={renderJob} last={i === timeline.length - 1} onPickSuggestion={onPickSuggestion} />);
}

const makeMessage = (role: CanvasAgentMessage['role'], text: string, sequence: number): CanvasAgentMessage => ({
  role, text, sequence, turn_id: 't1', message_id: String(sequence), references: [], title: null,
  reasoning_summary: null, created_at: `2026-11-22T10:00:0${sequence}Z`,
});
function makeAgent(status: StudioAgentTurn['status']) {
  const turn: StudioAgentTurn = { turn_id: 't1', status, client_message_id: 'm', attachment_ids: [], asset_ids: [],
    steps: [{ step_id: 'call-1', tool: 'list_models', summary: '列出可用模型', status: 'completed' }] };
  if (status === 'awaiting_approval') turn.steps.push({ step_id: 'call-2', tool: 'run_generation', summary: '预计 12 元', status: 'running' });
  const session: StudioAgentSession = { session_id: 's1', status, turns: [turn], title: '第一轮',
    model: null, model_alias: null, schema_version: 1, revision: 4, sequence: 4, error: null,
    effort: null, permission_mode: 'auto', creation_mode: 'all', auto_models: true, preferred_models: [],
    token_usage: { input_tokens: 0, output_tokens: 0 }, created_at: '', updated_at: '', pending_approvals: [
    { call_id: 'call-2', tool: 'run_generation', summary: '预计 12 元' }],
    messages: [makeMessage('user', '做一张海报', 1), makeMessage('assistant', '准备草图', 2),
      makeMessage('assistant', '成片已就绪', 4)] };
  return { session, sessions: [{ session_id: 's1', title: '第一轮', revision: 4 }, { session_id: 's2', title: '另一段对话', revision: 2 }],
    usage: null, plan: null, selectSession: vi.fn(), newSession: vi.fn(), removeSession: vi.fn(), decide: vi.fn() } as unknown as StudioComposerState['agent'];
}
const jobs = ['s1', 'other'].map((sid, i) => ({ job_id: 'job-' + i, studio_agent_session_id: sid, studio_agent_turn_id: 't1',
  submitted_at: '2026-11-22T10:00:03Z', completed_at: '2026-11-22T10:00:09Z' }) as Job);

it('默认收起工具过程，说明文案在上、产出的作品在回合底部，并支持提取推荐追问', () => {
  const pick = vi.fn();
  const agent = makeAgent('idle');
  agent.session!.messages[2].text = '成片已就绪\n→ 换成侧身眨眼的表情';
  const { container } = render(<TurnCards agent={agent} jobs={jobs} renderJob={j => j.job_id} onPickSuggestion={pick} />);
  expect(screen.getByRole('button', { name: '已完成' })).toHaveAttribute('aria-expanded', 'false');
  expect(container.textContent).toMatch(/准备草图.*成片已就绪.*job-0/);
  expect(container.textContent).not.toContain('job-1');
  fireEvent.click(screen.getByRole('button', { name: /换成侧身眨眼的表情/ }));
  expect(pick).toHaveBeenCalledWith('换成侧身眨眼的表情');
  fireEvent.click(screen.getByRole('button', { name: '已完成' }));
  fireEvent.click(screen.getByRole('button', { name: '查看可用模型' }));
  expect(screen.getByText('列出可用模型')).toBeInTheDocument();
});

it('只把回复末尾连续的箭头行当推荐追问，正文中间的箭头行保留', () => {
  expect(parseAgentReply('流程：草图 → 上色\n成片已就绪\n\n→ 换成侧身\n- → 加一点留白\n')).toEqual({
    body: '流程：草图 → 上色\n成片已就绪', suggestions: ['换成侧身', '加一点留白'],
  });
  expect(parseAgentReply('→ 一\n正文在后')).toEqual({ body: '→ 一\n正文在后', suggestions: [] });
});

it('推荐追问只在最后一轮正常结束时出现，没有约定格式就不出现', () => {
  const agent = makeAgent('idle');
  const session = agent.session as StudioAgentSession;
  session.turns = [{ ...session.turns[0], turn_id: 't0' }, session.turns[0]];
  session.messages = [...session.messages, { ...makeMessage('assistant', '旧回合\n→ 旧追问', 0), turn_id: 't0' }];
  session.messages[2].text = '成片已就绪\n→ 新追问';
  const view = render(<TurnCards agent={agent} jobs={[]} renderJob={() => null} onPickSuggestion={vi.fn()} />);
  expect(screen.getByRole('button', { name: /新追问/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /旧追问/ })).toBeNull();
  session.messages[2].text = '成片已就绪';
  view.rerender(<TurnCards agent={{ ...agent }} jobs={[]} renderJob={() => null} onPickSuggestion={vi.fn()} />);
  expect(screen.queryByText('继续探索')).toBeNull();
});

it('运行时默认收起工具步骤，待确认强制展开，停止后能展开查看步骤', () => {
  const view = (status: StudioAgentTurn['status']) => <TurnCards agent={makeAgent(status)} jobs={[]} renderJob={() => null} />;
  const tree = render(view('running'));
  const running = screen.getByRole('button', { name: '任务响应中…' });
  expect(running).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(running);
  expect(running).toHaveAttribute('aria-expanded', 'true');
  tree.rerender(view('awaiting_approval'));
  fireEvent.click(screen.getByRole('button', { name: '任务响应中…' }));
  expect(screen.getByRole('group', { name: '待确认的操作' })).toBeVisible();
  expect(screen.getByRole('button', { name: '生成 · 待确认' })).toBeVisible();
  expect(screen.queryByText('已执行 2 条命令')).toBeNull();
  tree.rerender(view('interrupted'));
  fireEvent.click(screen.getByRole('button', { name: '已停止' }));
  fireEvent.click(screen.getByRole('button', { name: '查看可用模型' }));
  expect(screen.getByText('列出可用模型')).toBeInTheDocument();
});

it('对话菜单可直接切换、新建和按 revision 删除', () => {
  const agent = makeAgent('idle');
  render(<StudioSessionControls agent={agent} clearDraft={() => {}} />);
  const open = () => fireEvent.click(screen.getByRole('button', { name: '切换对话' }));
  open(); fireEvent.click(screen.getByRole('button', { name: '另一段对话' }));
  expect(agent.selectSession).toHaveBeenCalledWith('s2');
  open(); fireEvent.click(within(screen.getByLabelText('对话列表')).getByRole('button', { name: '新建对话' }));
  expect(agent.newSession).toHaveBeenCalledOnce();
  open(); fireEvent.click(screen.getByRole('button', { name: '删除对话 另一段对话' }));
  expect(agent.removeSession).toHaveBeenCalledWith('s2', 2);
});
