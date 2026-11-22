import { useState, type ReactNode } from 'react';
import { getCanvasAgentBatchItems, agentSessionPath } from '@/api/canvas';
import { creationAssetMediaUrl } from '@/api/creationAssets';
import { AgentProcessToggle } from '@/components/agent/AgentProcessToggle';
import { AgentMarkdown, TOOL_LABELS } from '@/components/agent/AgentMarkdown';
import { CanvasAgentApprovalCard } from '@/components/agent/CanvasAgentApprovalCard';
import { CanvasAgentPlanList } from '@/components/agent/CanvasAgentPlanList';
import { agentUsageLabel } from '@/components/agent/canvasAgentUsage';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { ChatIcon, ChevronDownIcon, ChevronRightIcon, DeleteIcon, LoadingIcon, NewChatIcon } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { CanvasAgentMessage, StudioAgentSession, StudioAgentStep, StudioAgentTurn } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { StudioComposerState } from './StudioComposer';

type Controller = StudioComposerState['agent'];

export function StudioSessionPicker({ agent, clearDraft }: { agent: Controller; clearDraft: () => void }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>
    <Button variant="outline" size="sm" aria-label="对话" className="pointer-events-auto mr-2 h-9 rounded-full bg-glass">
      <ChatIcon size="sm" />对话<ChevronDownIcon size="sm" /></Button>
  </PopoverTrigger><PopoverContent align="start" className="max-h-72 overflow-y-auto p-1">
    <Button variant="ghost" size="sm" className="w-full justify-start" disabled={agent.pending}
      onClick={() => { clearDraft(); agent.newSession(); setOpen(false); }}><NewChatIcon size="sm" />新对话</Button>
    {agent.sessions.map(item => <div key={item.session_id} className="flex items-center">
      <Button variant={agent.session?.session_id === item.session_id ? 'secondary' : 'ghost'} size="sm"
        className="min-w-0 flex-1 justify-start" disabled={agent.pending} onClick={() => { clearDraft(); void agent.selectSession(item.session_id); setOpen(false); }}>
        <span className="truncate">{item.title}</span></Button>
      <Button variant="ghost" size="icon" aria-label={`删除对话 ${item.title}`} disabled={agent.pending}
        onClick={() => void agent.removeSession(item.session_id, item.revision)}><DeleteIcon size="sm" /></Button>
    </div>)}
  </PopoverContent></Popover>;
}

function StepGroup({ steps }: { steps: StudioAgentStep[] }) {
  const first = steps[0];
  const [expanded, setExpanded] = useState(false);
  const problem = steps.find(s => s.status === 'failed' || s.status === 'interrupted' || s.status === 'rejected');
  const label = first.tool === 'load_skill' ? `已加载技能：${first.summary}`
    : steps.length === 1 ? TOOL_LABELS[first.tool] ?? first.tool : `已执行 ${steps.length} 条命令`;
  const suffix = problem?.status === 'failed' ? ' · 出错了' : problem?.status === 'interrupted' ? ' · 已停止' : problem ? ' · 已拒绝' : '';
  return <div className="space-y-1">
    <AgentProcessToggle label={label + suffix} open={expanded} onToggle={() => setExpanded(value => !value)} />
    {expanded && steps.map(step => <p key={step.step_id} className="whitespace-pre-wrap pl-5">
      {step.summary || TOOL_LABELS[step.tool] || step.tool}
    </p>)}
  </div>;
}

function groupSteps(steps: StudioAgentStep[]) {
  const groups: StudioAgentStep[][] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (last && step.tool !== 'load_skill' && last[0].tool !== 'load_skill') last.push(step);
    else groups.push([step]);
  }
  return groups;
}

