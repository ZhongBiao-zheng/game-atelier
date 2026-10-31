import { useState } from 'react';
import { chooseFolder } from '@/api/folders';
import { setDataRoot } from '@/api/onboarding';
import { SwapLabel } from '@/components/ui/swap-label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface Props {
  onComplete: () => void;
}

/** RadioGroup 不接受空字符串，「自定义」用这个占位。 */
const CUSTOM_PATH = '__custom__';

const DEFAULT_PATHS = [
  { label: '~/game-atelier/（推荐）', value: '~/game-atelier' },
  {
    label: '~/Documents/game-atelier/（iCloud / OneDrive 同步）',
    value: '~/Documents/game-atelier',
  },
];

export function DataRootPage({ onComplete }: Props) {
  const [path, setPath] = useState(DEFAULT_PATHS[0].value);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setDataRoot(path);
      onComplete();
    } catch (e) {
      setError(String(e));
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
      setError(String(e));
    } finally {
      setChoosing(false);
    }
  };

  const isCustom = !DEFAULT_PATHS.some(o => o.value === path);

  return (
    <div className="max-w-xl mx-auto p-8 space-y-6">
      <h1 className="font-display text-display">第一次使用 Game Atelier</h1>
      <p>你的角色 / 图片 / 项目要存到哪？</p>
      <RadioGroup
        className="gap-2"
        value={isCustom ? CUSTOM_PATH : path}
        onValueChange={value => setPath(value === CUSTOM_PATH ? '' : value)}
      >
        {DEFAULT_PATHS.map(opt => (
          <Label key={opt.value} className="flex items-center gap-3">
            <RadioGroupItem value={opt.value} />
            <span>{opt.label}</span>
          </Label>
        ))}
        <Label className="flex items-center gap-3">
          <RadioGroupItem value={CUSTOM_PATH} />
          <span>自定义</span>
        </Label>
      </RadioGroup>
      <div>
        <Label htmlFor="path-input" className="block text-sm mb-1">数据目录路径</Label>
        <div className="flex gap-2">
          <Input
            id="path-input"
            type="text"
            value={path}
            readOnly
            className="w-full font-mono"
          />
          <Button variant="bare"
            type="button"
            onClick={pickFolder}
            disabled={saving || choosing}
            className="shrink-0 px-3 py-2 border rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {choosing ? '选择中...' : '选择文件夹'}
          </Button>
        </div>
      </div>
      {error && <div className="text-red-600">{error}</div>}
      <Button variant="bare"
        type="button"
        onClick={save}
        disabled={!path || saving || choosing}
        className="px-4 py-2 bg-stone-900 text-white rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <SwapLabel active={Boolean(saving)} on="保存中..." off="保存并继续" />
      </Button>
    </div>
  );
}
