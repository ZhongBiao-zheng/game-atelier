import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { fetchProfile, saveProfile } from '@/api/teamLibraries';

/** 显示名：分享到团队库的资产用它署名。 */
export function ProfileSection() {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProfile()
      .then(profile => setName(profile.display_name ?? ''))
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function save() {
    const value = name.trim();
    if (!value) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const profile = await saveProfile(value);
      setName(profile.display_name ?? value);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div>
        <h2 className="text-xs uppercase tracking-label text-muted-foreground/70">显示名</h2>
      </div>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="显示名"
            value={name}
            maxLength={40}
            onChange={event => {
              setName(event.target.value);
              setSaved(false);
            }}
            className="max-w-xs"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background"
          >
            保存
          </button>
        </div>
        {saved && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-1.5 rounded-full bg-[color:var(--status-done)]" aria-hidden />
            已保存
          </div>
        )}
        {error && <div className="text-sm text-destructive">{error}</div>}
      </div>
    </>
  );
}
