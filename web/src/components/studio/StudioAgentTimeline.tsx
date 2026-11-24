import { useState, type ReactNode } from 'react';
import { getCanvasAgentBatchItems, agentSessionPath } from '@/api/canvas';
import { creationAssetMediaUrl } from '@/api/creationAssets';
import { AgentMarkdown, TOOL_LABELS } from '@/components/agent/AgentMarkdown';
import { AgentSuggestions, parseAgentReply } from '@/components/agent/AgentSuggestions';
import { CanvasAgentApprovalCard } from '@/components/agent/CanvasAgentApprovalCard';
import { Lightbox } from '@/components/Lightbox';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { AiIcon, ChevronDownIcon, ChevronRightIcon, ImageIcon, LoadingIcon, SkillIcon, ToolIcon } from '@/components/ui/icons';
import type { StudioAgentSession, StudioAgentStep, StudioAgentTurn } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { StudioComposerState } from './StudioComposer';

type Controller = StudioComposerState['agent'];

const TURN_REF_W = 46;
const TURN_REF_H = 58;
const TURN_REF_ROTATIONS = [-6, 5, -4, 7, -5, 4, -3, 6];
const TURN_REF_OVERLAP_REST = 30;
const TURN_REF_OVERLAP_HOVER = 8;

function TurnAttachmentStack({ urls, onLightbox }: { urls: { src: string; alt: string }[]; onLightbox: (src: string) => void }) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  if (urls.length === 0) return null;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(null); }}
      style={{
        width: TURN_REF_W + Math.max(0, urls.length - 1) * (TURN_REF_W - (hover ? TURN_REF_OVERLAP_HOVER : TURN_REF_OVERLAP_REST)),
        height: TURN_REF_H,
        transition: 'width 250ms ease',
      }}
      className="relative z-20 flex shrink-0 items-center"
    >
      {urls.map((item, i) => {
        const angle = TURN_REF_ROTATIONS[i % TURN_REF_ROTATIONS.length];
        const isActive = active === i;
        const scale = isActive ? 1.18 : hover ? 1.1 : 1;
        return (
          <Button
            key={i}
            variant="secondary"
            size="icon"
            type="button"
            aria-label={item.alt}
            onMouseEnter={() => setActive(i)}
            onClick={() => onLightbox(item.src)}
            style={{
              width: TURN_REF_W,
              height: TURN_REF_H,
              left: 0,
              top: 0,
              zIndex: isActive ? 30 : i,
              transform: `translateX(${i * (TURN_REF_W - (hover ? TURN_REF_OVERLAP_HOVER : TURN_REF_OVERLAP_REST))}px) rotate(${angle}deg) scale(${scale})`,
              transformOrigin: 'center',
              transition: 'transform 250ms ease',
            }}
            className="absolute block cursor-zoom-in overflow-hidden rounded-lg border-[1.5px] border-white bg-card p-0"
          >
            <img src={item.src} alt={item.alt} className="h-full w-full object-cover" onError={event => { event.currentTarget.hidden = true; }} />
          </Button>
        );
      })}
    </div>
  );
}

function StepGroup({ steps, awaiting }: { steps: StudioAgentStep[]; awaiting: boolean }) {
  const first = steps[0];
  const [expanded, setExpanded] = useState(false);
  const isSkill = first.tool === 'load_skill';
  const problem = steps.find(s => s.status === 'failed' || s.status === 'interrupted' || s.status === 'rejected');
  const label = isSkill ? `已加载技能：${first.summary}`
    : steps.length === 1 ? TOOL_LABELS[first.tool] ?? first.tool : `已执行 ${steps.length} 条命令`;
  const suffix = awaiting && first.status === 'running' ? ' · 待确认' : problem?.status === 'failed' ? ' · 出错了' : problem?.status === 'interrupted' ? ' · 已停止' : problem ? ' · 已拒绝' : '';
  if (isSkill && !problem && !awaiting) {
    return (
      <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <SkillIcon size="sm" className="shrink-0" />
        <span>{label}</span>
      </div>
    );
  }
  return <div className="space-y-1.5">
    <Button
      variant="ghost"
      size="sm"
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}
      className="-ml-2 flex h-7 w-fit items-center gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
    >
      <ToolIcon size="sm" className="shrink-0" />
      <span>{label + suffix}</span>
      <ChevronRightIcon size="sm" className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </Button>
    {expanded && <div className="space-y-1 border-l border-border pl-4">
      {steps.map(step => <p key={step.step_id} className="whitespace-pre-wrap text-xs text-muted-foreground">
        {step.summary || TOOL_LABELS[step.tool] || step.tool}
      </p>)}
    </div>}
  </div>;
}

