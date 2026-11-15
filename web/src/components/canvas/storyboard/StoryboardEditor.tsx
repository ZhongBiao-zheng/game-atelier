import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddIcon, DeleteIcon, DragHandleIcon, HelpIcon, MoreIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { Hint } from '@/components/ui/tooltip';
import {
  STORYBOARD_CAMERA_MOVES, STORYBOARD_ENTITY_KINDS, STORYBOARD_ENTITY_KIND_LABELS, STORYBOARD_MAX_DURATION_S,
  STORYBOARD_MAX_ENTITIES, STORYBOARD_MAX_SHOTS, STORYBOARD_MIN_DURATION_S, STORYBOARD_RATIOS, STORYBOARD_SHOT_SIZES,
  STORYBOARD_TEXT_LIMITS, addStoryboardEntity, addStoryboardShot, duplicateStoryboardShot, emptyStoryboardEntity,
  emptyStoryboardShot, formatStoryboardDuration, moveStoryboardShot, removeStoryboardEntity, removeStoryboardShot,
  storyboardShotLabel, storyboardTotalDuration, updateStoryboardEntity, updateStoryboardShot,
  type StoryboardEntityKind, type StoryboardPayload, type StoryboardShot,
} from '@/lib/canvasStoryboard';
import { cn } from '@/lib/utils';

import { StoryboardGenerate, type GenerateRequest } from './StoryboardGenerate';
import {
  ShotStateDot, StoryboardThumb, shotMediaState, storyboardShotMeta, type StoryboardEditorTab, type StoryboardHost,
} from './StoryboardNodeBody';
import { NO_IMAGE_FOR_VIDEO, composeShotImagePrompt, type ShotGenerationKind } from './storyboardGeneration';
import { StoryboardScript } from './StoryboardScript';

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

interface EditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时停在哪个页签。 */
  initialTab?: StoryboardEditorTab;
  title: string;
  payload: StoryboardPayload;
  host: StoryboardHost;
  nodeId: string;
  /** 写回节点；超过载荷上限时返回 false 并已提示。 */
  write: (next: StoryboardPayload) => boolean;
}

