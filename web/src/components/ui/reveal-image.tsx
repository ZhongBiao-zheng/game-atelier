import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type RevealImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  /** 图片可见（解码完成，或挂载时已在缓存里）时回调。父级用它在新图盖住之后再卸掉旧层，换图全程不经过空白。 */
  onReady?: () => void;
};

/** 图片解码完成后再淡入（200ms），下载与解码期间保持透明，连同挂在图上的棋盘格背景一起藏着，不会先露格子再弹图。
 *  挂载时已在缓存里的图直接显示，不播；加载失败也显示出来，交给 alt 与外层兜底，不永远透明。
 *  src 变化时重新走一遍：父级要做交叉淡化，就让新旧两张图叠在一起，等新图 onReady 再移走旧图。 */
export const RevealImage = forwardRef<HTMLImageElement, RevealImageProps>(function RevealImage(
  { onReady, onLoad, onError, className, src, ...props },
  forwardedRef,
) {
  const [readySrc, setReadySrc] = useState<string | undefined>(undefined);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const latestOnReady = useRef(onReady);
  latestOnReady.current = onReady;
  const ready = readySrc === src;

  // 绘制前检查缓存：已就绪的图首帧就是不透明的，新挂载的元素没有过渡起点，不会闪一下淡入。
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setReadySrc(src);
  }, [src]);

  useEffect(() => {
    if (ready) latestOnReady.current?.();
  }, [ready, src]);

  const setRefs = useCallback((node: HTMLImageElement | null) => {
    imageRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  return (
    <img
      ref={setRefs}
      src={src}
      {...props}
      className={cn('transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0', className)}
      onLoad={event => {
        onLoad?.(event);
        const image = event.currentTarget;
        const loadedSrc = src;
        // decode 对已解码的图在部分浏览器会拒绝，结果一样：可以显示了。jsdom 没有 decode。
        const decoded = typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve();
        void decoded.then(() => setReadySrc(loadedSrc));
      }}
      onError={event => {
        onError?.(event);
        setReadySrc(src);
      }}
    />
  );
});
