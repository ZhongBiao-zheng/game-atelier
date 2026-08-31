import { fetchSpec, saveSpec } from '@/api/spec';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Save, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useClipboard } from '../hooks/useClipboard';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Props { characterId: string | null; characterName: string | null; sseSignal: number }

export function SpecForm({ characterId, characterName, sseSignal }: Props) {
  const [content, setContent] = useState('');
  const [serverContent, setServerContent] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [serverRevision, setServerRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn'; msg: string } | null>(null);
  const copyToClipboard = useClipboard();
  const autoSaveTimer = useRef<number | null>(null);
  const loadedCharacter = useRef<string | null>(null);
  const readSequence = useRef(0);
  const savingRef = useRef(false);
  const latest = useRef({ content, dirty, characterId });
  latest.current = { content, dirty, characterId };

  useEffect(() => {
    if (!characterId) return;
    if (loadedCharacter.current !== characterId) {
      loadedCharacter.current = characterId;
      latest.current.dirty = false;
      setContent(''); setServerContent(''); setRevision(null); setServerRevision(null);
      setDirty(false); setToast(null);
    }
    void load(false);
    return () => { readSequence.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, sseSignal]);

  async function load(replace: boolean) {
    if (!characterId) return;
    const sequence = ++readSequence.current;
    try {
      const spec = await fetchSpec(characterId);
      if (sequence !== readSequence.current || latest.current.characterId !== characterId) return;
      setServerContent(spec.content); setServerRevision(spec.revision);
      // A dirty draft keeps the revision it was based on, even after a remote SSE refresh.
      if (replace || !latest.current.dirty) {
        setContent(spec.content); setRevision(spec.revision); setDirty(false);
      }
    } catch (error) {
      if (sequence === readSequence.current) setToast({ kind: 'warn', msg: String(error) });
    }
  }

  useEffect(() => {
    if (!dirty || !characterId || saving || revision === null) return;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      void save(false);
    }, 5000);
    return () => { if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, dirty, characterId, saving, revision]);

  async function save(triggerClipboard: boolean) {
    if (!characterId || revision === null || savingRef.current) return;
    savingRef.current = true; setSaving(true);
    try {
      const result = await saveSpec(characterId, content, revision);
      if (latest.current.characterId !== characterId) return;
      readSequence.current += 1;
      setServerContent(content); setServerRevision(result.revision); setRevision(result.revision);
      setDirty(latest.current.content !== content);
      if (triggerClipboard) {
        const { success } = await copyToClipboard('继续');
        setToast(success
          ? { kind: 'ok', msg: '已保存，切到 CC 按 Cmd+V Enter' }
          : { kind: 'warn', msg: '保存成功，但剪贴板写入失败' });
      }
    } catch (error) {
      if (latest.current.characterId === characterId) {
        setToast({ kind: 'warn', msg: String(error) });
        void load(false);
      }
    } finally { savingRef.current = false; setSaving(false); }
  }

  async function refresh() {
    if (dirty && !window.confirm('放弃未保存的 spec 内容并加载磁盘版本？')) return;
    await load(true);
  }

  if (!characterId) {
    return (
      <section className="h-full border-l border-border/60 bg-card/30 flex flex-col items-center justify-center px-6 text-center">
        <p className="font-display text-display italic text-foreground/65 mb-2">
          档案区
        </p>
        <p className="text-xs text-muted-foreground">选中角色后在此编辑规格</p>
      </section>
    );
  }

  const stale = revision !== null && serverRevision !== null && revision !== serverRevision;

  return (
    <section className="h-full border-l border-border/60 bg-card/30 flex flex-col">
      <header className="flex items-end justify-between px-6 pt-6 pb-4 border-b border-border/40 gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-label text-muted-foreground/70 mb-1">
            spec · 档案
          </div>
          <h2 className="font-display italic text-display tracking-tight truncate text-foreground/95">
            {characterName ?? '—'}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          title="重新从磁盘读取"
          className="shrink-0"
        >
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
      </header>

      {stale && (
        <div className="mx-5 mt-3 flex items-center gap-2 rounded-md border border-[color:var(--status-running)]/30 bg-[color:var(--status-running)]/10 px-3 py-2 text-xs text-[color:var(--status-running)]">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="flex-1">文件已变更</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              if (dirty && !window.confirm('放弃未保存的 spec 内容并采用磁盘版本？')) return;
              setContent(serverContent); setRevision(serverRevision); setDirty(false); setToast(null);
            }}
          >
            采用磁盘版
          </Button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col px-5 pt-4 pb-3 gap-3">
        <Textarea
          value={content}
          readOnly={revision === null}
          onChange={e => { setContent(e.target.value); setDirty(true); }}
          className="flex-1 resize-none font-mono text-sm leading-[1.7] bg-background/40"
          placeholder="角色规格 markdown…"
          spellCheck={false}
        />

        <div className="flex items-center gap-3">
          <Button onClick={() => save(true)} disabled={!dirty || saving || revision === null} size="sm">
            <Save className="size-3.5" />
            保存
          </Button>
          {dirty && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block size-1.5 rounded-full bg-[color:var(--status-running)] animate-pulse" />
              未保存
            </span>
          )}
        </div>

        {toast && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2 text-xs',
              toast.kind === 'ok'
                ? 'bg-[color:var(--status-done)]/15 border border-[color:var(--status-done)]/30 text-[color:var(--status-done)]'
                : 'bg-[color:var(--status-running)]/15 border border-[color:var(--status-running)]/30 text-[color:var(--status-running)]',
            )}
          >
            {toast.kind === 'ok'
              ? <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
              : <AlertCircle className="size-3.5 shrink-0 mt-0.5" />}
            <span>{toast.msg}</span>
          </div>
        )}
      </div>

    </section>
  );
}
