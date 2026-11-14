import { useEffect, useState } from 'react';
import { draftHttpProtocol, listAssistModels, type AssistDraft, type AssistModel } from '@/api/httpProtocols';
import type { HttpProtocolKind } from '@/schema/httpProtocols';
import { Button } from '@/components/ui/button';
import { HelpIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Hint } from '@/components/ui/tooltip';
import { formatGenerationCost } from '@/lib/generationCost';

const LAST_MODEL = 'atelier.interface-assist-model';
const MAX_URLS = 3;

const HELP = (
  <div className="max-w-xs space-y-1 text-xs">
    <p>用已配置的对话模型读文档，起草一份模板填进左侧，检查后再保存。</p>
    <p>文档只当资料；不会发送任何供应商密钥，文档里的密钥会先遮掉。</p>
    <p>网址最多 {MAX_URLS} 个，用空格分隔，只能是公网地址。</p>
    <p>每次点击调用一次对话模型，按该模型计费。</p>
  </div>
);

const modelKey = (model: Pick<AssistModel, 'alias' | 'model_id'>) => `${model.alias}\n${model.model_id}`;

function readLast(): string | null {
  try { return window.localStorage.getItem(LAST_MODEL); } catch { return null; }
}

function writeLast(value: string) {
  try { window.localStorage.setItem(LAST_MODEL, value); } catch { /* 本机偏好，写不进不影响使用 */ }
}

function usageText(usage: AssistDraft['usage']): string {
  const tokens = usage.input_tokens !== null && usage.output_tokens !== null
    ? `${usage.input_tokens + usage.output_tokens} tokens · ` : '';
  return `本次 ${tokens}${usage.cost_cny === null ? '未计价' : formatGenerationCost(usage.cost_cny)}`;
}

/** 「AI 帮我配置」（ADR-0036）：计费调用，结果只是草稿，交给编辑区照常校验与保存。 */
export function CustomInterfaceAssist({ kind, onDraft, onUndo }: {
  kind: HttpProtocolKind;
  onDraft: (document: Record<string, unknown>) => void;
  onUndo: (() => void) | null;
}) {
  const [models, setModels] = useState<AssistModel[] | null>(null);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [urls, setUrls] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssistDraft | null>(null);

  useEffect(() => {
    let active = true;
    listAssistModels()
      .then(({ models: rows }) => {
        if (!active) return;
        setModels(rows);
        const last = readLast();
        const remembered = rows.find(row => modelKey(row) === last);
        setSelected(remembered ? modelKey(remembered) : rows[0] ? modelKey(rows[0]) : '');
      })
      .catch(e => { if (active) { setModels([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { active = false; };
  }, []);

  const model = models?.find(row => modelKey(row) === selected);
  const urlList = urls.split(/\s+/).filter(Boolean);
  const canRun = Boolean(model) && !running && (text.trim().length > 0 || urlList.length > 0) && urlList.length <= MAX_URLS;

  const run = async () => {
    if (!model) return;
    setRunning(true);
    setError(null);
    setResult(null);
    writeLast(selected);
    try {
      const draft = await draftHttpProtocol({ kind, alias: model.alias, model_id: model.model_id, text, urls: urlList });
      setResult(draft);
      onDraft(draft.document);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-label="AI 帮我配置" className="space-y-2 rounded-md border border-border p-3">
      <Textarea aria-label="接口文档" placeholder="粘贴接口文档" value={text} onChange={e => setText(e.target.value)}
        className="min-h-24 text-xs" />
      <Input aria-label="文档网址" placeholder="文档网址（可选）" value={urls} onChange={e => setUrls(e.target.value)}
        aria-invalid={urlList.length > MAX_URLS} />
      <div className="flex flex-wrap items-center gap-2">
        {models && models.length > 0 && <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger size="sm" aria-label="对话模型" className="w-auto"><SelectValue /></SelectTrigger>
          <SelectContent>{models.map(row => <SelectItem key={modelKey(row)} value={modelKey(row)}>{row.alias} · {row.name}</SelectItem>)}</SelectContent>
        </Select>}
        {models && models.length === 0 && !error && <span className="text-xs text-muted-foreground">没有可用的对话模型</span>}
        {model && <span className="text-xs text-muted-foreground">{model.max_cost_cny === null ? '未计价' : `最多约 ${formatGenerationCost(model.max_cost_cny)}`}</span>}
        <Hint label={HELP}><span tabIndex={0} aria-label="AI 帮我配置说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
        <span className="flex-1" />
        {onUndo && <Button variant="ghost" size="sm" type="button" disabled={running} onClick={onUndo}>撤销</Button>}
        <Button size="sm" type="button" disabled={!canRun} onClick={() => void run()}>{running ? '生成中…' : '生成（消耗对话额度）'}</Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {result && <ul aria-label="生成结果" className="space-y-0.5 text-xs text-muted-foreground">
        {result.notices.map(notice => <li key={notice}>{notice}</li>)}
        <li>{usageText(result.usage)}</li>
      </ul>}
    </section>
  );
}
