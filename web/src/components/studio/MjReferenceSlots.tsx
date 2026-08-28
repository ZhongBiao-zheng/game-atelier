import { useEffect, useId, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';

import { refSlotSupported } from '@/lib/mjParams';
import { imageFamily } from '@/lib/modelFamily';

import { Lightbox } from '../Lightbox';

/** MJ 的四个语义参考槽：图片（垫图 Image Prompt）/ 风格 / 角色 / Omni。
 *
 * 四槽统一样式、都不倾斜（倾斜是首尾帧的视觉语言）。MJ 时通用参考图栏位让位给这里，
 * 避免同一件事两个入口。
 *
 * 传法不同：图片走 body 的 base64Array（吃 base64）；后三种是 prompt flag
 * （--sref / --cref / --oref），只吃公网 URL，由后端经 OSS 中转。
 */
export interface MjRefSlots {
  image: File[];
  sref: File[];
  cref: File[];
  oref: File[];
}

export const EMPTY_MJ_REFS: MjRefSlots = { image: [], sref: [], cref: [], oref: [] };
export const MAX_MJ_REFS_PER_SLOT = 4;

export function routeReusedImageFiles(
  currentModel: string,
  sourceModel: string,
  groups: MjRefSlots,
): { referenceImages: File[]; mjRefs: MjRefSlots; droppedCount: number } {
  const currentIsMj = imageFamily(currentModel) === 'midjourney';
  const sourceIsMj = imageFamily(sourceModel) === 'midjourney';
  if (!currentIsMj) {
    return {
      referenceImages: [...groups.image, ...groups.sref, ...groups.cref, ...groups.oref],
      mjRefs: EMPTY_MJ_REFS,
      droppedCount: 0,
    };
  }
  const limitedGroups: MjRefSlots = {
    image: groups.image.slice(0, MAX_MJ_REFS_PER_SLOT),
    sref: groups.sref.slice(0, MAX_MJ_REFS_PER_SLOT),
    cref: groups.cref.slice(0, MAX_MJ_REFS_PER_SLOT),
    oref: groups.oref.slice(0, MAX_MJ_REFS_PER_SLOT),
  };
  const droppedCount = (Object.keys(groups) as Array<keyof MjRefSlots>)
    .reduce((total, key) => total + Math.max(0, groups[key].length - limitedGroups[key].length), 0);
  return {
    referenceImages: [],
    mjRefs: sourceIsMj ? limitedGroups : { ...EMPTY_MJ_REFS, image: limitedGroups.image },
    droppedCount,
  };
}

const SLOTS: { key: keyof MjRefSlots; label: string; caption: string }[] = [
  { key: 'image', label: '上传垫图', caption: '图片' },
  { key: 'sref', label: '上传风格参考图', caption: '风格' },
  { key: 'cref', label: '上传角色参考图', caption: '角色' },
  { key: 'oref', label: '上传 Omni 参考图', caption: 'Omni' },
];

// 实测：cref 只在 v6 可用、oref 只在 v7 可用，v8.2 两个都会让任务直接失败。
const HINTS: Record<'cref' | 'oref', string> = {
  cref: '角色参考只在 v6 可用（v8.2 会让任务失败）；把版本切到 v6 才能用',
  oref: 'Omni 参考只在 v7 可用（v8.2 会让任务失败）；把版本切到 v7 才能用',
};

function mergeFiles(current: File[], incoming: File[]): File[] {
  const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  return [...current, ...incoming.filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
}

function MjReferenceGroup({
  files, label, caption, disabled, disabledHint, alignRight, onChange, onLimit,
}: {
  files: File[];
  label: string;
  caption: string;
  disabled: boolean;
  disabledHint?: string;
  alignRight: boolean;
  onChange: (files: File[]) => void;
  onLimit: () => void;
}) {
  const inputId = useId();
  const [zoomed, setZoomed] = useState<string | null>(null);
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach((preview) => URL.revokeObjectURL(preview)), [previews]);

  return (
    <div
      aria-label={files.length > 0 ? `${caption}参考，共 ${files.length} 张` : undefined}
      title={disabled ? disabledHint : undefined}
      className={`group relative h-[70px] w-[56px] shrink-0 ${disabled && files.length > 0 ? 'opacity-40' : ''}`}
    >
      <input
        id={inputId}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          if (picked.length > 0) {
            const merged = mergeFiles(files, picked);
            if (merged.length > MAX_MJ_REFS_PER_SLOT) onLimit();
            onChange(merged.slice(0, MAX_MJ_REFS_PER_SLOT));
          }
          event.target.value = '';
        }}
      />
      {files.length === 0 ? (
        <label
          htmlFor={disabled ? undefined : inputId}
          aria-label={label}
          aria-disabled={disabled || undefined}
          title={disabled ? disabledHint : undefined}
          className={`flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-secondary transition-all ${
            disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:-translate-y-0.5 hover:border-input'
          }`}
        >
          <Plus size={16} className="text-muted-foreground" />
          <span className="text-xs leading-none text-muted-foreground">{caption}</span>
        </label>
      ) : (
        <>
          <button
            type="button"
            aria-label={`查看${caption}参考图`}
            disabled={disabled}
            onClick={() => setZoomed(previews[0])}
            className={`relative block h-full w-full overflow-hidden rounded-lg border border-border bg-card p-0 transition-transform duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              disabled ? 'cursor-not-allowed' : 'cursor-zoom-in hover:scale-[1.02]'
            }`}
          >
            <img src={previews[0]} alt={`${caption}参考封面`} className="h-full w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-scrim px-1.5 py-1 text-left text-xs text-foreground">
              {caption} · {files.length}
            </span>
          </button>
          {!disabled && <div className={`invisible absolute bottom-full z-20 grid w-[246px] grid-cols-4 gap-1.5 rounded-xl border border-border bg-card p-2 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 ${alignRight ? 'right-0' : 'left-0'}`}>
            {previews.map((preview, index) => (
              <div key={preview} className="relative h-[70px] w-[52px]">
                <button
                  type="button"
                  aria-label={`查看${caption}参考图 ${index + 1}`}
                  onClick={() => setZoomed(preview)}
                  className="block h-full w-full overflow-hidden rounded-lg border border-border bg-card p-0 transition-transform duration-150 hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <img src={preview} alt={`${caption}参考 ${index + 1}`} className="h-full w-full object-cover" />
                </button>
                <button
                  type="button"
                  aria-label={`移除${caption}参考图 ${index + 1}`}
                  onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))}
                  className="absolute -right-1.5 -top-1.5 z-10 grid h-[18px] w-[18px] place-items-center rounded-full border border-border bg-scrim text-foreground/80 transition-colors hover:bg-destructive hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <X size={10} aria-hidden />
                </button>
              </div>
            ))}
            {files.length < MAX_MJ_REFS_PER_SLOT && (
              <label
                htmlFor={inputId}
                aria-label={`添加${caption}参考图`}
                className="flex h-[70px] w-[52px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-secondary text-muted-foreground transition-colors hover:border-input hover:text-foreground"
              >
                <Plus size={16} aria-hidden />
                <span className="text-xs">继续添加</span>
              </label>
            )}
          </div>}
        </>
      )}
      {zoomed && <Lightbox src={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  );
}

