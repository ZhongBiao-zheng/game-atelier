import { Tags, X } from 'lucide-react';
import { useId, useState } from 'react';

import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

/** 标签输入：value 是逗号分隔的字符串，Enter / 逗号 / 失焦时把草稿并进去。 */
export function TagField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = new Set(parseTags(value));
  const [draft, setDraft] = useState('');
  const commitDraft = () => { const additions = parseTags(draft); if (!additions.length) return; onChange([...parseTags(value), ...additions].join(', ')); setDraft(''); };
  return (
    <Label className="block space-y-1.5">
      <span className="flex items-center justify-between text-xs text-muted-foreground"><span>标签</span></span>
      <InputGroup><InputGroupAddon><Tags aria-hidden="true" /></InputGroupAddon><InputGroupInput value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitDraft} onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ',') return; event.preventDefault(); commitDraft(); }} placeholder="输入标签，按 Enter 添加" /></InputGroup>
      {current.size > 0 && <div className="flex flex-wrap gap-1.5 pt-1">{[...current].map(tag => <span key={tag} className="group inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-accent hover:text-foreground">{tag}<Button variant="bare" type="button" aria-label={`移除标签 ${tag}`} className="rounded-full transition-colors group-hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => onChange(parseTags(value).filter(item => item !== tag).join(', '))}><X className="size-3" /></Button></span>)}</div>}
    </Label>
  );
}

/** 类别：可选，填项目已有的类别或新写一个；空字符串 = 不带类别。 */
export function CategoryField({ value, onChange, options, disabled }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  disabled?: boolean;
}) {
  const listId = useId();
  return (
    <Label className="block space-y-1.5">
      <span className="text-xs text-muted-foreground">类别</span>
      <Input value={value} list={listId} maxLength={24} disabled={disabled} placeholder="不设类别"
        onChange={event => onChange(event.target.value)} />
      <datalist id={listId}>{options.map(option => <option key={option} value={option} />)}</datalist>
    </Label>
  );
}

/** 中英文逗号都算分隔；去空、去重、保序。 */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))];
}