/** 分镜编辑弹窗：左列表右表单。删除镜头不删除它的图片与视频节点。 */
export function StoryboardEditor({ open, onOpenChange, initialTab = 'shots', title, payload, host, nodeId, write }: EditorProps) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [generate, setGenerate] = useState<GenerateRequest | null>(null);
  const [tab, setTab] = useState<StoryboardEditorTab>(initialTab);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // 连续输入只记一步撤销：一次聚焦内的第一次改动才记历史。
  const recorded = useRef(false);
  const selected = payload.shots.find(shot => shot.id === selectedId) ?? payload.shots[0] ?? null;

  /** 结构性改动（增、删、排序）每次各记一步撤销。 */
  const change = (next: StoryboardPayload) => {
    if (next === payload) return false;
    host.recordHistory();
    return write(next);
  };
  const type = (next: StoryboardPayload) => {
    if (!recorded.current) {
      host.recordHistory();
      recorded.current = true;
    }
    write(next);
  };
  const endTyping = () => { recorded.current = false; };
  /** 范围：勾选了就用勾选的；没勾选时取还没出图（或有图但还没出视频）的全部镜头。 */
  const shotsFor = (kind: ShotGenerationKind): string[] => {
    const picked = payload.shots.filter(shot => checked.has(shot.id)).map(shot => shot.id);
    if (picked.length > 0) return picked;
    return payload.shots.filter(shot => {
      const image = shotMediaState(host, shot.image_node_id, 'image');
      if (kind === 'image') return image === 'none' || image === 'failed';
      const video = shotMediaState(host, shot.video_node_id, 'video');
      return image === 'done' && (video === 'none' || video === 'failed');
    }).map(shot => shot.id);
  };
  const addShot = () => {
    const shot = emptyStoryboardShot(newId('s'));
    if (change(addStoryboardShot(payload, shot, selected?.id ?? null))) setSelectedId(shot.id);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(46rem,calc(100dvh-4rem))] max-w-5xl flex-col gap-3 p-4" aria-describedby={undefined}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onBlurCapture={endTyping}>
      <DialogTitle className="pr-10 text-base font-medium">{title}</DialogTitle>
      <Tabs value={tab} onValueChange={value => setTab(value as StoryboardEditorTab)} className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="shots">镜头</TabsTrigger>
          <TabsTrigger value="entities">角色与场景</TabsTrigger>
          <TabsTrigger value="script">剧本</TabsTrigger>
        </TabsList>
        <TabsContent value="shots" className="flex min-h-0 flex-1 gap-3 data-[state=inactive]:hidden">
          <div className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border">
            <ol aria-label="镜头" className="min-h-0 flex-1 overflow-y-auto">
              {payload.shots.map((shot, index) => <li key={shot.id} draggable
                aria-current={shot.id === selected?.id ? 'true' : undefined}
                className={cn('flex cursor-pointer items-center gap-2 border-b border-border px-2 py-2',
                  shot.id === selected?.id ? 'bg-secondary' : 'hover:bg-secondary/60',
                  draggingId === shot.id && 'opacity-50')}
                onClick={() => setSelectedId(shot.id)}
                onDragStart={event => { setDraggingId(shot.id); event.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDraggingId(null)}
                onDragOver={event => { if (draggingId) event.preventDefault(); }}
                onDrop={event => {
                  event.preventDefault();
                  if (draggingId) change(moveStoryboardShot(payload, draggingId, index));
                  setDraggingId(null);
                }}>
                <Checkbox aria-label={`选择镜头 ${storyboardShotLabel(index)}`} checked={checked.has(shot.id)}
                  onClick={event => event.stopPropagation()}
                  onCheckedChange={value => setChecked(current => {
                    const next = new Set(current);
                    if (value === true) next.add(shot.id); else next.delete(shot.id);
                    return next;
                  })} />
                <DragHandleIcon size="sm" className="shrink-0 cursor-grab text-subtle-foreground" />
                <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{storyboardShotLabel(index)}</span>
                <StoryboardThumb host={host} imageNodeId={shot.image_node_id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs tabular-nums text-muted-foreground">{storyboardShotMeta(shot)}</span>
                  <span className="block truncate text-sm">{shot.visual || '未填写画面'}</span>
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground"
                      aria-label={`镜头 ${storyboardShotLabel(index)} 操作`} onClick={event => event.stopPropagation()}>
                      <MoreIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" onClick={event => event.stopPropagation()}>
                    <DropdownMenuItem disabled={index === 0}
                      onSelect={() => change(moveStoryboardShot(payload, shot.id, index - 1))}>上移</DropdownMenuItem>
                    <DropdownMenuItem disabled={index === payload.shots.length - 1}
                      onSelect={() => change(moveStoryboardShot(payload, shot.id, index + 1))}>下移</DropdownMenuItem>
                    <DropdownMenuItem disabled={payload.shots.length >= STORYBOARD_MAX_SHOTS} onSelect={() => {
                      const id = newId('s');
                      if (change(duplicateStoryboardShot(payload, shot.id, id))) setSelectedId(id);
                    }}>复制</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => change(removeStoryboardShot(payload, shot.id))}>删除</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>)}
            </ol>
            <Button variant="ghost" className="h-10 shrink-0 justify-start rounded-none border-t border-border"
              disabled={payload.shots.length >= STORYBOARD_MAX_SHOTS} onClick={addShot}>
              <AddIcon />添加镜头
            </Button>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
            {selected
              ? <ShotForm key={selected.id} shot={selected} payload={payload} host={host}
                onGenerate={kind => setGenerate({ kind, shotIds: [selected.id] })}
                onChange={patch => type(updateStoryboardShot(payload, selected.id, patch))}
                onToggle={patch => change(updateStoryboardShot(payload, selected.id, patch))} />
              : <p className="grid h-full place-items-center text-sm text-muted-foreground">添加镜头后在这里填写</p>}
          </div>
        </TabsContent>
        <TabsContent value="entities" className="min-h-0 flex-1 overflow-y-auto pr-1 data-[state=inactive]:hidden">
          <EntitiesForm payload={payload} host={host} type={type} change={change} />
        </TabsContent>
        <TabsContent value="script" className="min-h-0 flex-1 overflow-y-auto pr-1 data-[state=inactive]:hidden">
          <StoryboardScript payload={payload} host={host} change={change} onWritten={() => setTab('shots')} />
        </TabsContent>
      </Tabs>
      <div className="flex shrink-0 items-center gap-2">
        <p className="text-xs tabular-nums text-muted-foreground">
          {payload.shots.length} 镜 · {formatStoryboardDuration(storyboardTotalDuration(payload))}
          {checked.size > 0 && ` · 已选 ${payload.shots.filter(shot => checked.has(shot.id)).length}`}
        </p>
        <span className="flex-1" />
        {host.planShots && <>
          <Button size="sm" variant="outline" disabled={payload.shots.length === 0}
            onClick={() => setGenerate({ kind: 'video', shotIds: shotsFor('video') })}>生成视频…</Button>
          <Button size="sm" disabled={payload.shots.length === 0}
            onClick={() => setGenerate({ kind: 'image', shotIds: shotsFor('image') })}>生成图片…</Button>
        </>}
      </div>
      <StoryboardGenerate request={generate} nodeId={nodeId} host={host} onClose={() => setGenerate(null)} />
    </DialogContent>
  </Dialog>;
}

