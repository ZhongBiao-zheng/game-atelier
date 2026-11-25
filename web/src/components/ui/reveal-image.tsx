import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

export type RevealImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  /** 图片可见（解码完成，或挂载时已在缓存里）时回调。父级用它在新图盖住之后再卸掉旧层，换图全程不经过空白。 */
  onReady?: () => void;
};

/** 图片解码完成后再淡入（200ms），下载与解码期间保持透明，连同挂在图上的棋盘格背景一起藏着，不会先露格子再弹图。
 *  挂载时已在缓存里的图直接显示，不播；加载失败也显示出来，交给 alt 与外层兜底，不永远透明。
 *  src 变化时重新走一遍：父级要做交叉淡化，就让新旧两张图叠在一起，等新图 onReady 再移走旧图。
 *  每次换源分配一个请求代次，只有当前代次的解码结果能改就绪状态：A→B 后 A 的解码才回来，不会把已显示的 B 藏起来；
 *  A→B→A 两次 A 也分得开（只比地址分不开）。 */
export const RevealImage = forwardRef<HTMLImageElement, RevealImageProps>(function RevealImage(
  { onReady, onLoad, onError, className, src, ...props },
  forwardedRef,
) {
  const [request, setRequest] = useState({ src, id: 0 });
  if (request.src !== src) setRequest({ src, id: request.id + 1 });
  const [readyId, setReadyId] = useState<number | null>(null);
  // 已提交的当前代次；在 layout effect 里更新，提交之后才可能派发的 load / 解码回调都读得到。
  const currentId = useRef(request.id);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const latestOnReady = useRef(onReady);
  latestOnReady.current = onReady;
  const ready = request.src === src && readyId === request.id;

  const markReady = useCallback((id: number) => {
    if (currentId.current === id) setReadyId(id);
  }, []);

  // 绘制前检查缓存：已就绪的图首帧就是不透明的，新挂载的元素没有过渡起点，不会闪一下淡入。
  useLayoutEffect(() => {
    currentId.current = request.id;
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) markReady(request.id);
  }, [request.id, markReady]);

  useEffect(() => {
    if (ready) latestOnReady.current?.();
  }, [ready, request.id]);

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
        const id = request.id;
        const image = event.currentTarget;
        // decode 等的是元素当前的源，换源后旧的 decode 会被拒；对已解码的图部分浏览器也会拒绝，结果一样：可以显示了。
        // 是不是还该显示由代次判断。jsdom 没有 decode。
        const decoded = typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve();
        void decoded.then(() => markReady(id));
      }}
      onError={event => {
        onError?.(event);
        markReady(request.id);
      }}
    />
  );
});
