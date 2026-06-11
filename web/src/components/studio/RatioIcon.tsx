/** 按比例字符串（如 "16:9"）画一个等比小矩形图标。PromptInput 尺寸面板与 VideoControls 弹窗共用。
 * 非数字比例（seedance 的 "adaptive"）画虚线方框表示「随输入自适应」。 */
export function RatioIcon({ ratio, box = 20 }: { ratio: string; box?: number }) {
  const [a, b] = ratio.split(':').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    const side = box - 4;
    return (
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="none">
        <rect x={2} y={2} width={side} height={side} rx="2" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
      </svg>
    );
  }
  let w: number, h: number;
  if (a >= b) {
    w = box;
    h = Math.max(Math.round((b / a) * box), 4);
  } else {
    h = box;
    w = Math.max(Math.round((a / b) * box), 4);
  }
  const x = (box - w) / 2;
  const y = (box - h) / 2;
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="none">
      <rect x={x} y={y} width={w} height={h} rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
