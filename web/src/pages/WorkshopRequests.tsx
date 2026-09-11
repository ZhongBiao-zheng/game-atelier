import { useEffect, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { approveWorkshopRequest, fetchWorkshopRequest, fetchWorkshopRequests, rejectWorkshopRequest, workshopReferenceUrl, workshopTargetUrl, type WorkshopRequest, type WorkshopRequestScope } from '@/api/workshopRequests';
import { useSSE } from '@/hooks/useSSE';

const STATE_LABELS = { awaiting_approval: '待批准', approved: '已批准', withdrawn: '已撤回', rejected: '已拒绝', expired: '已过期' };

function actorLabel(actor: string | null | undefined) {
  if (!actor) return '';
  if (actor === 'local') return '本机页面';
  return `Agent 授权 ${actor.slice(0, 8)}`;
}
function timeLabel(iso: string | null | undefined) {
  if (!iso) return '';
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString('zh-CN', { hour12: false });
}
function decisionLine(request: WorkshopRequest) {
  if (request.state === 'approved' && request.approved_at) return `批准：${actorLabel(request.approved_by)} · ${timeLabel(request.approved_at)}`;
  if (request.state === 'rejected' && request.rejected_at) return `拒绝：${actorLabel(request.rejected_by)} · ${timeLabel(request.rejected_at)}`;
  return null;
}

export function WorkshopRequestsPage() {
  const signal = useSSE();
  const selected = new URLSearchParams(useSearch()).get('request_id');
  const [scope, setScope] = useState<WorkshopRequestScope>('awaiting');
  const [requests, setRequests] = useState<WorkshopRequest[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchWorkshopRequests(page, scope), selected ? fetchWorkshopRequest(selected) : Promise.resolve(null)]).then(([result, pinned]) => {
      if (active) { setRequests(pinned ? [pinned, ...result.requests.filter(item => item.request_id !== pinned.request_id)] : result.requests); setTotal(result.total); setError(null); }
    }).catch(error => { if (active) setError(String(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, scope, signal, selected]);

  async function decide(request: WorkshopRequest, action: 'approve' | 'reject') {
    if (acting) return;
    setActing(request.request_id); setError(null);
    try {
      const result = action === 'approve' ? await approveWorkshopRequest(request) : await rejectWorkshopRequest(request);
      setRequests(current => current.map(item => item.request_id === result.request_id ? result : item));
    } catch (error) { setError(String(error)); } finally { setActing(null); }
  }
  function switchScope(next: WorkshopRequestScope) {
    if (next === scope) return;
    setScope(next); setPage(1);
  }

  const scopeButton = (value: WorkshopRequestScope, label: string) => (
    <button type="button" aria-pressed={scope === value} onClick={() => switchScope(value)}
      className={`rounded-md px-3 py-1.5 text-sm ${scope === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
  );

  return <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
    <header className="flex flex-wrap items-center justify-between gap-4"><h1 className="flex items-center gap-2 font-display text-display">待批准生成<span title="未获「直接执行」授权的 Agent 发起的生成，要在这里批准后才会调用供应商并计费。" className="inline-flex"><CircleHelp className="size-4 text-muted-foreground" aria-label="说明" /></span></h1><Link href="/connection" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent">管理 Agent 授权</Link></header>
    <div role="group" aria-label="请求范围" className="flex items-center gap-1 rounded-md border border-border p-1 w-fit">{scopeButton('awaiting', '待批准')}{scopeButton('history', '历史')}</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading && requests.length === 0 && <p role="status" className="text-sm text-muted-foreground">读取中…</p>}
    {!loading && requests.length === 0 && <p className="py-8 text-sm text-muted-foreground">{scope === 'awaiting' ? '没有待批准的生成请求。' : '还没有历史请求。'}</p>}
    <section aria-label="生成请求" className="space-y-4">{requests.map(request => {
      const expired = Date.parse(request.expires_at) <= Date.now();
      const canDecide = request.state === 'awaiting_approval' && !expired;
      const decision = decisionLine(request);
      return <article key={request.request_id} id={request.request_id} className={`space-y-4 rounded-lg border bg-card p-5 ${selected === request.request_id ? 'border-primary' : 'border-border'}`}>
        <header className="flex flex-wrap justify-between gap-2"><h2 className="text-base font-medium">{request.target_name}</h2><span className="text-xs text-muted-foreground">{request.state === 'awaiting_approval' && expired ? '已过期' : STATE_LABELS[request.state]}</span></header>
        <p className="text-sm text-muted-foreground">{request.provider} · {request.alias} · {request.model}</p>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{request.prompt}</p>
        <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">生成参数</summary><pre className="mt-2 overflow-auto rounded-md bg-background p-3 font-mono text-xs">{JSON.stringify(request.params, null, 2)}</pre></details>
        <p className="text-sm text-muted-foreground">{request.references.length ? `将发送给 ${request.provider} 的参考素材：${request.references.map(reference => `${reference.title}（${reference.kind}）`).join('、')}` : `本次仅向 ${request.provider} 发送提示词与生成参数。`}</p>
        {request.references.some(reference => reference.kind === 'image') && <div className="flex flex-wrap gap-3" aria-label="本次冻结参考图">{request.references.filter(reference => reference.kind === 'image').map(reference => <a key={reference.media_id} href={workshopReferenceUrl(request.request_id, reference.media_id)} target="_blank" rel="noreferrer" className="block rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-primary"><img src={workshopReferenceUrl(request.request_id, reference.media_id)} alt={reference.title} loading="lazy" className="size-24 rounded-lg object-contain" /></a>)}</div>}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1"><p className="text-sm">{request.estimated_cost_cny === null ? '费用待确认' : `预计费用 ¥${request.estimated_cost_cny.toFixed(2)}`}</p><p className="text-xs text-muted-foreground">{request.price_basis}</p>{decision && <p className="text-xs text-muted-foreground">{decision}</p>}</div>
          {canDecide && <div className="flex items-center gap-2">
            <button type="button" disabled={acting !== null} onClick={() => void decide(request, 'reject')} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50">拒绝</button>
            <button type="button" disabled={acting !== null} onClick={() => void decide(request, 'approve')} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{acting === request.request_id ? '提交中…' : '批准本次生成'}</button>
          </div>}
        </div>
        {request.execution_state === 'needs_review' && <p role="alert" className="text-sm text-destructive">上次执行结果需要人工核对，不会自动重试。</p>}
        {request.job && <div className="border-t border-border pt-3 text-sm text-muted-foreground">{request.job.status === 'done' ? `生成完成 · ${request.job.output_count} 个结果` : request.job.status === 'failed' ? request.job.error ?? '生成失败' : request.job.status === 'cancelled' ? '已取消' : '已批准，正在处理'}<Link href={workshopTargetUrl(request.target)} className="ml-3 underline underline-offset-4">在工坊查看</Link></div>}
      </article>;
    })}</section>
    {total > 20 && <nav aria-label="生成请求分页" className="flex items-center justify-end gap-3 text-sm"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)} className="rounded-md border border-border px-3 py-2 disabled:opacity-50">上一页</button><span>{page} / {Math.ceil(total / 20)}</span><button type="button" disabled={page * 20 >= total || loading} onClick={() => setPage(value => value + 1)} className="rounded-md border border-border px-3 py-2 disabled:opacity-50">下一页</button></nav>}
  </div>;
}
