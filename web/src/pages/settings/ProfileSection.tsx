import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { fetchProfile, saveProfile } from '@/api/teamLibraries';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

/** 显示名：分享到团队库的资产用它署名。 */
export function ProfileSection() {
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetchProfile().then(profile => {
      if (!active) return;
      setName(profile.display_name ?? '');
      setSavedName(profile.display_name ?? '');
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);
  const changed = savedName !== null && name.trim() !== savedName;
  async function save() {
    const value = name.trim();
    if (!changed || !value || saving) return;
    setSaving(true);
    setError(null);
    try {
      const profile = await saveProfile(value);
      setName(profile.display_name ?? value);
      setSavedName(profile.display_name ?? value);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return <section id="profile" aria-labelledby="profile-title" className="scroll-mt-6 space-y-2">
    <h2 id="profile-title" className="px-1 text-xs font-normal text-muted-foreground">个人</h2>
    <div className="rounded-xl border border-border bg-card px-4.5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor="profile-name" className="text-sm">显示名 <span className="ml-2 text-xs text-muted-foreground">分享到团队库时署名</span></Label>
        <div className="flex min-w-0 items-center gap-2">
          <Input id="profile-name" aria-label="显示名" value={name} maxLength={40} disabled={savedName === null || saving}
            onChange={event => setName(event.target.value)} className="w-50 min-w-0" />
          {changed && <Button type="button" size="sm" className="shrink-0" onClick={() => void save()} disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  </section>;
}