function Field({ id, label, hint, children, className }: {
  id: string; label: string; hint?: string; children: React.ReactNode; className?: string;
}) {
  return <div className={cn('space-y-1.5', className)}>
    <div className="flex items-center gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      {hint && <Hint label={hint}>
        <Button variant="ghost" size="icon" type="button" aria-label={`${label}说明`} className="size-5 text-muted-foreground">
          <HelpIcon size="sm" />
        </Button>
      </Hint>}
    </div>
    {children}
  </div>;
}

const UNBOUND = '__unbound__';

/** 镜头绑定哪个图片 / 视频节点：只能选当前画布上已有内容的节点。 */
function BindingSelect({ id, label, hint, type, value, host, onChange }: {
  id: string; label: string; hint: string; type: 'image' | 'video'; value: string | null; host: StoryboardHost;
  onChange: (value: string | null) => void;
}) {
  const options = (host.listNodes?.() ?? []).filter(node => node.type === type
    && host.resolveVersion(node.data.current_version_id)?.kind === type);
  // 已绑定但还没有内容的节点（刚建好、正在生成）也要能显示出来。
  const bound = host.findNode(value ?? '');
  const current = bound?.type === type ? bound : null;
  const listed = current && !options.some(node => node.id === current.id) ? [current, ...options] : options;
  return <Field id={id} label={label} hint={hint}>
    <Select value={current?.id ?? UNBOUND} onValueChange={next => onChange(next === UNBOUND ? null : next)}>
      <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={UNBOUND}>未绑定</SelectItem>
        {listed.map(node => <SelectItem key={node.id} value={node.id}>{node.title}</SelectItem>)}
      </SelectContent>
    </Select>
  </Field>;
}

/** 预设 + 可手输：点预设填入，也可以直接改文字。 */
function PresetInput({ id, value, presets, maxLength, onChange }: {
  id: string; value: string; presets: readonly string[]; maxLength: number; onChange: (value: string) => void;
}) {
  return <div className="space-y-1.5">
    <Input id={id} value={value} maxLength={maxLength} onChange={event => onChange(event.target.value)} />
    <div className="flex flex-wrap gap-1">
      {presets.map(preset => <Button key={preset} type="button" variant={preset === value ? 'secondary' : 'ghost'} size="sm"
        className="h-7 px-2 text-xs" onClick={() => onChange(preset)}>{preset}</Button>)}
    </div>
  </div>;
}

