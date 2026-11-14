import { useEffect, useState } from 'react';
import { deleteHttpProtocol, listHttpProtocols } from '@/api/httpProtocols';
import type { HttpProtocolRow } from '@/schema/httpProtocols';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { CustomInterfaceDialog } from './CustomInterfaceDialog';

const KIND_LABELS = { image: '图片', video: '视频' } as const;

/** 供应商页底部的自定义接口列表（ADR-0036）。新建入口在模型行的「接口」下拉里，这里只管编辑与删除。 */
export function CustomInterfacesSection() {
  const [rows, setRows] = useState<HttpProtocolRow[]>([]);
  const [editing, setEditing] = useState<HttpProtocolRow | null>(null);
  const [deleting, setDeleting] = useState<HttpProtocolRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => listHttpProtocols()
      .then(result => { if (active) setRows(result.protocols); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    void load();
    window.addEventListener(KEYS_CHANGED_EVENT, load);
    return () => { active = false; window.removeEventListener(KEYS_CHANGED_EVENT, load); };
  }, []);

  if (rows.length === 0 && !error) return null;

  const remove = async (row: HttpProtocolRow) => {
    setDeleting(null);
    setError(null);
    try {
      await deleteHttpProtocol(row.id);
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section aria-label="自定义接口" className="space-y-2">
      <h2 className="text-sm text-muted-foreground">自定义接口</h2>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {rows.length > 0 && <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{row.name}</p>
            <p className={`text-xs ${row.available ? 'text-muted-foreground' : 'text-destructive'}`}>
              {row.available
                ? `${row.kind ? KIND_LABELS[row.kind] : ''} · ${row.used_by.length ? `${row.used_by.length} 个模型` : '未使用'}`
                : row.error}
            </p>
          </div>
          <Button variant="ghost" size="sm" type="button" onClick={() => setEditing(row)}>编辑</Button>
          <Hint label={row.used_by.length ? '还有模型在使用' : undefined}>
            <span><Button variant="ghost" size="sm" type="button" disabled={row.used_by.length > 0}
              onClick={() => setDeleting(row)}>删除</Button></span>
          </Hint>
        </li>)}
      </ul>}
      {editing && <CustomInterfaceDialog identifier={editing.id} kind={editing.kind ?? 'image'}
        onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open title={`删除「${deleting.name}」？`} message="删除后不能恢复。"
        variant="destructive" onConfirm={() => void remove(deleting)} onCancel={() => setDeleting(null)} />}
    </section>
  );
}
