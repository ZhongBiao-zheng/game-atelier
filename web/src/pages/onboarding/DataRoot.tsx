import { useState } from 'react';
import { chooseFolder } from '@/api/folders';
import { setDataRoot } from '@/api/onboarding';

interface Props {
  onComplete: () => void;
}

const DEFAULT_PATHS = [
  { label: '~/character-workflow/（推荐）', value: '~/character-workflow' },
  {
    label: '~/Documents/character-workflow/（iCloud / OneDrive 同步）',
    value: '~/Documents/character-workflow',
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
      const picked = await chooseFolder('选择项目文件夹', path || DEFAULT_PATHS[0].value);
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
      <h1 className="text-2xl">第一次使用 Game Atelier</h1>
      <p>你的角色 / 图片 / 项目要存到哪？</p>
      <div className="space-y-2">
        {DEFAULT_PATHS.map(opt => (
          <label key={opt.value} className="flex items-center gap-3">
            <input
              type="radio"
              name="data-root"
              checked={path === opt.value}
              onChange={() => setPath(opt.value)}
            />
            <span>{opt.label}</span>
          </label>
        ))}
        <label className="flex items-center gap-3">
          <input
            type="radio"
            name="data-root"
            checked={isCustom}
            onChange={() => setPath('')}
          />
          <span>自定义</span>
        </label>
      </div>
      <div>
        <label htmlFor="path-input" className="block text-sm mb-1">数据目录路径</label>
        <div className="flex gap-2">
          <input
            id="path-input"
            type="text"
            value={path}
            readOnly
            className="w-full border rounded px-3 py-2 font-mono text-sm text-muted-foreground"
          />
          <button
            type="button"
            onClick={pickFolder}
            disabled={saving || choosing}
            className="shrink-0 px-3 py-2 border rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {choosing ? '选择中...' : '选择文件夹'}
          </button>
        </div>
      </div>
      {error && <div className="text-red-600">{error}</div>}
      <button
        type="button"
        onClick={save}
        disabled={!path || saving || choosing}
        className="px-4 py-2 bg-stone-900 text-white rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {saving ? '保存中...' : '保存并继续'}
      </button>
    </div>
  );
}
