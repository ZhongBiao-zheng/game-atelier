import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CanvasAgentMessage, StudioAgentSession, StudioAgentTurn } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { StudioComposerState } from './StudioComposer';
import { StudioAgentTimeline, StudioSessionPicker } from './StudioAgentTimeline';

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

it('已完成一轮默认折叠，按提交时间混排同一会话的记录', () => {
  const { container } = render(<StudioAgentTimeline agent={makeAgent('idle')} jobs={jobs} renderJob={j => j.job_id} />);
  expect(screen.getByRole('button', { name: '已完成' })).toHaveAttribute('aria-expanded', 'false');
  expect(container.textContent).toMatch(/准备草图.*job-0.*成片已就绪/);
  expect(container.textContent).not.toContain('job-1');
  fireEvent.click(screen.getByRole('button', { name: '已完成' }));
  fireEvent.click(screen.getByRole('button', { name: '查看可用模型' }));
  expect(screen.getByText('列出可用模型')).toBeInTheDocument();
});

it('同一毫秒内按服务端微秒区分准备说明、提交和总结', () => {
  const agent = makeAgent('idle');
  const session = agent.session!;
  session.messages[1].created_at = '2026-11-22T10:00:03.010001Z';
  session.messages[2].created_at = '2026-11-22T10:00:03.010003Z';
  const job = { ...jobs[0], submitted_at: '2026-11-22T10:00:03.010002Z' };
  const { container } = render(<StudioAgentTimeline agent={agent} jobs={[job]} renderJob={j => j.job_id} />);
  expect(container.textContent).toMatch(/准备草图.*job-0.*成片已就绪/);
});

it('运行时可收起，待确认强制展开，停止后能查看步骤', () => {
  const view = (status: StudioAgentTurn['status']) => <StudioAgentTimeline agent={makeAgent(status)} jobs={[]} renderJob={() => null} />;
  const tree = render(view('running'));
  const running = screen.getByRole('button', { name: '任务响应中…' });
  expect(running).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(running);
  expect(screen.queryByText('准备草图')).toBeNull();
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
  render(<StudioSessionPicker agent={agent} clearDraft={() => {}} />);
  const open = () => fireEvent.click(screen.getByRole('button', { name: '对话' }));
  open(); fireEvent.click(screen.getByRole('button', { name: '另一段对话' }));
  expect(agent.selectSession).toHaveBeenCalledWith('s2');
  open(); fireEvent.click(screen.getByRole('button', { name: '新对话' }));
  expect(agent.newSession).toHaveBeenCalledOnce();
  open(); fireEvent.click(screen.getByRole('button', { name: '删除对话 另一段对话' }));
  expect(agent.removeSession).toHaveBeenCalledWith('s2', 2);
});