function ShotForm({ shot, payload, host, onChange, onToggle, onGenerate }: {
  shot: StoryboardShot;
  payload: StoryboardPayload;
  host: StoryboardHost;
  onGenerate: (kind: ShotGenerationKind) => void;
  onChange: (patch: Partial<Omit<StoryboardShot, 'id'>>) => void;
  onToggle: (patch: Partial<Omit<StoryboardShot, 'id'>>) => void;
}) {
  const id = (field: string) => `storyboard-${shot.id}-${field}`;
  const imageState = shotMediaState(host, shot.image_node_id, 'image');
  const videoState = shotMediaState(host, shot.video_node_id, 'video');
  const imageNode = host.findNode(shot.image_node_id ?? '');
  const canSyncPrompt = imageNode?.type === 'image' && Boolean(imageNode.data.generation_draft) && imageState !== 'running';
  return <div className="grid grid-cols-2 gap-4">
    {host.planShots && <div className="col-span-2 flex flex-wrap items-center gap-2">
      <ShotStateDot state={imageState} label="图片" />
      <Button size="sm" variant="outline" disabled={imageState === 'running'} onClick={() => onGenerate('image')}>
        {imageState === 'none' ? '出图' : '重新出图'}
      </Button>
      <ShotStateDot state={videoState} label="视频" />
      <Hint label={imageState === 'done' ? '' : NO_IMAGE_FOR_VIDEO}>
        <span tabIndex={imageState === 'done' ? -1 : 0}>
          <Button size="sm" variant="outline" disabled={imageState !== 'done' || videoState === 'running'}
            onClick={() => onGenerate('video')}>{videoState === 'none' ? '出视频' : '重新出视频'}</Button>
        </span>
      </Hint>
      {imageState !== 'done' && <span className="text-xs text-muted-foreground">{NO_IMAGE_FOR_VIDEO}</span>}
      <span className="flex-1" />
      {canSyncPrompt && <Hint label="把镜头表里的提示词、风格前缀和条目描述重新写进这一镜的图片节点。不会开始生成。">
        <Button size="sm" variant="ghost" onClick={() => {
          host.recordHistory();
          host.updateNode(imageNode.id, current => (current.type === 'image' && current.data.generation_draft
            ? { ...current, data: { ...current.data, generation_draft: {
              ...current.data.generation_draft, prompt: composeShotImagePrompt(payload, shot), updated_at: new Date().toISOString(),
            } } } : current));
        }}>更新提示词</Button>
      </Hint>}
    </div>}
    {host.listNodes && <>
      <BindingSelect id={id('image-node')} label="本镜图片" hint="这一镜用哪张图。重新出图后想换回旧结果，在这里改选。"
        type="image" value={shot.image_node_id} host={host} onChange={value => onToggle({ image_node_id: value })} />
      <BindingSelect id={id('video-node')} label="本镜视频" hint="这一镜选定的视频，时间线导出时按它取。"
        type="video" value={shot.video_node_id} host={host} onChange={value => onToggle({ video_node_id: value })} />
    </>}
    <Field id={id('scene')} label="场次">
      <Input id={id('scene')} value={shot.scene} maxLength={STORYBOARD_TEXT_LIMITS.scene}
        onChange={event => onChange({ scene: event.target.value })} />
    </Field>
    <Field id={id('duration')} label="时长" hint="计划时长。出视频时取模型支持的档位里不小于它的最小值。">
      <NumberInput aria-label="时长" value={shot.duration_s} min={STORYBOARD_MIN_DURATION_S} max={STORYBOARD_MAX_DURATION_S}
        step={0.5} unit="秒" onValueChange={value => onToggle({ duration_s: value })} />
    </Field>
    <Field id={id('shot-size')} label="景别">
      <PresetInput id={id('shot-size')} value={shot.shot_size} presets={STORYBOARD_SHOT_SIZES}
        maxLength={STORYBOARD_TEXT_LIMITS.shot_size} onChange={value => onChange({ shot_size: value })} />
    </Field>
    <Field id={id('camera')} label="运镜">
      <PresetInput id={id('camera')} value={shot.camera} presets={STORYBOARD_CAMERA_MOVES}
        maxLength={STORYBOARD_TEXT_LIMITS.camera} onChange={value => onChange({ camera: value })} />
    </Field>
    <Field id={id('visual')} label="画面" className="col-span-2">
      <Textarea id={id('visual')} rows={3} value={shot.visual} maxLength={STORYBOARD_TEXT_LIMITS.visual}
        onChange={event => onChange({ visual: event.target.value })} />
    </Field>
    <Field id={id('dialogue')} label="台词" hint="台词或旁白，说话人写在文字里。" className="col-span-2">
      <Textarea id={id('dialogue')} rows={2} value={shot.dialogue} maxLength={STORYBOARD_TEXT_LIMITS.dialogue}
        onChange={event => onChange({ dialogue: event.target.value })} />
    </Field>
    <Field id={id('entities')} label="涉及" hint="出图时带上这些角色与场景的固定描述和参考图。" className="col-span-2">
      {payload.entities.length === 0
        ? <p className="text-xs text-muted-foreground">在「角色与场景」里添加</p>
        : <div id={id('entities')} className="flex flex-wrap gap-1">
          {payload.entities.map(entity => {
            const pressed = shot.entity_ids.includes(entity.id);
            return <Toggle key={entity.id} size="sm" pressed={pressed} className="h-7 px-2 text-xs"
              onPressedChange={() => onToggle({
                entity_ids: pressed ? shot.entity_ids.filter(item => item !== entity.id) : [...shot.entity_ids, entity.id],
              })}>{entity.name || STORYBOARD_ENTITY_KIND_LABELS[entity.kind]}</Toggle>;
          })}
        </div>}
    </Field>
    <Field id={id('image-prompt')} label="出图提示词" className="col-span-2">
      <Textarea id={id('image-prompt')} rows={4} value={shot.image_prompt} maxLength={STORYBOARD_TEXT_LIMITS.image_prompt}
        onChange={event => onChange({ image_prompt: event.target.value })} />
    </Field>
    <Field id={id('video-prompt')} label="出视频提示词" className="col-span-2">
      <Textarea id={id('video-prompt')} rows={4} value={shot.video_prompt} maxLength={STORYBOARD_TEXT_LIMITS.video_prompt}
        onChange={event => onChange({ video_prompt: event.target.value })} />
    </Field>
  </div>;
}

