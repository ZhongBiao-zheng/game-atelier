import { useRef, useState, type RefObject } from 'react';
import { Settings2 } from 'lucide-react';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { MJ_IMAGES_PER_TASK, QUALITY_LABELS, type ImageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { CanvasModelPicker, OptionTrack } from './CanvasGenerationControls';
import type { EditModelChoice } from './imageEditGeometry';
import { Button } from '@/components/ui/button';

const TIERS = ['1K', '2K', '4K'];
const TIER_SUFFIX = /\s*[·\-–]?\s*[24]K$/i;

/** `nano-banana-2-4k` → 基础型号 `nano-banana-2` + 档位 4K；没有后缀的是 1K。 */
function variantOf(model: string) {
  const match = /^(.*)-([24])k$/i.exec(model);
  return match ? { base: match[1], tier: `${match[2]}K` } : { base: model, tier: '1K' };
}

const chipClass ='flex h-9 max-w-full items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function OptionChip({ label, summary, values, selected, getLabel, onSelect, portalContainerRef }: {
  label: string; summary: string; values: readonly (string | number)[]; selected: string;
  getLabel: (value: string) => string; onSelect: (value: string) => void;
  portalContainerRef: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchorRef} className="relative min-w-0">
      <Button variant="bare" type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)} className={chipClass}>
        <span className="truncate">{summary}</span>
      </Button>
      <ToolbarPopover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} autoFocus direction="up"
        portalContainerRef={portalContainerRef} className="w-64 rounded-xl border border-border bg-card p-3">
        <OptionTrack label={label} values={values} selected={selected} getLabel={value => getLabel(String(value))}
          onSelect={value => { onSelect(String(value)); setOpen(false); }} />
      </ToolbarPopover>
    </div>
  );
}

/** 编辑器底栏的模型 / 分辨率（或质量）/ 张数，沿用画布生成面板的控件：模型按供应商分组。 */
export function EditGenerationControls({ choices, choice, onChoice, caps, resolution, onResolution, quality, onQuality,
  count, onCount }: {
  choices: EditModelChoice[]; choice: EditModelChoice | undefined; onChoice: (choice: EditModelChoice) => void;
  caps: ImageControlCaps; resolution: string | undefined; onResolution: (value: string) => void;
  quality: string | undefined; onQuality: (value: string) => void;
  count: number; onCount: (value: number) => void;
}) {
  // 编辑器是模态 Dialog：弹层挂到 body 会被它禁掉指针事件，挂进 Dialog 自己。
  const portalContainerRef = useRef<HTMLElement | null>(null);
  // 同一渠道的 xxx / xxx-2k / xxx-4k 是同一个模型的分辨率档：选择器里合成一项，档位放到分辨率里切。
  const family = (item: EditModelChoice) => `${item.key.alias}\u0000${variantOf(item.model).base}`;
  const members = (item: EditModelChoice) => choices.filter(other => family(other) === family(item))
    .sort((a, b) => TIERS.indexOf(variantOf(a.model).tier) - TIERS.indexOf(variantOf(b.model).tier));
  const pickerChoices = choices.flatMap(item => {
    const representative = members(item)[0];
    if (representative !== item) return [];
    const tier = choice ? variantOf(choice.model).tier : '1K';
    const effective = members(item).find(member => variantOf(member.model).tier === tier) ?? item;
    const model = item.key.models.find(spec => spec.id === effective.model);
    return model ? [{ key: item.key, model: { ...model, name: (model.name || model.id).replace(TIER_SUFFIX, '') } }] : [];
  });
  const tiers = choice ? members(choice) : [];
  const showTiers = tiers.length > 1;
  const showResolution = Boolean(choice && !choice.mj && !showTiers && caps.showResolution && caps.resolutions.length > 0);
  const showQuality = Boolean(choice && !choice.mj && !showTiers && !showResolution && caps.qualities?.length);
  return <>
    <div ref={element => { portalContainerRef.current = element?.closest<HTMLElement>('[role="dialog"]') ?? null; }}
      className="min-w-0 basis-56">
      <CanvasModelPicker choices={pickerChoices} alias={choice?.key.alias ?? null} model={choice?.model ?? ''}
        portalContainerRef={portalContainerRef}
        params={{ resolution, quality, image_edit: { mode: 'edit' } }}
        onSelect={picked => {
          const next = choices.find(item => item.key.alias === picked.key.alias && item.model === picked.model.id);
          // 换模型时尽量保留当前分辨率档。
          const tier = choice ? variantOf(choice.model).tier : '1K';
          if (next) onChoice(members(next).find(item => variantOf(item.model).tier === tier) ?? next);
        }} />
    </div>
    {showTiers && choice && <OptionChip label="分辨率" summary={variantOf(choice.model).tier}
      values={tiers.map(item => variantOf(item.model).tier)} selected={variantOf(choice.model).tier} getLabel={value => value}
      onSelect={value => { const next = tiers.find(item => variantOf(item.model).tier === value); if (next) onChoice(next); }}
      portalContainerRef={portalContainerRef} />}
    {showResolution && resolution && <OptionChip label="分辨率" summary={resolution} values={caps.resolutions}
      selected={resolution} getLabel={value => value} onSelect={onResolution} portalContainerRef={portalContainerRef} />}
    {showQuality && quality && <OptionChip label="质量" summary={QUALITY_LABELS[quality as Quality] ?? quality}
      values={caps.qualities ?? []} selected={quality} getLabel={value => QUALITY_LABELS[value as Quality] ?? value}
      onSelect={onQuality} portalContainerRef={portalContainerRef} />}
    {!choice ? null : choice.mj
      ? <span className={`${chipClass} pointer-events-none`}><Settings2 className="size-3.5" aria-hidden="true" />{MJ_IMAGES_PER_TASK} 张 · Fast</span>
      : <OptionChip label="生成数量" summary={`${count} 张`} values={[1, 2, 3, 4]} selected={String(count)}
        getLabel={value => `${value} 张`} onSelect={value => onCount(Number(value))} portalContainerRef={portalContainerRef} />}
  </>;
}
