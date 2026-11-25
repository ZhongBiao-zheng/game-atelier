import { useState } from 'react';
import { chooseFolder } from '@/api/folders';
import { setDataRoot } from '@/api/onboarding';
import { SwapLabel } from '@/components/ui/swap-label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { FolderOpenIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import { useRetained } from '@/components/ui/retained';
import { OnboardingFrame } from './OnboardingFrame';

interface Props {
  onComplete: () => void;
}

/** RadioGroup 不接受空字符串，「自定义」用这个占位。 */
const CUSTOM_PATH = '__custom__';

const DEFAULT_PATHS = [
  { value: '~/game-atelier', note: '', recommended: true },
  { value: '~/Documents/game-atelier', note: 'iCloud / OneDrive 同步', recommended: false },
];

const optionClass = 'flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-secondary/60';

/** 首启第一步：存放位置。 */
export function DataRootPage({ onComplete }: Props) {
  const [path, setPath] = useState(DEFAULT_PATHS[0].value);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = useRetained(error);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setDataRoot(path);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    setChoosing(true);
    setError(null);
    try {
      const picked = await chooseFolder('选择存放文件夹', path || DEFAULT_PATHS[0].value);
      if (picked) setPath(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChoosing(false);
    }
  };

  const isCustom = !DEFAULT_PATHS.some(o => o.value === path);
  const selected = isCustom ? CUSTOM_PATH : path;

  return (
    <OnboardingFrame step={1} title="选择存放位置"
      footer={<Button type="button" onClick={() => { void save(); }} disabled={!path || saving || choosing}>
        <SwapLabel active={saving} on="保存中…" off="继续" />
      </Button>}>
      <div className="flex flex-col gap-3">
        <RadioGroup className="gap-2" value={selected}
          onValueChange={value => setPath(value === CUSTOM_PATH ? '' : value)}>
          {DEFAULT_PATHS.map(opt => (
            <Label key={opt.value} className={cn(optionClass, selected === opt.value ? 'border-primary/40' : 'border-border')}>
              <RadioGroupItem value={opt.value} />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{opt.value}</span>
              {opt.note && <span className="text-xs text-muted-foreground">{opt.note}</span>}
              {opt.recommended && <span className="accent-pill rounded-sm px-1.5 py-0.5 text-xs font-medium">推荐</span>}
            </Label>
          ))}
          <Label className={cn(optionClass, isCustom ? 'border-primary/40' : 'border-border')}>
            <RadioGroupItem value={CUSTOM_PATH} />
            <span className="flex-1 text-sm">自定义</span>
          </Label>
        </RadioGroup>
        <Collapse open={isCustom}><div className="flex gap-2">
          <Label htmlFor="path-input" className="sr-only">数据目录路径</Label>
          <Input id="path-input" value={path} readOnly placeholder="选择一个文件夹" className="min-w-0 flex-1 font-mono" />
          <Button variant="outline" type="button" onClick={() => { void pickFolder(); }} disabled={saving || choosing}>
            <FolderOpenIcon aria-hidden /><SwapLabel active={choosing} on="选择中…" off="选择文件夹" />
          </Button>
        </div></Collapse>
        <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
      </div>
    </OnboardingFrame>
  );
}
