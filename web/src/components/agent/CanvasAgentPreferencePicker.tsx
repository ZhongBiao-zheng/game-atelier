import { useMemo, useRef, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CheckIcon, ChevronDownIcon, ModelIcon } from '@/components/ui/icons';
import { ModelBrandIcon } from '@/components/ModelBrandIcon';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { modelBrand } from '@/lib/modelCatalog';
import { providerLabel } from '@/lib/providerLabels';
import { cn } from '@/lib/utils';
import type {
  CanvasAgentCreationMode, CanvasAgentGenerationModel, CanvasAgentModelRef,
} from '@/schema/canvas';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type Kind = 'image' | 'video';
const KINDS: Kind[] = ['image', 'video'];
const KIND_LABELS: Record<Kind, string> = { image: '图像', video: '视频' };

const sameRef = (a: CanvasAgentModelRef, b: CanvasAgentModelRef) => a.alias === b.alias && a.model === b.model;

/**
 * 模型偏好：自动 = Agent 从全部可用模型里挑。关掉自动后只能用勾选的模型（与服务端 ModelScope.models
 * 一致）：一个都没勾就不能生成。勾选结果在自动打开时也保留，再关掉时恢复。
 * 图像 / 视频两页始终都在（偏好与当前创作模式无关），页内按供应商（Key 别名）分组。
 */
export function CanvasAgentPreferencePicker({ models, mode, auto, preferred, triggerClassName, direction = 'up', label, disabled, onChange }: {
  models: CanvasAgentGenerationModel[] | null;
  mode: CanvasAgentCreationMode;
  auto: boolean;
  preferred: CanvasAgentModelRef[];
  triggerClassName?: string;
  direction?: 'up' | 'down';
  label?: string;
  disabled?: boolean;
  onChange: (update: { auto_models?: boolean; preferred_models?: CanvasAgentModelRef[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Kind | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  // 没手动切过页时跟着创作模式走：视频创作默认看视频页。
  const activeKind: Kind = tab ?? (mode === 'video' ? 'video' : 'image');
  const isChosen = (item: CanvasAgentModelRef) => preferred.some(ref => sameRef(ref, item));
  const chosenCount = (kind: Kind) => (models ?? []).filter(item => item.kind === kind && isChosen(item)).length;
  const rows = useMemo(() => (models ?? []).filter(item => item.kind === activeKind), [models, activeKind]);
  const groups = useMemo(() => {
    // alias 为 null 的是「智能路由」组。
    const byAlias = new Map<string, CanvasAgentGenerationModel[]>();
    for (const item of rows) {
      const groupKey = item.alias ?? '智能路由';
      byAlias.set(groupKey, [...(byAlias.get(groupKey) ?? []), item]);
    }
    return [...byAlias.entries()];
  }, [rows]);

  function toggle(item: CanvasAgentGenerationModel) {
    const ref = { alias: item.alias, model: item.model };
    // 自动开着时点某个模型：关掉自动并只选它，一次完成。
    if (auto) {
      onChange({ auto_models: false, preferred_models: [ref] });
      return;
    }
    onChange({ preferred_models: isChosen(ref)
      ? preferred.filter(existing => !sameRef(existing, ref)) : [...preferred, ref] });
  }

  const totalChosen = chosenCount('image') + chosenCount('video');

  return (
    <>
      <Hint label={auto ? '模型偏好：自动' : `模型偏好：图像 ${chosenCount('image')} 个，视频 ${chosenCount('video')} 个`}><Button variant="bare"
        ref={anchorRef}
        type="button"
        aria-label="模型偏好"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40',
          label && 'flex w-auto gap-1.5 px-2.5 text-xs',
          open && 'bg-secondary text-foreground',
          triggerClassName,
        )}
      >
        <ModelIcon size="sm" className={!auto ? 'text-primary' : undefined} />
        {label && <span>{auto ? label : `${label} (${totalChosen})`}</span>}
        {label && <ChevronDownIcon size="sm" className="text-muted-foreground" />}
      </Button></Hint>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        direction={direction}
        align="start"
        maxHeight={400}
        aria-label="模型偏好"
        className="flex w-80 flex-col gap-2 rounded-xl border border-border bg-card p-2.5"
      >
        <div className="flex items-center justify-between px-1">
          <p className="text-sm font-medium">模型偏好</p>
          <Label className="flex items-center gap-2 text-xs text-muted-foreground">
            自动
            <Switch
              size="sm"
              checked={auto}
              aria-label="自动选择模型"
              disabled={disabled}
              onCheckedChange={checked => onChange({ auto_models: checked })}
            />
          </Label>
        </div>
        <Tabs activationMode="manual" value={activeKind} onValueChange={value => setTab(value as typeof activeKind)}>
          <TabsList aria-label="模型类型" className="grid h-8 w-full grid-cols-2">
            {KINDS.map(kind => (
              <TabsTrigger key={kind} value={kind} className="text-xs">
                {KIND_LABELS[kind]}
                {!auto && <span className="tabular-nums text-muted-foreground">{chosenCount(kind)}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div role="listbox" aria-multiselectable aria-label={`${KIND_LABELS[activeKind]}模型`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1">
          {!models && <p className="px-3 py-3 text-xs text-muted-foreground">加载中…</p>}
          {models && rows.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">没有可用的{KIND_LABELS[activeKind]}模型</p>}
          {groups.map(([groupAlias, items]) => {
            const head = items[0];
            const isAutoGroup = head?.alias === null;
            const groupLabel = isAutoGroup ? '智能路由' : (head?.provider ? providerLabel(head.provider, groupAlias) : groupAlias);
            return (
              <div key={groupAlias} role="group" aria-label={groupAlias} className="flex flex-col gap-0.5 pb-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-xs text-muted-foreground">
                  <ProviderBrandIcon provider={isAutoGroup ? { provider: 'auto' } : { provider: head?.provider ?? undefined, base_url: head?.base_url, alias: groupAlias, icon: head?.icon }} size="sm" />
                  <span className="truncate">{groupLabel}</span>
                  {!isAutoGroup && groupLabel !== groupAlias && <span className="truncate text-subtle-foreground">· {groupAlias}</span>}
                </div>
                {items.map(item => {
                  const checked = !auto && isChosen(item);
                  return (
                    <Button variant="bare"
                      key={`${item.alias}/${item.model}`}
                      type="button"
                      role="option"
                      aria-selected={checked}
                      aria-disabled={disabled}
                      disabled={disabled}
                      onClick={() => toggle(item)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-secondary/60 disabled:opacity-50 disabled:hover:bg-transparent aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-inset aria-selected:ring-primary/60',
                        auto && 'opacity-60 hover:opacity-100',
                      )}
                    >
                      <span className={checked ? 'text-foreground' : 'text-muted-foreground'}>
                        <ModelBrandIcon brand={modelBrand(item.model)} size="md" />
                      </span>
                      <Hint label={item.model}><span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span></Hint>
                      {checked && <CheckIcon size="sm" className="shrink-0 text-primary" />}
                    </Button>
                  );
                })}
              </div>
            );
          })}
        </div>
        {!auto && chosenCount(activeKind) === 0 && rows.length > 0 && (
          <p className="px-1 text-xs text-muted-foreground">未选{KIND_LABELS[activeKind]}模型，Agent 无法生成{KIND_LABELS[activeKind]}</p>
        )}
      </ToolbarPopover>
    </>
  );
}