const NO_REFERENCE = '__none__';

function EntitiesForm({ payload, host, type, change }: {
  payload: StoryboardPayload;
  host: StoryboardHost;
  type: (next: StoryboardPayload) => void;
  change: (next: StoryboardPayload) => boolean;
}) {
  // 参考图只能选当前画布上已有内容的图片节点。
  const images = (host.listNodes?.() ?? []).filter(node => node.type === 'image'
    && host.resolveVersion(node.data.current_version_id)?.kind === 'image');
  return <div className="space-y-4">
    <div className="grid grid-cols-[10rem_1fr] gap-4">
      <Field id="storyboard-ratio" label="画幅">
        <Select value={payload.ratio} onValueChange={ratio => change({ ...payload, ratio })}>
          <SelectTrigger id="storyboard-ratio" aria-label="画幅"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[...new Set([...STORYBOARD_RATIOS, payload.ratio])].map(ratio => <SelectItem key={ratio} value={ratio}>{ratio}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field id="storyboard-style" label="风格前缀" hint="逐字放在每条出图提示词最前。">
        <Textarea id="storyboard-style" rows={2} value={payload.style_prefix} maxLength={STORYBOARD_TEXT_LIMITS.style_prefix}
          onChange={event => type({ ...payload, style_prefix: event.target.value })} />
      </Field>
    </div>
    <ul aria-label="角色与场景" className="space-y-2">
      {payload.entities.map(entity => <li key={entity.id} className="grid grid-cols-[6rem_10rem_1fr_4rem_10rem_auto] items-start gap-2">
        <Select value={entity.kind}
          onValueChange={kind => change(updateStoryboardEntity(payload, entity.id, { kind: kind as StoryboardEntityKind }))}>
          <SelectTrigger aria-label="类型"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STORYBOARD_ENTITY_KINDS.map(kind => <SelectItem key={kind} value={kind}>{STORYBOARD_ENTITY_KIND_LABELS[kind]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input aria-label="名称" placeholder="名称" value={entity.name} maxLength={STORYBOARD_TEXT_LIMITS.entity_name}
          onChange={event => type(updateStoryboardEntity(payload, entity.id, { name: event.target.value }))} />
        <Textarea aria-label="固定描述" placeholder="固定描述" rows={2} value={entity.description}
          maxLength={STORYBOARD_TEXT_LIMITS.entity_description}
          onChange={event => type(updateStoryboardEntity(payload, entity.id, { description: event.target.value }))} />
        <StoryboardThumb host={host} imageNodeId={entity.reference_node_id} />
        <Select value={images.some(node => node.id === entity.reference_node_id) ? entity.reference_node_id! : NO_REFERENCE}
          onValueChange={value => change(updateStoryboardEntity(payload, entity.id, { reference_node_id: value === NO_REFERENCE ? null : value }))}>
          <SelectTrigger aria-label={`${entity.name || STORYBOARD_ENTITY_KIND_LABELS[entity.kind]}的参考图`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_REFERENCE}>无参考图</SelectItem>
            {images.map(node => <SelectItem key={node.id} value={node.id}>{node.title}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" aria-label={`删除${entity.name || STORYBOARD_ENTITY_KIND_LABELS[entity.kind]}`}
          className="text-muted-foreground" onClick={() => change(removeStoryboardEntity(payload, entity.id))}>
          <DeleteIcon />
        </Button>
      </li>)}
    </ul>
    <Button variant="outline" disabled={payload.entities.length >= STORYBOARD_MAX_ENTITIES}
      onClick={() => change(addStoryboardEntity(payload, emptyStoryboardEntity(newId('e'))))}>
      <AddIcon />添加
    </Button>
  </div>;
}
