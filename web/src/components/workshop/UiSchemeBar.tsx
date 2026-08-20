import { useState } from 'react';
import { Check, Plus, Star } from 'lucide-react';
import { Link } from 'wouter';

import type { UiSchemeCreate, UiSchemesFile } from '@/api/uiSchemes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useWorkshopReturn, withWorkshopReturn } from '@/lib/workshopReturn';

export function UiSchemeBar({
  projectId,
  currentSchemeId,
  schemesFile,
  screens,
  onCreate,
  onSetDefault,
}: {
  projectId: string;
  currentSchemeId: string;
  schemesFile: UiSchemesFile;
  screens: Array<{ screen_id: string; name: string }>;
  onCreate: (payload: UiSchemeCreate) => Promise<void>;
  onSetDefault: (schemeId: string) => Promise<void>;
}) {
  const returnContext = useWorkshopReturn();
  const current = schemesFile.schemes.find(item => item.id === currentSchemeId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(`V${schemesFile.schemes.length + 1}`);
  const [copyStyle, setCopyStyle] = useState(true);
  const [copyMap, setCopyMap] = useState(true);
  const [screenIds, setScreenIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleScreen(screenId: string) {
    setScreenIds(value => value.includes(screenId)
      ? value.filter(item => item !== screenId)
      : [...value, screenId]);
  }

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        source_scheme_id: currentSchemeId,
        copy_style: copyStyle,
        copy_screen_map: copyMap,
        screen_ids: screenIds,
      });
      setCreating(false);
    } catch (errorValue) {
      setError((errorValue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await onSetDefault(current.id);
    } catch (errorValue) {
      setError((errorValue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="UI 方案" className="space-y-3 rounded-lg border border-border bg-card/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto" role="navigation" aria-label="切换 UI 方案">
          {schemesFile.schemes.map(scheme => (
            <Link
              key={scheme.id}
              href={withWorkshopReturn(`/workshop/${encodeURIComponent(projectId)}/ui/${encodeURIComponent(scheme.id)}`, returnContext)}
              aria-current={scheme.id === currentSchemeId ? 'page' : undefined}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                scheme.id === currentSchemeId
                  ? 'border-border bg-secondary font-medium text-foreground'
                  : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {scheme.name}
              {scheme.id === schemesFile.default_scheme_id && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                  默认
                </span>
              )}
            </Link>
          ))}
        </div>
        <div className="flex shrink-0 gap-2">
          {current && current.id !== schemesFile.default_scheme_id && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void makeDefault()}
            >
              <Star aria-hidden />
              设为默认
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(value => !value)}>
            <Plus aria-hidden />
            新建方案
          </Button>
        </div>
      </div>

      {error && !creating && <p role="alert" className="text-xs text-destructive">{error}</p>}

      {creating && (
        <form
          aria-label="新建 UI 方案"
          className="space-y-4 border-t border-border/60 pt-4"
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(180px,0.7fr)_minmax(220px,1fr)]">
            <label className="space-y-1.5 text-sm">
              <span className="text-xs text-muted-foreground">方案名称</span>
              <Input value={name} onChange={event => setName(event.target.value)} maxLength={60} />
            </label>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">起点</p>
              <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-sm">
                从当前方案「{current?.name ?? currentSchemeId}」复制
              </p>
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs text-muted-foreground">复制内容</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={copyStyle} onChange={event => setCopyStyle(event.target.checked)} />
                风格说明
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={copyMap} onChange={event => setCopyMap(event.target.checked)} />
                页面地图
              </label>
            </div>
            {screens.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-muted-foreground">指定页面（复制现有版本作为起点，不复制定稿状态）</p>
                <div className="flex flex-wrap gap-2">
                  {screens.map(screen => (
                    <label key={screen.screen_id} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                      <input
                        type="checkbox"
                        checked={screenIds.includes(screen.screen_id)}
                        onChange={() => toggleScreen(screen.screen_id)}
                      />
                      {screen.name || screen.screen_id}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </fieldset>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>取消</Button>
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              <Check aria-hidden />
              {busy ? '创建中…' : '创建并打开'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
