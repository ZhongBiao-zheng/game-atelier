import { useEffect, useState } from 'react';
import { fetchGatewayMembers, restoreGatewayMember, type GatewayMembers } from '@/api/gateway';
import { date } from './lan-sharing/shared';
import { ChevronLeft } from 'lucide-react';

import { listModelRoutes, setModelRouteOrder, type ModelRoute } from '@/api/models';

const MODALITY_LABELS: Record<ModelRoute['modality'], string> = {
  image: '图片',
  video: '视频',
  text: '文本',
  audio: '音频',
};

/** 同一模型挂在多家时的供应商顺序：选「自动」时按这个顺序用第一家。 */
export function ModelRoutesSection({ reloadToken }: { reloadToken: number }) {
  const [status, setStatus] = useState<GatewayMembers>({ members: [], unavailable_routes: [] });
  const [restoring, setRestoring] = useState(false);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGatewayMembers().then(data => { if (!cancelled) setStatus(data); }).catch(() => {});
    listModelRoutes()
      .then(rows => { if (!cancelled) setRoutes(rows); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  const shared = routes.filter(route => route.members.length > 1 || status.members.some(member =>
    member.modality === route.modality && member.route_ids.includes(route.id)));
  if (!shared.length && !error) return null;

  async function restore(modality: string, alias: string) {
    setRestoring(true);
    try { setStatus(await restoreGatewayMember(modality, alias)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRestoring(false); }
  }

  async function moveEarlier(route: ModelRoute, index: number) {
    const aliases = route.members.map(member => member.alias);
    [aliases[index - 1], aliases[index]] = [aliases[index], aliases[index - 1]];
    setSavingId(route.id);
    setError(null);
    try {
      const saved = await setModelRouteOrder(route.modality, route.id, aliases);
      setRoutes(current => current.map(item => (
        item.id === saved.id && item.modality === saved.modality ? saved : item
      )));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section aria-label="模型路由">
      {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {shared.map(route => (
          <div key={`${route.modality}:${route.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{route.name}</p>
              {status.unavailable_routes.some(item => item.id === route.id && item.modality === route.modality) && (
                <p className="text-xs text-destructive">全部成员欠费</p>
              )}
              <p className="text-xs text-muted-foreground">{MODALITY_LABELS[route.modality]}</p>
            </div>
            <ol aria-label={`${route.name} 的供应商顺序`} className="flex flex-wrap items-center gap-1.5">
              {route.members.map((member, index) => (
                <li key={member.alias} className="flex items-center gap-1 rounded-md border border-border py-1 pl-2 pr-1 text-xs">
                  <span className="text-muted-foreground">{index + 1}</span>
                  <span className="text-foreground">{member.alias}</span>
                  {status.members.filter(item => item.modality === route.modality && item.alias === member.alias)
                    .map(item => <span key={item.alias} className="flex items-center gap-2 text-destructive">
                      {item.reason === 'unavailable' ? '暂时不可用' : `欠费已摘除 · ${date(item.since)}`}
                      {item.reason !== 'unavailable' && <>
                      <button type="button" disabled={restoring}
                        className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
                        onClick={() => void restore(item.modality, item.alias)}>恢复</button>
                      </>}
                    </span>)}
                  {index > 0 ? (
                    <button
                      type="button"
                      aria-label={`把 ${member.alias} 提前`}
                      disabled={savingId !== null}
                      onClick={() => void moveEarlier(route, index)}
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                    >
                      <ChevronLeft className="size-3.5" aria-hidden />
                    </button>
                  ) : <span className="w-1" aria-hidden />}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
