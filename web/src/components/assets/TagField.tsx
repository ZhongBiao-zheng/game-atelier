import { Tags, X } from 'lucide-react';
import { useState } from 'react';

import { Input } from '@/components/ui/input';

/** 标签输入：value 是逗号分隔的字符串，Enter / 逗号 / 失焦时把草稿并进去。 */
export function TagField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = new Set(parseTags(value));
  const [draft, setDraft] = useState('');
  const commitDraft = () => { const additions = parseTags(draft); if (!additions.length) return; onChange([...parseTags(value), ...additions].join(', ')); setDraft(''); };
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between text-xs text-muted-foreground"><span>标签</span></span>
      <div className="relative"><Tags className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitDraft} onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ',') return; event.preventDefault(); commitDraft(); }} placeholder="输入标签，按 Enter 添加" className="pl-9" /></div>
      {current.size > 0 && <div className="flex flex-wrap gap-1.5 pt-1">{[...current].map(tag => <span key={tag} className="group inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-accent hover:text-foreground">{tag}<button type="button" aria-label={`移除标签 ${tag}`} className="rounded-full transition-colors group-hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => onChange(parseTags(value).filter(item => item !== tag).join(', '))}><X className="size-3" /></button></span>)}</div>}
    </label>
  );
}

/** 中英文逗号都算分隔；去空、去重、保序。 */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))];
}
