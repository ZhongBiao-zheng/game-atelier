import { useEffect, useState } from 'react';
import { listCreationAssets, setPromptPreviewFromJob } from '@/api/creationAssets';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CreationAsset } from '@/schema/creationAssets';

export interface PromptPreviewRequest {
  jobId: string;
  outputIndex: number;
  promptAssetId?: string | null;
}

export function SetPromptPreviewDialog({ request, onClose, onSaved }: {
  request: PromptPreviewRequest | null;
  onClose: () => void;
  onSaved: (asset: CreationAsset) => void;
}) {
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!request) return;
    let alive = true;
    setAssets([]); setAssetId(''); setError(undefined); setLoading(true);
    void listCreationAssets({ kind: 'prompt' }).then(result => {
      if (!alive) return;
      setAssets(result.assets);
      setAssetId(result.assets.some(asset => asset.asset_id === request.promptAssetId) ? request.promptAssetId! : '');
    }).catch(caught => { if (alive) setError(caught instanceof Error ? caught.message : '读取提示词资产失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [request]);
  const save = async () => {
    if (!request || !assetId || busy) return;
    setBusy(true); setError(undefined);
    try { const asset = await setPromptPreviewFromJob(assetId, request.jobId, request.outputIndex); onSaved(asset); onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '设置效果图失败'); }
    finally { setBusy(false); }
  };
  return <Dialog open={request !== null} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>设为效果图</DialogTitle></DialogHeader>
      {assets.length ? <Select value={assetId} onValueChange={setAssetId} disabled={busy}>
        <SelectTrigger aria-label="提示词资产"><SelectValue placeholder="选择提示词资产" /></SelectTrigger>
        <SelectContent>{assets.map(asset => <SelectItem key={asset.asset_id} value={asset.asset_id}>{asset.title}</SelectItem>)}</SelectContent>
      </Select> : <p className="text-sm text-muted-foreground">{loading ? '正在读取…' : '还没有提示词资产'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button disabled={!assetId || busy || loading} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