export function MjReferenceSlots({
  refs,
  onChange,
  version,
  srefCodeActive = false,
}: {
  refs: MjRefSlots;
  onChange: (refs: MjRefSlots) => void;
  /** 当前 MJ 版本 —— 角色/Omni 槽按它决定可用性，免得放进一张必然失败的图。 */
  version: string;
  /** 编号式 sref 与图片式 sref 互斥；只禁用槽，不删画师已选文件。 */
  srefCodeActive?: boolean;
}) {
  const [limitNotice, setLimitNotice] = useState(false);
  useEffect(() => {
    if (!limitNotice) return;
    const timer = window.setTimeout(() => setLimitNotice(false), 2400);
    return () => window.clearTimeout(timer);
  }, [limitNotice]);

  return (
    <div className="relative flex items-center gap-1.5 self-center shrink-0">
      {limitNotice && (
        <span
          role="status"
          className="absolute bottom-full left-0 mb-2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
        >
          每个参考槽最多 4 张
        </span>
      )}
      {SLOTS.map(({ key, label, caption }, index) => {
        const gated = key === 'cref' || key === 'oref';
        const versionOff = gated && !refSlotSupported(key, version);
        const codeOff = key === 'sref' && srefCodeActive;
        const off = versionOff || codeOff;
        return (
          <MjReferenceGroup
            key={key}
            label={label}
            caption={caption}
            files={refs[key]}
            disabled={off}
            disabledHint={codeOff
              ? '已使用 sref 编号，清空编号后可继续使用风格参考图'
              : versionOff ? HINTS[key as 'cref' | 'oref'] : undefined}
            alignRight={index >= 2}
            onChange={(files) => onChange({ ...refs, [key]: files })}
            onLimit={() => setLimitNotice(true)}
          />
        );
      })}
    </div>
  );
}