// JS Date 只保留毫秒，而同一次本地工具调用前后的消息与 Job 可能只相差数十微秒。
function compareTime(a: string, b: string) {
  const millis = Date.parse(a) - Date.parse(b);
  if (millis) return millis;
  const fraction = (iso: string) => (iso.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0');
  return fraction(a).localeCompare(fraction(b));
}

function Turn({ turn, session, agent, jobs, renderJob }: {
  turn: StudioAgentTurn; session: StudioAgentSession; agent: Controller; jobs: Job[]; renderJob: (job: Job) => ReactNode;
}) {
  const running = turn.status === 'running';
  const awaiting = turn.status === 'awaiting_approval';
  const [override, setOverride] = useState<{ status: string; open: boolean } | null>(null);
  const open = awaiting || (override?.status === turn.status ? override.open : running);
  const title = running || awaiting ? '任务响应中…' : turn.status === 'idle' ? '已完成'
    : turn.status === 'interrupted' ? '已停止' : '出错了';
  const messages = session.messages.filter(m => m.turn_id === turn.turn_id);
  const user = messages.find(m => m.role === 'user');
  const replies = messages.filter(m => ['assistant', 'system'].includes(m.role));
  const events = [
    ...replies.map(message => ({ time: message.created_at, id: message.message_id, message, job: null as Job | null })),
    ...jobs.map(job => ({ time: job.submitted_at, id: job.job_id, message: null as CanvasAgentMessage | null, job })),
  ].sort((a, b) => compareTime(a.time, b.time) || (a.message?.sequence ?? Infinity) - (b.message?.sequence ?? Infinity) || a.id.localeCompare(b.id));
  const errors = messages.filter(m => m.role === 'error');
  return <section className="space-y-3">
    <div className="ml-auto flex max-w-[60%] flex-col items-end gap-2">
      {(turn.attachment_ids.length > 0 || turn.asset_ids.length > 0) &&
        <div className="flex flex-wrap justify-end gap-1.5">
          {turn.attachment_ids.map(id => <img key={id} alt="参考图" className="size-14 rounded-lg object-cover"
            src={agentSessionPath(null, session.session_id) + '/attachments/' + encodeURIComponent(id)} />)}
          {turn.asset_ids.map(id => <img key={id} alt="引用资产" className="size-14 rounded-lg object-cover"
            src={creationAssetMediaUrl(id)} onError={event => { event.currentTarget.hidden = true; }} />)}
        </div>}
      {user?.text && <p className="whitespace-pre-wrap break-words rounded-2xl bg-secondary px-4 py-3 text-sm text-foreground">{user.text}</p>}
    </div>
    <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" aria-expanded={open}
      aria-disabled={awaiting} onClick={() => { if (!awaiting) setOverride({ status: turn.status, open: !open }); }}>
      {(running || awaiting) && <LoadingIcon size="sm" className="animate-spin" />}{title}
      {open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />}
    </Button>
    {open && <div className="space-y-2 border-l border-border pl-3 text-xs text-muted-foreground">
      {user?.title && <p>已加载技能：{user.title}</p>}
      {groupSteps(turn.steps).map(group => <StepGroup key={group[0].step_id} steps={group} />)}
      {errors.map(m => <p key={m.message_id} className="whitespace-pre-wrap text-destructive">{m.text}</p>)}
      {awaiting && <CanvasAgentApprovalCard unit="份" key={session.pending_approvals.map(a => a.call_id).join()} approvals={session.pending_approvals} labels={TOOL_LABELS}
        disabled={agent.pending} onDecide={agent.decide}
        loadBatchItems={id => getCanvasAgentBatchItems(null, session.session_id, id)} />}
    </div>}
    {(!running || open) && events.map(event => <div key={event.id}>
      {event.message ? <AgentMarkdown text={event.message.text} /> : event.job && renderJob(event.job)}
    </div>)}
    {running && open && agent.streaming && <AgentMarkdown text={agent.streaming} />}
  </section>;
}

export function StudioAgentTimeline({ agent, jobs, renderJob }: {
  agent: Controller; jobs: Job[]; renderJob: (job: Job) => ReactNode;
}) {
  const session = agent.session;
  if (!session || !('turns' in session)) return null;
  const usage = agentUsageLabel(agent.usage);
  return <div className="mx-auto w-full max-w-[1024px] space-y-6 px-2 py-4">
    <CanvasAgentPlanList plan={agent.plan} running={session.status === 'running'} />
    {session.turns.map(turn => <Turn key={turn.turn_id} turn={turn} session={session} agent={agent}
      jobs={jobs.filter(job => job.studio_agent_session_id === session.session_id && job.studio_agent_turn_id === turn.turn_id)}
      renderJob={renderJob} />)}
    {usage && <Hint label={usage.detail}><span className="text-xs text-muted-foreground">{usage.text}</span></Hint>}
  </div>;
}
