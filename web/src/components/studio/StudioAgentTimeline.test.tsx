import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { CanvasAgentMessage, StudioAgentSession, StudioAgentTurn } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { StudioComposerState } from './StudioComposer';
import { StudioSessionControls } from './StudioSessionControls';
import { within } from '@testing-library/react';
import { parseAgentReply } from '@/components/agent/AgentSuggestions';
import { StudioAgentTurnCard } from './StudioAgentTimeline';

import { mixedTimeline } from '@/lib/historyFilters';
import type { ComponentProps } from 'react';

function TurnCards({agent, jobs, renderJobs, onPickSuggestion}: Pick<ComponentProps<typeof StudioAgentTurnCard>, 'agent' | 'jobs' | 'renderJobs' | 'onPickSuggestion'>) {
  const session = agent.session as StudioAgentSession;
  const timeline = mixedTimeline([], session, jobs);
  return timeline.map((entry, i) => entry.kind === 'agent' && <StudioAgentTurnCard key={entry.turn.turn_id}
    agent={agent} session={session} {...entry} renderJobs={renderJobs} last={i === timeline.length - 1} onPickSuggestion={onPickSuggestion} />);
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
  const { container } = render(<TurnCards agent={agent} jobs={jobs} renderJobs={items => items.map(j => j.job_id)} onPickSuggestion={pick} />);
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
  const view = render(<TurnCards agent={agent} jobs={[]} renderJobs={() => null} onPickSuggestion={vi.fn()} />);
  expect(screen.getByRole('button', { name: /新追问/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /旧追问/ })).toBeNull();
  session.messages[2].text = '成片已就绪';
  view.rerender(<TurnCards agent={{ ...agent }} jobs={[]} renderJobs={() => null} onPickSuggestion={vi.fn()} />);
  expect(screen.queryByText('继续探索')).toBeNull();
});

it('运行时默认收起工具步骤，待确认强制展开，停止后能展开查看步骤', () => {
  const view = (status: StudioAgentTurn['status']) => <TurnCards agent={makeAgent(status)} jobs={[]} renderJobs={() => null} />;
  const tree = render(view('running'));
  const running = screen.getByRole('button', { name: '处理中…' });
  expect(running).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(running);
  expect(running).toHaveAttribute('aria-expanded', 'true');
  tree.rerender(view('awaiting_approval'));
  fireEvent.click(screen.getByRole('button', { name: '处理中…' }));
  expect(screen.getByRole('group', { name: '待确认的操作' })).toBeVisible();
  expect(screen.getByRole('button', { name: '生成 · 待确认' })).toBeVisible();
  expect(screen.queryByText('已执行 2 步')).toBeNull();
  tree.rerender(view('interrupted'));
  fireEvent.click(screen.getByRole('button', { name: '已停止' }));
  fireEvent.click(screen.getByRole('button', { name: '查看可用模型' }));
  expect(screen.getByText('列出可用模型')).toBeInTheDocument();
});

it('确认第一批后同一轮紧接着来第二批：新确认卡立即可操作，只提交自己的 call_id', async () => {
  vi.useFakeTimers();
  try {
    const agent = makeAgent('awaiting_approval');
    const session = agent.session as StudioAgentSession;
    let resolveFirst: (value: unknown) => void = () => {};
    const decide = vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockReturnValue(new Promise(() => {}));
    const view = (next: StudioAgentSession) => <TurnCards agent={{ ...agent, decide, session: next }} jobs={[]} renderJobs={() => null} />;
    const tree = render(view(session));
    fireEvent.click(screen.getByRole('button', { name: '执行' }));
    expect(decide.mock.calls[0][0]).toEqual(new Set(['call-2']));
    expect(screen.getByText('执行中…')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '待确认的操作' })).toBeNull();
    // 第一批的请求返回前，服务端已推来同一轮的第二批。
    const second: StudioAgentSession = { ...session, pending_approvals: [
      { call_id: 'call-3', tool: 'run_generation', summary: '预计 8 元' }] };
    tree.rerender(view(second));
    expect(screen.getByRole('group', { name: '待确认的操作' })).toBeInTheDocument();
    await act(async () => { resolveFirst(second); });
    await act(async () => { vi.advanceTimersByTime(900); });
    expect(screen.queryByText('执行中…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '执行' }));
    expect(decide.mock.calls[1][0]).toEqual(new Set(['call-3']));
  } finally {
    vi.useRealTimers();
  }
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

it('多方案只向作品区传入一批有序任务', () => {
  const batch = ['松林', '落日'].map((prompt, i) => ({ ...jobs[0], job_id: 'batch-' + i, prompt }));
  const renderJobs = vi.fn(() => <div>缩略图</div>);
  render(<TurnCards agent={makeAgent('idle')} jobs={batch} renderJobs={renderJobs} />);
  expect(renderJobs).toHaveBeenCalledTimes(1);
  expect(renderJobs).toHaveBeenCalledWith(batch);
  expect(screen.getByTestId('agent-multi-job-batch').textContent).toBe('缩略图');
});

it('新建对话用主色浅底并排在对话标题前，标题不再套胶囊', () => {
  render(<StudioSessionControls agent={makeAgent('idle')} clearDraft={() => {}} />);
  const create = screen.getByRole('button', { name: '新建对话' });
  const title = screen.getByRole('button', { name: '切换对话' });
  expect(create).toHaveClass('bg-primary/14', 'border-primary/45');
  expect(create).toHaveTextContent('新建对话');
  expect(create.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(title).toHaveClass('text-base', 'font-semibold');
  expect(title).not.toHaveClass('border', 'bg-glass');
});

it('已有作品且看图后静默结束时，回复区保留建议与追问', () => {
  const agent = makeAgent('idle');
  agent.session!.messages[2].text = '① 猫靠近镜头（本张）\n→ 再试背影';
  agent.session!.messages.push(makeMessage('system', '模型没有补充说明', 5));
  render(<TurnCards agent={agent} jobs={jobs} renderJobs={() => '作品'} onPickSuggestion={vi.fn()} />);
  expect(screen.getByText('① 猫靠近镜头（本张）')).toBeVisible();
  expect(screen.getByRole('button', { name: '再试背影' })).toBeVisible();
  expect(screen.queryByText('模型没有补充说明')).toBeNull();
});
