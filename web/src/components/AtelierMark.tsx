import { ICON_PX, type IconSize } from './ui/icons';

const MASK = 'url(/favicon.svg) center / contain no-repeat';

/** 产品符号（无底板），颜色跟随文字色；形状来自与标签页同一份 favicon.svg，源文件见 assets/brand/。 */
export function AtelierMark({ size = 'xl' }: { size?: IconSize }) {
  const px = ICON_PX[size];
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 bg-current"
      style={{ width: px, height: px, WebkitMask: MASK, mask: MASK }}
    />
  );
}
