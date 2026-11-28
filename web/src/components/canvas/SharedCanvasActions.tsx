import { useState } from 'react';
import { useLocation } from 'wouter';
import { createCanvasProject, listCanvasProjects } from '@/api/canvas';
import { request } from '@/api/http';
import { remoteMediaUrl } from '@/api/collab';
import { copySharedNodes, sharedStudioReference } from '@/api/collabTransfer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useRetained } from '@/components/ui/retained';
import { setSharedStudioInput } from '@/pages/sharedStudioInput';
import { notify } from '@/lib/notify';
import { errorText } from '@/lib/errorText';
import type { CanvasDocument, CanvasProject } from '@/schema/canvas';
import { pathFileName } from '@/lib/pathName';

export function SharedCanvasActions({ peerKey, projectId, document, nodeIds, className = 'flex flex-wrap items-center gap-1' }: {
  peerKey: string; projectId: string; document: CanvasDocument; nodeIds: string[];
  /** 放进外层操作条时传 contents，按钮和外层其他按钮排成同一行。 */
  className?: string;
}) {
  const [, navigate] = useLocation();
  const [projects, setProjects] = useState<CanvasProject[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // 关闭的退场里列表照旧显示，不闪成空弹窗。
  const shownProjects = useRetained(projects);
  const node = nodeIds.length === 1 ? document.nodes.find(item => item.id === nodeIds[0]) : undefined;
  const versionId = node && 'current_version_id' in node.data ? node.data.current_version_id : null;
  const version = versionId ? document.content_versions[versionId] : undefined;
  const generation = version?.frozen_generation;
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { notify.error(errorText(error)); }
    finally { setBusy(false); }
  }
  async function copy(target: string) {
    await copySharedNodes(peerKey, projectId, nodeIds, target);
    setProjects(null);
    notify.info('已复制到我的画布');
  }
  return <div className={className}>
    <Button size="sm" variant="ghost" disabled={busy || !nodeIds.length}
      onClick={() => void run(async () => setProjects(await listCanvasProjects(true)))}>复制到我的画布…</Button>
    {version && version.kind !== 'text' && <Button size="sm" variant="ghost" disabled={busy}
      onClick={() => void run(async () => {
        const { path } = await sharedStudioReference(peerKey, projectId, version.version_id);
        const response = await request('/api/raw?path=' + encodeURIComponent(path), '读取本地参考');
        const file = new File([await response.blob()], pathFileName(path) || 'reference', { type: version.mime_type });
        setSharedStudioInput({ kind: 'reference', file, title: node?.title || '共享画布' });
        navigate('/studio');
      })}>用作参考</Button>}
    {generation && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
      const inputs = [];
      for (const row of generation.inputs) {
        if (!row.version_id) continue;
        const ref = document.content_versions[row.version_id];
        if (!ref || ref.kind === 'text') throw new Error('参考媒体已失效');
        const response = await request(remoteMediaUrl(peerKey, projectId, row.version_id), '读取生成参考');
        const file = new File([await response.blob()], `ref-${row.order}.${ref.mime_type.split('/')[1]}`, { type: ref.mime_type });
        inputs.push({ row, file });
      }
      setSharedStudioInput({ kind: 'prompt', generation, inputs });
      navigate('/studio');
    })}>在创作台复刻提示词</Button>}
    <Dialog open={projects !== null} onOpenChange={open => { if (!open) setProjects(null); }}>
      <DialogContent><DialogHeader><DialogTitle>复制到我的画布</DialogTitle></DialogHeader>
        <div className="grid max-h-72 gap-1 overflow-y-auto">{shownProjects?.map(project =>
          <Button key={project.project_id} disabled={busy} variant="ghost" className="justify-start"
            onClick={() => void run(() => copy(project.project_id))}>{project.name}</Button>)}</div>
        <form autoComplete="off" className="flex gap-2" onSubmit={event => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          void run(async () => {
            const created = await createCanvasProject(name.trim());
            setProjects(previous => [...(previous || []), created]);
            setName('');
            await copy(created.project_id);
          });
        }}><Input aria-label="新画布名称" placeholder="新画布名称" value={name}
          onChange={event => setName(event.target.value)} />
          <Button type="submit" disabled={busy || !name.trim()}>新建并复制</Button></form>
      </DialogContent>
    </Dialog>
  </div>;
}
