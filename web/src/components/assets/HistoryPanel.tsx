import { useEffect, useState } from 'react';
import { historyKey, listHistory, type HistoryItem } from '@/api/history';
import { AssetMasonry, mediaRatio } from './AssetMasonry';

export function HistoryPanel() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listHistory('all', '', undefined, controller.signal).then(page => {
      if (!controller.signal.aborted) setItems(page.items);
    }, err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, []);
  return <div className="min-h-0 flex-1 overflow-auto p-3">
    {error && <p role="alert">{error}</p>}
    {!items.length && !error && <p className="py-8 text-center text-sm text-muted-foreground">还没有生成记录</p>}
    <AssetMasonry items={items} itemKey={historyKey} ratio={mediaRatio}>{item =>
      item.kind === 'image' ? <img src={item.thumbnail_url} loading="lazy" alt={item.prompt} /> : <p>{item.text_preview ?? item.prompt}</p>
    }</AssetMasonry>
  </div>;
}
