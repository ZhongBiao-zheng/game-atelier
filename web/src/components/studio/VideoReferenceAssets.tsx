import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowLeftRight, Plus, X } from 'lucide-react';

import { Lightbox } from '../Lightbox';

export const MAX_REF_IMAGES = 9;
export const MAX_REF_VIDEOS = 3;
export const MAX_REF_AUDIOS = 3;

/** 首尾帧双槽的显式状态：两个槽各自独立可空（仅尾帧也是合法提交）。 */
export interface FrameSlots {
  first: File | null;
  last: File | null;
}

/** 首尾帧模式的双 slot + 互换按钮（置于 prompt 输入框左侧）。
 * 首/尾帧均可独立缺省：仅首帧→frame_mode 'first'，仅尾帧→'last'，双帧→'firstlast'。
 * maxFrames=1（happyhorse i2v 等只收首帧的族）时只渲染首帧槽，隐藏互换钮与尾帧槽。
 */
export function FirstLastFrames({
  frames,
  onChange,
  maxFrames = 2,
}: {
  frames: FrameSlots;
  onChange: (frames: FrameSlots) => void;
  maxFrames?: 1 | 2;
}) {
  const canSwap = Boolean(frames.first || frames.last);
  return (
    <div className="flex items-center gap-1.5 self-center shrink-0">
      <FixedSlot label="上传首帧" file={frames.first} accept="image/*" tilt="left"
        onPick={(f) => onChange({ ...frames, first: f })}
        onRemove={() => onChange({ ...frames, first: null })} />
      {maxFrames >= 2 && (
        <>
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
        </>
      )}
    </div>
  );
}

const SLOT = 'h-[70px] w-[56px]';

/** 单个固定语义槽：语义标注在空槽内 Plus 图标下方。
 *  tilt 给了才倾斜 8°（首尾帧的视觉语言）；MJ 的参考槽不倾斜。
 *  caption 缺省时从 label 去掉「上传」推导。
 *  已放图的槽：hover 微微放大、点击开大图（与出图历史的参考堆叠同款手感）。 */
export function FixedSlot({
  label, file, accept, tilt, caption: captionProp, disabled, disabledHint, onPick, onRemove,
}: {
  label: string;
  file: File | null;
  accept: string;
  tilt?: 'left' | 'right';
  caption?: string;
  /** 该语义在当前模型/版本下不可用：空槽变灰不可点，已有的图仍可移除。 */
  disabled?: boolean;
  disabledHint?: string;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const inputId = useId();
  const [zoomed, setZoomed] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const caption = captionProp ?? label.replace('上传', '');
  const rotate = tilt === 'left' ? '-rotate-[8deg]' : tilt === 'right' ? 'rotate-[8deg]' : '';

  if (file && preview) {
    return (
      // 删除钮必须在 overflow-hidden 圆角框外层，否则左上突出的部分会被圆角裁掉。
      <div className={`relative ${SLOT} ${rotate} transition-transform duration-200 hover:scale-[1.12]`}>
        <button type="button" aria-label={`查看${caption}大图`} onClick={() => setZoomed(true)}
          className="block h-full w-full cursor-zoom-in overflow-hidden rounded-lg border-[1.5px] border-white bg-card p-0">
          <img src={preview} alt={caption} className="h-full w-full object-cover" />
        </button>
        <button type="button" aria-label={`移除${caption}`} onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 z-10 grid h-[18px] w-[18px] place-items-center rounded-full bg-scrim backdrop-blur-glass border border-border text-foreground/80 hover:bg-destructive hover:text-foreground transition-colors">
          <X size={10} />
        </button>
        {zoomed && <Lightbox src={preview} onClose={() => setZoomed(false)} />}
      </div>
    );
  }

  return (
    <>
      <input id={inputId} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} />
      <label
        htmlFor={disabled ? undefined : inputId}
        aria-label={label}
        aria-disabled={disabled || undefined}
        title={disabled ? disabledHint : undefined}
        className={`flex ${SLOT} ${rotate} flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-secondary transition-all ${
          disabled
            ? 'cursor-not-allowed opacity-40'
            : 'cursor-pointer hover:-translate-y-0.5 hover:border-input'
        }`}>
        <Plus size={16} className="text-muted-foreground" />
        <span className="text-xs leading-none text-muted-foreground">{caption}</span>
      </label>
    </>
  );
}