function groupSteps(steps: StudioAgentStep[]) {
  const groups: StudioAgentStep[][] = [];
  for (const step of steps.filter(item => item.tool !== 'update_plan')) {
    const last = groups.at(-1);
    if (last && step.status === 'completed' && last[0].status === 'completed'
        && step.tool !== 'load_skill' && last[0].tool !== 'load_skill') last.push(step);
    else groups.push([step]);
  }
  return groups;
}

function GenerationPlanCard({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) return null;
  const doneCount = jobs.filter(job => job.status === 'done').length;
  const isVideo = jobs.every(job => job.kind === 'video');
  const noun = isVideo ? '视频' : '图片';
  const statusText = doneCount === jobs.length
    ? `(${doneCount}/${jobs.length}) ${noun}生成完成`
    : `(${doneCount}/${jobs.length}) ${noun}生成中`;
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ImageIcon size="sm" className="shrink-0" />
        <span className="tabular-nums">{statusText}</span>
      </div>
      <div className="max-w-[640px] space-y-2 rounded-xl border border-border bg-card/60 p-3.5">
        <p className="text-xs font-medium text-foreground">将生成以下{noun} ({jobs.length})</p>
        <ul className="space-y-2">
          {jobs.map(job => (
            <li key={job.job_id} className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{job.prompt}</span>
              <span className="flex shrink-0 items-center gap-1 tabular-nums text-foreground/80">
                <AiIcon size="sm" />
                {job.params?.n ?? 1}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// JS Date 只保留毫秒，而同一次本地工具调用前后的消息与 Job 可能只相差数十微秒。
function compareTime(a: string, b: string) {
  const millis = Date.parse(a) - Date.parse(b);
  if (millis) return millis;
  const fraction = (iso: string) => (iso.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0');
  return fraction(a).localeCompare(fraction(b));
}

export function StudioAgentTurnCard({ turn, session, agent, jobs, messages, renderJob, last, onPickSuggestion }: {
  turn: StudioAgentTurn;
  session: StudioAgentSession;
  agent: Controller;
  jobs: Job[];
  messages: StudioAgentSession['messages'];
  renderJob: (job: Job) => ReactNode;
  last: boolean;
  onPickSuggestion?: (text: string) => void;
}) {
  const running = turn.status === 'running';
  const awaiting = turn.status === 'awaiting_approval';
  const [override, setOverride] = useState<{ status: string; open: boolean } | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const open = awaiting || (override?.status === turn.status ? override.open : false);
  const title = running || awaiting ? '任务响应中…' : turn.status === 'idle' ? '已完成'
    : turn.status === 'interrupted' ? '已停止' : '出错了';
  const user = messages.find(m => m.role === 'user');
  const replies = messages.filter(m => ['assistant', 'system'].includes(m.role));
  const sortedJobs = [...jobs].sort((a, b) => compareTime(a.submitted_at, b.submitted_at) || a.job_id.localeCompare(b.job_id));
  const hasJobs = sortedJobs.length > 0;
  const parsedReplies = replies.map(message => ({ message, ...parseAgentReply(message.text) }));
  const visibleReplies = parsedReplies.filter(item => item.body.length > 0);
  // 只有整条时间线的最后一轮、且已正常结束，才显示它的推荐追问。
  const suggestions = last && turn.status === 'idle' ? parsedReplies.at(-1)?.suggestions ?? [] : [];
  const errors = messages.filter(m => m.role === 'error');
  const attachmentUrls = [
    ...turn.attachment_ids.map(id => ({
      src: agentSessionPath(null, session.session_id) + '/attachments/' + encodeURIComponent(id),
      alt: '参考图',
    })),
    ...turn.asset_ids.map(id => ({
      src: creationAssetMediaUrl(id),
      alt: '引用资产',
    })),
  ];
  return <section className="space-y-4">
    <div className="ml-auto flex max-w-[60%] flex-col items-end gap-2">
      <TurnAttachmentStack urls={attachmentUrls} onLightbox={setLightboxSrc} />
      {user?.text && <p className="whitespace-pre-wrap break-words rounded-2xl bg-secondary px-4 py-3 text-sm text-foreground">{user.text}</p>}
    </div>
    <div className="space-y-2">
      <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs text-muted-foreground" aria-expanded={open}
        aria-disabled={awaiting} onClick={() => { if (!awaiting) setOverride({ status: turn.status, open: !open }); }}>
        {(running || awaiting) && <LoadingIcon size="sm" className="animate-spin" />}{title}
        {open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />}
      </Button>
      {open && <div className="space-y-2.5 border-l border-border pl-3.5 text-xs text-muted-foreground">
        {user?.title && (
          <div className="flex items-center gap-2 py-0.5">
            <SkillIcon size="sm" className="shrink-0" />
            <span>已加载技能：{user.title}</span>
          </div>
        )}
        {groupSteps(turn.steps).map(group => <StepGroup key={group[0].step_id} steps={group}
          awaiting={awaiting && session.pending_approvals.some(item => item.call_id === group[0].step_id)} />)}
        <GenerationPlanCard jobs={sortedJobs} />
        {errors.map(m => <p key={m.message_id} className="whitespace-pre-wrap text-destructive">{m.text}</p>)}
        {awaiting && <CanvasAgentApprovalCard unit="份" key={session.pending_approvals.map(a => a.call_id).join()} approvals={session.pending_approvals} labels={TOOL_LABELS}
          disabled={agent.pending} onDecide={agent.decide}
          loadBatchItems={id => getCanvasAgentBatchItems(null, session.session_id, id)} />}
      </div>}
      {!open && errors.map(m => <p key={m.message_id} className="whitespace-pre-wrap text-xs text-destructive">{m.text}</p>)}
    </div>
    {visibleReplies.length > 0 && (
      <div className="space-y-2 text-muted-foreground">
        {visibleReplies.map(item => <div key={item.message.message_id}>
          <AgentMarkdown text={item.body} />
        </div>)}
      </div>
    )}
    {running && agent.streaming && (
      <div className="text-muted-foreground">
        <AgentMarkdown text={parseAgentReply(agent.streaming).body || agent.streaming} />
      </div>
    )}
    {hasJobs && sortedJobs.length === 1 && (
      <div className="space-y-6 pt-1">
        {sortedJobs.map(job => <div key={job.job_id}>{renderJob(job)}</div>)}
      </div>
    )}
    {hasJobs && sortedJobs.length > 1 && (
      <div data-testid="agent-multi-job-batch" className="space-y-3 pt-1">
        <div className="flex flex-wrap items-start gap-3">
          {sortedJobs.map((job, idx) => (
            <div key={job.job_id} className="space-y-1.5">
              <div className="flex max-w-[251.5px] items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary font-medium tabular-nums text-foreground">
                  {idx + 1}
                </span>
                <Hint label={job.prompt}>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{job.prompt}</span>
                </Hint>
              </div>
              {renderJob(job)}
            </div>
          ))}
        </div>
      </div>
    )}
    {onPickSuggestion && <AgentSuggestions suggestions={suggestions} onPick={onPickSuggestion} />}
    {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
  </section>;
}
