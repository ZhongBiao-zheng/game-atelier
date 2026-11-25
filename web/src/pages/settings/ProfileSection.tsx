import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { fetchProfile, saveProfile } from '@/api/teamLibraries';
import { CheckIcon } from '@/components/ui/icons';
import { Label } from '@/components/ui/label';
import { errorText } from '@/lib/errorText';

/** 显示名：分享到团队库的资产用它署名。 */
export function ProfileSection() {
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [justSaved]);
  useEffect(() => {
    let active = true;
    fetchProfile().then(profile => {
      if (!active) return;
      setName(profile.display_name ?? '');
      setSavedName(profile.display_name ?? '');
    }).catch(e => { if (active) setError(errorText(e)); });
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
      setJustSaved(true);
    } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  return <section id="profile" aria-labelledby="profile-title" className="scroll-mt-6 space-y-2">
    <h2 id="profile-title" className="px-1 text-xs font-normal text-muted-foreground">个人</h2>
    <div className="rounded-xl border border-border bg-card px-4.5 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor="profile-name" className="text-sm">显示名 <span className="ml-2 text-xs text-muted-foreground">分享到团队库时署名</span></Label>
        <div className="flex min-w-0 items-center gap-2">
          {/* 单值控件即时保存（规格 2.5）：回车或离开输入框就存，存好原位打勾。
              切走窗口引起的失焦不算编辑完，输入法组合中的回车不处理。 */}
          <Input id="profile-name" aria-label="显示名" value={name} maxLength={40} disabled={savedName === null}
            aria-invalid={changed && !name.trim() ? true : undefined}
            onChange={event => { setName(event.target.value); setJustSaved(false); }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save(); }}
            onBlur={() => { if (document.hasFocus()) void save(); }} className="w-50 min-w-0" />
          <span className="flex size-4 shrink-0 items-center justify-center">
            {justSaved && <CheckIcon size="sm" role="img" aria-label="已保存" className="content-swap-in text-[color:var(--status-done)]" />}
          </span>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  </section>;
}
