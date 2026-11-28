import { useEffect, useRef, useState } from 'react';
import { requestJson } from '@/api/http';
import { itemUrl, LIBRARY_CHANGED, type LibrarySubject } from '@/api/library';
import { Button } from '@/components/ui/button';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet } from '@/components/ui/sheet';
import { errorText } from '@/lib/errorText';
import { LibrarySourcePicker, sourceThumb, sourceTitle, type Source } from './LibrarySourcePicker';

export function SubjectSheet({ open, subject, onClose, onSaved }: {
  open: boolean; subject?: LibrarySubject; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(subject?.name || '');
  const [handle, setHandle] = useState(subject?.handle || '');
  const [custom, setCustom] = useState(!!subject);
  const [description, setDescription] = useState(subject?.description || '');
  const [added, setAdded] = useState<Source[]>([]);
  const [cover, setCover] = useState(subject ? Math.max(0, subject.item_ids.indexOf(subject.cover_item_id || '')) : 0);
  const [picker, setPicker] = useState<'history' | 'canvas' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);
  const count = (subject?.item_ids.length || 0) + added.length;
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach(url => URL.revokeObjectURL(url));
  }, []);
  useEffect(() => {
    if (custom || !name.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void requestJson<{ handle: string }>('/api/library/handle?name=' + encodeURIComponent(name), '读取标识', { signal: controller.signal })
        .then(r => { if (!controller.signal.aborted) setHandle(r.handle); }).catch(() => {});
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [name, custom]);
  function addFiles(files: File[]) {
    if (count + files.length > 20) { setError('一个主体最多添加 20 个素材'); return; }
    setAdded(old => [...old, ...files.map(file => {
      const url = URL.createObjectURL(file); urls.current.push(url);
      return { type: 'upload' as const, file, url };
    })]);
  }
  async function save() {
    setBusy(true); setError('');
    try {
      const body = new FormData();
      let fileIndex = 0;
      const additions = added.map(s => {
        if (s.type === 'upload') { body.append('files', s.file); return { upload: fileIndex++ }; }
        if (s.type === 'canvas') return { project_id: s.project, version_id: s.version };
        return { job_id: s.row.job_id, output_index: s.row.output_index };
      });
      body.set('payload', JSON.stringify({ name, handle: custom ? handle : null, description, id: subject?.id,
        revision: subject?.revision, cover_index: count ? cover : null, additions }));
      const saved = await requestJson<LibrarySubject>('/api/library/subject-editor', '保存主体', { method: 'POST', body });
      window.dispatchEvent(new Event(LIBRARY_CHANGED)); onSaved(saved.id); onClose();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <Sheet open={open} onOpenChange={v => { if (!v && !busy) onClose(); }} title={subject ? '编辑主体' : '新建主体'}>
    <div className="flex-1 space-y-5 overflow-auto">
      <div className="grid grid-cols-2 gap-3"><Label className="grid gap-2">名称<Input value={name} maxLength={160} onChange={e => setName(e.target.value)} /></Label>
        <Label className="grid gap-2">@标识<Input value={handle} onChange={e => { setCustom(true); setHandle(e.target.value); }} /></Label></div>
      <Label className="grid gap-2">描述<Textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} /></Label>
      <div><div className="mb-2 flex justify-between text-sm">参考素材<span className="text-xs tabular-nums text-muted-foreground">{count}/20</span></div>
        <div className={'rounded-md border border-border p-3 ' + (count ? '' : 'grid min-h-36 place-content-center border-dashed')}
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }}>
          <div className="grid grid-cols-4 gap-1">{[
            ...(subject?.item_ids || []).map(id => ({ url: itemUrl(id), title: '参考素材' })),
            ...added.map(s => ({ url: sourceThumb(s), title: sourceTitle(s) })),
          ].map((item, i) => <Button key={i} variant="ghost" aria-label={'设为封面 ' + (i + 1)} aria-pressed={cover === i}
            className="relative aspect-square h-auto overflow-hidden rounded-sm p-0" onClick={() => setCover(i)}>
            {item.url ? <img className="size-full object-cover" src={item.url} alt={item.title} /> : item.title}
            {i === cover && <span className="absolute bottom-1 left-1 rounded-sm bg-primary px-1 text-xs text-primary-foreground">封面</span>}
          </Button>)}</div>
          <FileInput ref={input} multiple onChange={e => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
          <div className="flex flex-wrap justify-center gap-1 py-2">
            <Button size="sm" variant="outline" disabled={count >= 20} onClick={() => input.current?.click()}>本地上传</Button>
            <Button size="sm" variant="outline" disabled={count >= 20} onClick={() => setPicker('history')}>从历史选</Button>
            <Button size="sm" variant="outline" disabled={count >= 20} onClick={() => setPicker('canvas')}>从画布选</Button>
          </div>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button disabled={!name.trim() || busy || (custom && !handle.trim())} onClick={() => void save()}>保存</Button></div>
    <LibrarySourcePicker open={picker !== null} initial={picker || 'history'} onClose={() => setPicker(null)} onChoose={s => setAdded(a => [...a, s])} />
  </Sheet>;
}
