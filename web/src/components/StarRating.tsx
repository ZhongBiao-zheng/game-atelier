import { useState } from 'react';
import { Star, StarHalf } from 'lucide-react';

interface Props {
  value: number;                 // 0–5，0.5 步进
  onChange: (value: number) => void;
}

/** 5 星半分制：每星左半=x.5、右半=x.0；点当前值清零；hover 预览。 */
export function StarRating({ value, onChange }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value;

  return (
    <div className="flex items-center gap-3">
      <div
        className="flex items-center gap-1.5"
        role="radiogroup"
        aria-label="你的评分"
        onMouseLeave={() => setHover(null)}
      >
        {[1, 2, 3, 4, 5].map((pos) => {
          const full = shown >= pos;
          const half = !full && shown >= pos - 0.5;
          return (
            <span key={pos} className="relative inline-flex size-7">
              <Star
                className="absolute inset-0 size-7 text-muted-foreground/25"
                strokeWidth={1.5}
                aria-hidden
              />
              {full && (
                <Star
                  className="absolute inset-0 size-7 text-primary fill-current"
                  strokeWidth={1.5}
                  aria-hidden
                />
              )}
              {half && (
                <StarHalf
                  className="absolute inset-0 size-7 text-primary fill-current"
                  strokeWidth={1.5}
                  aria-hidden
                />
              )}
              <button
                type="button"
                aria-label={`${pos - 0.5} 星`}
                className="absolute left-0 top-0 z-10 h-full w-1/2 cursor-pointer bg-transparent p-0 focus-visible:outline-none"
                onMouseEnter={() => setHover(pos - 0.5)}
                onClick={() => onChange(value === pos - 0.5 ? 0 : pos - 0.5)}
              />
              <button
                type="button"
                aria-label={`${pos} 星`}
                className="absolute right-0 top-0 z-10 h-full w-1/2 cursor-pointer bg-transparent p-0 focus-visible:outline-none"
                onMouseEnter={() => setHover(pos)}
                onClick={() => onChange(value === pos ? 0 : pos)}
              />
            </span>
          );
        })}
      </div>
      {shown > 0 ? (
        <span className="text-sm tabular-nums text-foreground">{shown.toFixed(1)}</span>
      ) : (
        <span className="text-xs text-muted-foreground/60">点击评分</span>
      )}
    </div>
  );
}
