import { useEffect, useId, useMemo } from 'react';
import { Film, Music, Plus, X } from 'lucide-react';
import type { VideoControlCaps, VideoFrameMode, VideoMode } from '@/lib/videoControlCaps';

interface Props {
  caps: VideoControlCaps;
  mode: VideoMode;
  frameMode: VideoFrameMode;
  images: File[];
  videos: File[];
  audios: File[];
  onImagesChange: (files: File[]) => void;
  onVideosChange: (files: File[]) => void;
  onAudiosChange: (files: File[]) => void;
}

const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;

export function VideoReferenceAssets({
  caps,
  mode,
  frameMode,
  images,
  videos,
  audios,
  onImagesChange,
  onVideosChange,
  onAudiosChange,
}: Props) {
  if (mode === 't2v') return null;

  return (
    <div className="flex flex-wrap items-start gap-4">
      {mode === 'i2v' && frameMode === 'firstlast' && (
        <>
          <FixedSlot label="上传首帧" file={images[0]} accept="image/*"
            onPick={(f) => onImagesChange(replaceAt(images, 0, f))}
            onRemove={() => onImagesChange(removeAt(images, 0))} />
          <FixedSlot label="上传末帧" file={images[1]} accept="image/*"
            onPick={(f) => onImagesChange(replaceAt(images, 1, f))}
            onRemove={() => onImagesChange(removeAt(images, 1))} />
        </>
      )}

      {mode === 'i2v' && frameMode !== 'firstlast' && (
        <FixedSlot
          label={frameMode === 'first' ? '上传首帧' : '上传源图'}
          file={images[0]} accept="image/*"
          onPick={(f) => onImagesChange([f])}
          onRemove={() => onImagesChange([])} />
      )}

      {mode === 'ref' && (
        <MultiSlot label="上传参考图" icon="image" accept="image/*" files={images}
          max={MAX_REF_IMAGES} onChange={onImagesChange} />
      )}

      {(mode === 'ref' || mode === 'v2v') && caps.supportsReferenceVideo && (
        <MultiSlot
          label={mode === 'v2v' ? '上传视频底' : '上传参考视频'}
          icon="video" accept="video/*" files={videos}
          max={MAX_REF_VIDEOS} onChange={onVideosChange} />
      )}

      {mode === 'v2v' && (
        <MultiSlot label="上传参考图" icon="image" accept="image/*" files={images}
          max={MAX_REF_IMAGES} onChange={onImagesChange} />
      )}

      {mode === 'ref' && caps.supportsReferenceAudio && (
        <MultiSlot label="上传参考音频" icon="audio" accept="audio/*" files={audios}
          max={MAX_REF_AUDIOS} onChange={onAudiosChange} />
      )}
    </div>
  );
}

function replaceAt(arr: File[], idx: number, file: File): File[] {
  const next = [...arr];
  next[idx] = file;
  return next;
}

function removeAt(arr: File[], idx: number): File[] {
  return arr.filter((_, i) => i !== idx);
}

const SLOT = 'h-[70px] w-[56px]';

/** 单个固定语义槽（源图/首帧/末帧）。 */
function FixedSlot({
  label, file, accept, onPick, onRemove,
}: {
  label: string;
  file: File | undefined;
  accept: string;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputId = useId();
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const caption = label.replace('上传', '');

  return (
    <div className="flex flex-col items-center gap-1">
      <input id={inputId} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} />
      {file && preview ? (
        <div className={`relative ${SLOT} overflow-hidden rounded-lg border-[1.5px] border-white bg-card shadow-md`}>
          <img src={preview} alt={caption} className="h-full w-full object-cover" />
          <button type="button" aria-label={`移除${caption}`} onClick={onRemove}
            className="absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-secondary border border-border/60 text-muted-foreground hover:text-foreground">
            <X size={10} />
          </button>
        </div>
      ) : (
        <label htmlFor={inputId} aria-label={label}
          className={`flex ${SLOT} cursor-pointer items-center justify-center rounded-lg border border-dashed border-border/60 bg-secondary transition-all hover:-translate-y-0.5 hover:border-primary/50`}>
          <Plus size={18} className="text-muted-foreground" />
        </label>
      )}
      <span className="text-[11px] text-muted-foreground">{caption}</span>
    </div>
  );
}

/** 多文件槽（参考图/参考视频/视频底/参考音频）。 */
function MultiSlot({
  label, icon, accept, files, max, onChange,
}: {
  label: string;
  icon: 'image' | 'video' | 'audio';
  accept: string;
  files: File[];
  max: number;
  onChange: (files: File[]) => void;
}) {
  const inputId = useId();
  const caption = label.replace('上传', '');
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{caption}</span>
      <div className="flex flex-wrap items-center gap-2">
        {files.map((file, i) => (
          <AssetChip key={i} file={file} icon={icon}
            onRemove={() => onChange(files.filter((_, j) => j !== i))} />
        ))}
        {files.length < max && (
          <>
            <input id={inputId} type="file" accept={accept} multiple className="hidden"
              onChange={(e) => {
                const picked = e.target.files ? Array.from(e.target.files) : [];
                if (picked.length) onChange([...files, ...picked].slice(0, max));
                e.target.value = '';
              }} />
            <label htmlFor={inputId} aria-label={label}
              className={`flex ${SLOT} cursor-pointer items-center justify-center rounded-lg border border-dashed border-border/60 bg-secondary transition-all hover:-translate-y-0.5 hover:border-primary/50`}>
              <Plus size={18} className="text-muted-foreground" />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

function AssetChip({ file, icon, onRemove }: { file: File; icon: 'image' | 'video' | 'audio'; onRemove: () => void }) {
  const preview = useMemo(() => (icon === 'image' ? URL.createObjectURL(file) : null), [file, icon]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  return (
    <div className={`relative ${SLOT} overflow-hidden rounded-lg border-[1.5px] border-white bg-card shadow-md`}>
      {preview ? (
        <img src={preview} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted-foreground">
          {icon === 'video' ? <Film size={18} /> : <Music size={18} />}
          <span className="w-full truncate text-center text-[9px]">{file.name}</span>
        </div>
      )}
      <button type="button" aria-label={`移除 ${file.name}`} onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-secondary border border-border/60 text-muted-foreground hover:text-foreground">
        <X size={10} />
      </button>
    </div>
  );
}
