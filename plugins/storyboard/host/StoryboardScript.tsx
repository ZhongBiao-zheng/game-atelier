import { useEffect, useState } from 'react';

import {
  listStoryboardParseModels, parseStoryboardSegment, planStoryboardParse,
  type StoryboardParseModel, type StoryboardParseResult,
} from './api';
import { ApiError } from '@/api/http';
import { Button } from '@/components/ui/button';
import { CloseIcon, HelpIcon } from '@/components/ui/icons';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import {
  STORYBOARD_MAX_SCRIPT_NODES, formatStoryboardDuration, mergeParsedStoryboard, storyboardShotLabel,
  type StoryboardPayload,
} from './canvasStoryboard';
import { formatGenerationCost } from '@/lib/generationCost';
import type { CanvasNode } from '@/schema/canvas';

import type { StoryboardHost } from './StoryboardNodeBody';

const LAST_MODEL = 'atelier.storyboard-parse-model';
const HELP = '把剧本交给对话模型拆成镜头。每点一次只解析一段、只调用一次模型，失败不会自动重试；'
  + '结果先在这里预览，点「写入」才进分镜。剧本超过 8000 字会分成几段。';

function modelKey(model: StoryboardParseModel) {
  return `${model.alias}\u0000${model.model_id}`;
}
function readLast(): string | null {
  try { return window.localStorage.getItem(LAST_MODEL); } catch { return null; }
}
function writeLast(value: string) {
  try { window.localStorage.setItem(LAST_MODEL, value); } catch { /* 本机偏好，写不进不影响使用 */ }
}
function newId(prefix: 's' | 'e'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function usageText(results: readonly StoryboardParseResult[]): string {
  const costs = results.map(result => result.usage.cost_cny);
  const tokens = results.reduce((sum, result) => sum + (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0), 0);
  const cost = costs.some(value => value === null) ? '未计价'
    : formatGenerationCost(costs.reduce<number>((sum, value) => sum + (value ?? 0), 0));
  return `${results.length} 次调用 · ${tokens > 0 ? `${tokens} tokens · ` : ''}${cost}`;
}

/** 编辑弹窗的「剧本」页签：选剧本来源与对话模型，逐段解析，预览后写入。解析是计费调用。 */
export function StoryboardScript({ payload, host, change, onWritten }: {
  payload: StoryboardPayload;
  host: StoryboardHost;
  /** 记一步撤销并写回节点；超过载荷上限时返回 false 并已提示。 */
  change: (next: StoryboardPayload) => boolean;
  onWritten: () => void;
}) {
  const [models, setModels] = useState<StoryboardParseModel[] | null>(null);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [segmentCount, setSegmentCount] = useState<number | null>(null);
  const [results, setResults] = useState<StoryboardParseResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRaw, setErrorRaw] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listStoryboardParseModels(host.projectId)
      .then(({ models: rows }) => {
        if (!active) return;
        setModels(rows);
        const remembered = rows.find(row => modelKey(row) === readLast());
        setSelected(remembered ? modelKey(remembered) : rows[0] ? modelKey(rows[0]) : '');
      })
      .catch(e => { if (active) { setModels([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { active = false; };
  }, [host.projectId]);

  const textOf = (node: CanvasNode | undefined) => {
    const version = node?.type === 'text' ? host.resolveVersion(node.data.current_version_id) : undefined;
    return version?.kind === 'text' ? version.text : '';
  };
  // 来源只认当前文档里有内容的文本节点。
  const sources = payload.script_node_ids.flatMap(id => {
    const node = host.findNode(id);
    return node?.type === 'text' && textOf(node).trim() ? [node] : [];
  });
  const addable = (host.listNodes?.() ?? []).filter(node => node.type === 'text' && textOf(node).trim()
    && !payload.script_node_ids.includes(node.id));
  const model = models?.find(row => modelKey(row) === selected);
  const resetProgress = () => { setSegmentCount(null); setResults([]); setError(null); setErrorRaw(null); };
  const setSources = (ids: string[]) => {
    if (change({ ...payload, script_node_ids: ids })) resetProgress();
  };

  const done = segmentCount !== null && results.length >= segmentCount;
  const canRun = Boolean(model) && sources.length > 0 && !running && !done;
  const run = async () => {
    if (!model) return;
    setRunning(true);
    setError(null);
    setErrorRaw(null);
    writeLast(selected);
    try {
      // 服务端只读已保存的剧本：先把页面上还没保存的编辑落盘。
      await host.savePendingEdits?.();
      const ids = sources.map(node => node.id);
      const count = segmentCount ?? (await planStoryboardParse(host.projectId, ids)).segments.length;
      setSegmentCount(count);
      const known = new Map<string, { kind: string; name: string; description: string }>();
      for (const entity of [...payload.entities, ...results.flatMap(result => result.entities)]) {
        if (entity.name && !known.has(entity.name)) known.set(entity.name, { kind: entity.kind, name: entity.name, description: entity.description });
      }
      const result = await parseStoryboardSegment(host.projectId, {
        script_node_ids: ids, segment_index: results.length, segment_count: count,
        alias: model.alias, model_id: model.model_id, entities: [...known.values()], style_prefix: payload.style_prefix,
      });
      setResults(current => [...current, result]);
    } catch (e) {
      // 剧本在解析途中变了：已解析的段对不上新分段，从头来。
      if (e instanceof ApiError && e.status === 409) { setSegmentCount(null); setResults([]); }
      setError(e instanceof ApiError && e.reason ? e.reason : e instanceof Error ? e.message : String(e));
      setErrorRaw(e instanceof ApiError ? e.raw : null);
    } finally {
      setRunning(false);
    }
  };

  const write = () => {
    const merged = mergeParsedStoryboard(payload, results, mode, newId);
    if (!change(merged.payload)) return;
    if (merged.droppedShots > 0) host.reportError?.(`超出上限的 ${merged.droppedShots} 个镜头没有写入`);
    resetProgress();
    onWritten();
  };

  const parsedShots = results.flatMap(result => result.shots);
  const notices = [...new Set(results.flatMap(result => result.notices))];
  const runLabel = running ? '解析中…'
    : segmentCount !== null && segmentCount > 1 ? `解析第 ${results.length + 1} / ${segmentCount} 段（消耗对话额度）`
      : '解析（消耗对话额度）';

  return <div className="space-y-4">
    <section aria-label="剧本来源" className="space-y-2">
      <p className="text-xs text-muted-foreground">剧本</p>
      {sources.length === 0 && <p className="text-sm text-muted-foreground">选择放着剧本的文本节点</p>}
      <ul className="space-y-1">
        {sources.map(node => <li key={node.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{textOf(node).trim().length} 字</span>
          <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={`移除 ${node.title}`}
            disabled={running} onClick={() => setSources(payload.script_node_ids.filter(id => id !== node.id))}>
            <CloseIcon />
          </Button>
        </li>)}
      </ul>
      {addable.length > 0 && payload.script_node_ids.length < STORYBOARD_MAX_SCRIPT_NODES
        && <Select value="" onValueChange={id => setSources([...payload.script_node_ids, id])} disabled={running}>
          <SelectTrigger size="sm" aria-label="添加文本节点" className="w-auto"><SelectValue placeholder="添加文本节点" /></SelectTrigger>
          <SelectContent>{addable.map(node => <SelectItem key={node.id} value={node.id}>{node.title}</SelectItem>)}</SelectContent>
        </Select>}
    </section>

    <div className="flex flex-wrap items-center gap-2">
      {models && models.length > 0 && <Select value={selected} onValueChange={setSelected} disabled={running}>
        <SelectTrigger size="sm" aria-label="对话模型" className="w-auto"><SelectValue /></SelectTrigger>
        <SelectContent>{models.map(row => <SelectItem key={modelKey(row)} value={modelKey(row)}>{row.alias} · {row.name}</SelectItem>)}</SelectContent>
      </Select>}
      {models && models.length === 0 && !error && <span className="text-xs text-muted-foreground">没有可用的对话模型</span>}
      {model && <span className="text-xs text-muted-foreground">
        {model.max_cost_cny === null ? '未计价' : `每段最多约 ${formatGenerationCost(model.max_cost_cny)}`}
      </span>}
      <Hint label={HELP}><span tabIndex={0} aria-label="解析剧本说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
      <span className="flex-1" />
      {!done && <Button size="sm" type="button" variant={results.length > 0 ? 'outline' : 'default'} disabled={!canRun}
        onClick={() => void run()}>{runLabel}</Button>}
    </div>

    {error && <div role="alert" className="space-y-1 text-xs">
      <p className="text-destructive">{error}</p>
      {errorRaw && <details>
        <summary className="cursor-pointer text-muted-foreground">详情</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-secondary/40 p-2 font-mono text-muted-foreground">{errorRaw}</pre>
      </details>}
    </div>}

    {results.length > 0 && <section aria-label="解析结果" className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm tabular-nums">
        {segmentCount !== null && segmentCount > 1 && `已解析 ${results.length} / ${segmentCount} 段 · `}
        {parsedShots.length} 镜 · {formatStoryboardDuration(parsedShots.reduce((sum, shot) => sum + shot.duration_s, 0))}
        {' · '}新增条目 {results.reduce((sum, result) => sum + result.entities.length, 0)}
      </p>
      <ol aria-label="解析出的镜头" className="max-h-64 space-y-1 overflow-y-auto">
        {parsedShots.map((shot, index) => <li key={index} className="flex gap-2 text-sm">
          <span className="w-6 shrink-0 text-xs tabular-nums leading-5 text-muted-foreground">{storyboardShotLabel(index)}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs tabular-nums text-muted-foreground">
              {[shot.shot_size, shot.camera, formatStoryboardDuration(shot.duration_s)].filter(Boolean).join(' · ')}
            </span>
            <span className="block">{shot.visual || '未填写画面'}</span>
          </span>
        </li>)}
      </ol>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {notices.map(notice => <li key={notice}>{notice}</li>)}
        <li>{usageText(results)}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {payload.shots.length > 0 && <Segmented aria-label="写入方式" className="w-36 grid-cols-2">
          <SegmentedItem value="append" selected={mode === 'append'} onSelect={() => setMode('append')}>追加</SegmentedItem>
          <SegmentedItem value="replace" selected={mode === 'replace'} onSelect={() => setMode('replace')}>替换</SegmentedItem>
        </Segmented>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" type="button" disabled={running} onClick={resetProgress}>放弃</Button>
        <Button size="sm" type="button" variant={done ? 'default' : 'outline'} disabled={running} onClick={write}>写入</Button>
      </div>
    </section>}
  </div>;
}
