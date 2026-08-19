import { FixedSlot } from './VideoReferenceAssets';

/** MJ 的三个语义参考槽。垫图（Image Prompt）不在这里 —— 它走通用参考图栏位 → base64Array。
 *
 * 这三种只吃公网图片 URL，所以提交时先上传到服务器、由后端经 OSS 转成直链再拼 flag：
 * --sref（风格）/ --cref（角色）/ --oref（Omni Reference）。
 */
export interface MjRefSlots {
  sref: File | null;
  cref: File | null;
  oref: File | null;
}

export const EMPTY_MJ_REFS: MjRefSlots = { sref: null, cref: null, oref: null };

export function MjReferenceSlots({
  refs,
  onChange,
}: {
  refs: MjRefSlots;
  onChange: (refs: MjRefSlots) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 self-center shrink-0">
      <FixedSlot
        label="上传风格参考图" caption="风格" file={refs.sref} accept="image/*"
        onPick={(f) => onChange({ ...refs, sref: f })}
        onRemove={() => onChange({ ...refs, sref: null })}
      />
      <FixedSlot
        label="上传角色参考图" caption="角色" file={refs.cref} accept="image/*"
        onPick={(f) => onChange({ ...refs, cref: f })}
        onRemove={() => onChange({ ...refs, cref: null })}
      />
      <FixedSlot
        label="上传 Omni 参考图" caption="Omni" file={refs.oref} accept="image/*"
        onPick={(f) => onChange({ ...refs, oref: f })}
        onRemove={() => onChange({ ...refs, oref: null })}
      />
    </div>
  );
}
