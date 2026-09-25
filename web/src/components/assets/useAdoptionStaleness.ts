import { useRef, useState, type Dispatch, type SetStateAction } from 'react';

import {
  TeamSourceWithdrawnError,
  fetchCreationAssetStalenessBatch,
  readoptCreationAsset,
} from '@/api/creationAssets';
import { errorMessage } from '@/components/assets/creationAssetPanelModel';
import type { CreationAsset, CreationAssetStaleness } from '@/schema/creationAssets';

/**
 * 采用副本的来源状态（徽标）与「重新采用」确认流程。
 *
 * 资产列表、忙碌态、错误行归面板所有：重新采用成功要替换列表里那一条，所以由面板把写入口传进来。
 */
export function useAdoptionStaleness({ setAssets, setBusy, setError }: {
  setAssets: Dispatch<SetStateAction<CreationAsset[]>>;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
}) {
  const [staleness, setStaleness] = useState<Record<string, CreationAssetStaleness>>({});
  const [readoptTarget, setReadoptTarget] = useState<CreationAsset | null>(null);
  const [stalenessError, setStalenessError] = useState(false);
  const stalenessRequest = useRef(0);
  const readoptInFlight = useRef(false);

  // 每次列表刷新批量查一次采用副本是否过时；迟到的结果不许盖掉更新的一次。
  async function checkStaleness(rows: CreationAsset[]) {
    const token = ++stalenessRequest.current;
    const adopted = rows.filter(asset => asset.adopted_from).map(asset => asset.asset_id);
    if (!adopted.length) {
      setStaleness({});
      setStalenessError(false);
      return;
    }
    try {
      const statuses = await fetchCreationAssetStalenessBatch(adopted);
      if (token !== stalenessRequest.current) return;
      setStaleness(statuses);
      setStalenessError(false);
    } catch {
      // 徽标只是提示：查不到就不显示徽标，列表照常可用，顶部留一行说明。
      if (token !== stalenessRequest.current) return;
      setStaleness({});
      setStalenessError(true);
    }
  }

  async function confirmReadopt() {
    const target = readoptTarget;
    setReadoptTarget(null);
    if (!target || readoptInFlight.current) return;
    readoptInFlight.current = true;
    const id = target.asset_id;
    setBusy(true);
    setError(null);
    try {
      const updated = await readoptCreationAsset(id);
      stalenessRequest.current += 1;
      setAssets(current => current.map(asset => asset.asset_id === id ? updated : asset));
      setStaleness(current => ({ ...current, [id]: 'fresh' }));
    } catch (caught) {
      if (caught instanceof TeamSourceWithdrawnError) {
        stalenessRequest.current += 1;
        setStaleness(current => ({ ...current, [id]: 'withdrawn' }));
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      readoptInFlight.current = false;
      setBusy(false);
    }
  }

  return {
    staleness,
    stalenessError,
    readoptTarget,
    requestReadopt: setReadoptTarget,
    cancelReadopt: () => setReadoptTarget(null),
    checkStaleness,
    confirmReadopt,
  };
}
