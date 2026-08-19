import { FixedSlot } from './VideoReferenceAssets';

/** MJ 的四个语义参考槽：图片（垫图 Image Prompt）/ 风格 / 角色 / Omni。
 *
 * 四槽统一样式、都不倾斜（倾斜是首尾帧的视觉语言）。MJ 时通用参考图栏位让位给这里，
 * 避免同一件事两个入口。
 *
 * 传法不同：图片走 body 的 base64Array（吃 base64）；后三种是 prompt flag
 * （--sref / --cref / --oref），只吃公网 URL，由后端经 OSS 中转。
 */
export interface MjRefSlots {
  image: File | null;
  sref: File | null;
  cref: File | null;
  oref: File | null;
}

export const EMPTY_MJ_REFS: MjRefSlots = { image: null, sref: null, cref: null, oref: null };

const SLOTS: { key: keyof MjRefSlots; label: string; caption: string }[] = [
  { key: 'image', label: '上传垫图', caption: '图片' },
  { key: 'sref', label: '上传风格参考图', caption: '风格' },
  { key: 'cref', label: '上传角色参考图', caption: '角色' },
  { key: 'oref', label: '上传 Omni 参考图', caption: 'Omni' },
];

const CREF_HINT = '角色参考只在 v6 / niji 6 支持，v7 之后由 Omni 接手；把版本切到 v6 才能用';

export function MjReferenceSlots({
  refs,
  onChange,
  crefEnabled = true,
}: {
  refs: MjRefSlots;
  onChange: (refs: MjRefSlots) => void;
  /** 当前版本是否支持 --cref。false 时角色槽变灰，避免放进去一张会被后端摘掉的图。 */
  crefEnabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 self-center shrink-0">
      {SLOTS.map(({ key, label, caption }) => {
        const off = key === 'cref' && !crefEnabled;
        return (
          <FixedSlot
            key={key}
            label={label}
            caption={caption}
            file={refs[key]}
            accept="image/*"
            disabled={off}
            disabledHint={off ? CREF_HINT : undefined}
            onPick={(f) => onChange({ ...refs, [key]: f })}
            onRemove={() => onChange({ ...refs, [key]: null })}
          />
        );
      })}
    </div>
  );
}
