import { useEffect, useId, useMemo } from 'react';
import { ArrowLeftRight, Film, Music, Plus, X } from 'lucide-react';
import type { VideoControlCaps } from '@/lib/videoControlCaps';

const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;

/** 首尾帧双槽的显式状态：两个槽各自独立可空（仅尾帧也是合法提交）。 */
export interface FrameSlots {
  first: File | null;
  last: File | null;
}

/** 首尾帧模式的双 slot + 互换按钮（置于 prompt 输入框左侧）。
 * 首/尾帧均可独立缺省：仅首帧→frame_mode 'first'，仅尾帧→'last'，双帧→'firstlast'。
 */
export function FirstLastFrames({
  frames,
  onChange,
}: {
  frames: FrameSlots;
  onChange: (frames: FrameSlots) => void;
}) {
  const canSwap = Boolean(frames.first || frames.last);
  return (
    <div className="flex items-center gap-1.5 self-center shrink-0">
      <FixedSlot label="上传首帧" file={frames.first} accept="image/*" tilt="left"
        onPick={(f) => onChange({ ...frames, first: f })}
        onRemove={() => onChange({ ...frames, first: null })} />
      <button
        type="button"
        aria-label="互换首尾帧"
        title="互换首尾帧"
        disabled={!canSwap}
        onClick={() => onChange({ first: frames.last, last: frames.first })}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <ArrowLeftRight size={13} aria-hidden />
      </button>
      <FixedSlot label="上传尾帧" file={frames.last} accept="image/*" tilt="right"
        onPick={(f) => onChange({ ...frames, last: f })}
        onRemove={() => onChange({ ...frames, last: null })} />
    </div>
  );
}

/** 全能参考模式的资产组（图 / 视频 / 音频，按 caps 开放）。 */
export function VideoReferenceAssets({
  caps,
  images,
  videos,
  audios,
  onImagesChange,
  onVideosChange,
  onAudiosChange,
}: {
  caps: VideoControlCaps;
  images: File[];
  videos: File[];
  audios: File[];
  onImagesChange: (files: File[]) => void;
  onVideosChange: (files: File[]) => void;
  onAudiosChange: (files: File[]) => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <MultiSlot label="上传参考图" icon="image" accept="image/*" files={images}
        max={MAX_REF_IMAGES} onChange={onImagesChange} />
      {caps.supportsReferenceVideo && (
        <MultiSlot label="上传参考视频" icon="video" accept="video/*" files={videos}
          max={MAX_REF_VIDEOS} onChange={onVideosChange} />
      )}
      {caps.supportsReferenceAudio && (
        <MultiSlot label="上传参考音频" icon="audio" accept="audio/*" files={audios}
          max={MAX_REF_AUDIOS} onChange={onAudiosChange} />
      )}
    </div>
  );
}

const SLOT = 'h-[70px] w-[56px]';

/** 单个固定语义槽（首帧/尾帧）：语义标注在空槽内 Plus 图标下方，整槽按 tilt 倾斜 8°。 */
function FixedSlot({
  label, file, accept, tilt, onPick, onRemove,
}: {
  label: string;
  file: File | null;
  accept: string;
  tilt: 'left' | 'right';
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputId = useId();
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const caption = label.replace('上传', '');
  const rotate = tilt === 'left' ? '-rotate-[8deg]' : 'rotate-[8deg]';

  if (file && preview) {
    return (
      <div className={`relative ${SLOT} ${rotate} overflow-hidden rounded-lg border-[1.5px] border-white bg-card shadow-md`}>
        <img src={preview} alt={caption} className="h-full w-full object-cover" />
        <button type="button" aria-label={`移除${caption}`} onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-secondary border border-border/60 text-muted-foreground hover:text-foreground">
          <X size={10} />
        </button>
      </div>
    );
  }

  return (
    <>
      <input id={inputId} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} />
      <label htmlFor={inputId} aria-label={label}
        className={`flex ${SLOT} ${rotate} cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 bg-secondary transition-all hover:-translate-y-0.5 hover:border-primary/50`}>
        <Plus size={16} className="text-muted-foreground" />
        <span className="text-[10px] leading-none text-muted-foreground">{caption}</span>
      </label>
    </>
  );
}

/** 多文件槽（参考图/参考视频/参考音频）。 */
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
            className={`flex ${SLOT} cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 bg-secondary transition-all hover:-translate-y-0.5 hover:border-primary/50`}>
            <Plus size={16} className="text-muted-foreground" />
            <span className="text-[10px] leading-none text-muted-foreground">{caption}</span>
          </label>
        </>
      )}
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
