import { useEffect, useState } from 'react';
import { Link } from 'wouter';

import { fetchGalleryRecent, type GalleryItem } from '@/api/gallery';
import { Studio } from './Studio';

type State =
  | { kind: 'loading' }
  | { kind: 'success'; items: GalleryItem[] }
  | { kind: 'error' };

export function Home() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancel = false;
    fetchGalleryRecent(24)
      .then((items) => !cancel && setState({ kind: 'success', items }))
      .catch(() => !cancel && setState({ kind: 'error' }));
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="px-8 pb-12" aria-label="作品集首页">
      <section className="min-h-[520px] flex items-center justify-center">
        <div className="w-full">
          <Studio compact />
        </div>
      </section>

      <h2 className="mb-5 text-lg font-semibold text-foreground">作品展示</h2>

      {state.kind === 'loading' && (
        <div className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              data-skeleton
              className="mb-6 break-inside-avoid bg-card/40 rounded-lg"
              style={{ height: 200 + (i % 3) * 80 }}
            />
          ))}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="text-sm text-muted-foreground text-center py-12">
          暂时拿不到图片，刷新试试。
        </div>
      )}

      {state.kind === 'success' && state.items.length === 0 && (
        <div className="text-center py-12">
          <p
            className="text-2xl italic text-foreground"
            style={{ fontFamily: "'Instrument Serif', serif" }}
          >
            工坊还空着。
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            在终端跑{' '}
            <code className="font-mono text-foreground/80 bg-card px-1.5 py-0.5 rounded">
              /character-workflow &lt;名字&gt;
            </code>{' '}
            开始第一个角色。
          </p>
        </div>
      )}

      {state.kind === 'success' && state.items.length > 0 && (
        <div className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {state.items.map((item) => (
            <Link
              key={`${item.path}-${item.filename}`}
              href={`/character/${item.character_id}`}
              className="mb-6 block break-inside-avoid"
            >
              <img
                src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
                alt=""
                className="w-full rounded-lg border border-border/40 hover:border-primary/40 transition-all duration-150 hover:scale-[1.02]"
                loading="lazy"
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
