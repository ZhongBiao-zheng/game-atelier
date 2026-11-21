import { useSyncExternalStore } from 'react';

/** 品牌图标「黑白 / 彩色」：只存本机浏览器（与深浅色模式同一做法），按设备生效；缺省黑白。 */
export type BrandIconMode = 'mono' | 'color';
const KEY = 'atelier:brand-icons';
const CHANGE_EVENT = 'atelier:brand-icons-change';

export function loadBrandIconMode(): BrandIconMode {
  return window.localStorage.getItem(KEY) === 'color' ? 'color' : 'mono';
}

export function setBrandIconMode(mode: BrandIconMode) {
  window.localStorage.setItem(KEY, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) onStoreChange();
  };
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function useBrandIconMode(): BrandIconMode {
  return useSyncExternalStore(subscribe, loadBrandIconMode, () => 'mono');
}
