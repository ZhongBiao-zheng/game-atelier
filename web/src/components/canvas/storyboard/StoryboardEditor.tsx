import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
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

import { StoryboardThumb, storyboardShotMeta, type StoryboardHost } from './StoryboardNodeBody';

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

interface EditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  payload: StoryboardPayload;
  host: StoryboardHost;
  /** 写回节点；超过载荷上限时返回 false 并已提示。 */
  write: (next: StoryboardPayload) => boolean;
}

/** 分镜编辑弹窗：左列表右表单。删除镜头不删除它的图片与视频节点。 */
export function StoryboardEditor({ open, onOpenChange, title, payload, host, write }: EditorProps) {
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
  const addShot = () => {
    const shot = emptyStoryboardShot(newId('s'));
    if (change(addStoryboardShot(payload, shot, selected?.id ?? null))) setSelectedId(shot.id);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(46rem,calc(100dvh-4rem))] max-w-5xl flex-col gap-3 p-4" aria-describedby={undefined}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onBlurCapture={endTyping}>
      <DialogTitle className="pr-10 text-base font-medium">{title}</DialogTitle>
      <Tabs defaultValue="shots" className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="shots">镜头</TabsTrigger>
          <TabsTrigger value="entities">角色与场景</TabsTrigger>
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
              ? <ShotForm key={selected.id} shot={selected} payload={payload}
                onChange={patch => type(updateStoryboardShot(payload, selected.id, patch))}
                onToggle={patch => change(updateStoryboardShot(payload, selected.id, patch))} />
              : <p className="grid h-full place-items-center text-sm text-muted-foreground">添加镜头后在这里填写</p>}
          </div>
        </TabsContent>
        <TabsContent value="entities" className="min-h-0 flex-1 overflow-y-auto pr-1 data-[state=inactive]:hidden">
          <EntitiesForm payload={payload} type={type} change={change} />
        </TabsContent>
      </Tabs>
      <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {payload.shots.length} 镜 · {formatStoryboardDuration(storyboardTotalDuration(payload))}
      </p>
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

function ShotForm({ shot, payload, onChange, onToggle }: {
  shot: StoryboardShot;
  payload: StoryboardPayload;
  onChange: (patch: Partial<Omit<StoryboardShot, 'id'>>) => void;
  onToggle: (patch: Partial<Omit<StoryboardShot, 'id'>>) => void;
}) {
  const id = (field: string) => `storyboard-${shot.id}-${field}`;
  return <div className="grid grid-cols-2 gap-4">
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

function EntitiesForm({ payload, type, change }: {
  payload: StoryboardPayload;
  type: (next: StoryboardPayload) => void;
  change: (next: StoryboardPayload) => boolean;
}) {
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
      {payload.entities.map(entity => <li key={entity.id} className="grid grid-cols-[7rem_12rem_1fr_auto] items-start gap-2">
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
