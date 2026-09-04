import { connectionFetch } from '@/api/connection';
import { useCallback } from 'react';

export function useClipboard() {
  return useCallback(async (text: string): Promise<{ success: boolean; reason: string | null }> => {
    let success = false;
    let reason: string | null = null;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch (e) {
      reason = (e as Error).message || 'clipboard write failed';
    }
    connectionFetch('/api/clipboard-attempt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: new Date().toISOString(), success, reason }),
    }).catch(() => {});
    return { success, reason };
  }, []);
}
