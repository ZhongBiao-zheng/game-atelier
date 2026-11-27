import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { CloseIcon } from '@/components/ui/icons';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MOTION_DURATION } from '@/lib/motion';
import { loadUiPrefs, saveUiPref } from '@/lib/uiPrefs';
import { cn } from '@/lib/utils';
import { CreationAssetPanel, type CreationAssetPanelHandle, type CreationAssetPanelProps } from './CreationAssetPanel';
import { HistoryPanel } from './HistoryPanel';

type Tab = 'history' | 'library';

export const AssetPanel = forwardRef<CreationAssetPanelHandle, CreationAssetPanelProps>(function AssetPanel(props, ref) {
  const directed = Boolean(props.saveRequest || props.initialKind === 'team');
  const [tab, setTab] = useState<Tab>(directed ? 'library' : 'history');
  const interacted = useRef(directed);
  const library = useRef<CreationAssetPanelHandle>(null);
  useEffect(() => {
    let active = true;
    void loadUiPrefs().then(prefs => {
      if (active && !interacted.current && prefs?.['asset-panel'] === 'library') setTab('library');
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (directed) { interacted.current = true; setTab('library'); }
  }, [directed]);
  function close() {
    if (tab === 'library' && library.current) library.current.requestClose();
    else props.onClose();
  }
  function transition(action: () => void) {
    if (tab === 'library' && library.current) library.current.requestTransition(action);
    else action();
  }
  useImperativeHandle(ref, () => ({ requestClose: close, requestTransition: transition }));
  function choose(value: string) {
    if (value !== 'history' && value !== 'library') return;
    interacted.current = true;
    transition(() => { setTab(value); void saveUiPref('asset-panel', value); });
  }
  return <aside aria-label="创作资产" className={cn('fixed bottom-56 right-4 top-24 z-40 flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-panel', props.className)}>
    <Tabs value={tab} onValueChange={choose} className="shrink-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <TabsList aria-label="资产"><TabsTrigger value="history">历史</TabsTrigger><TabsTrigger value="library">素材库</TabsTrigger></TabsList>
        <Button variant="ghost" size="icon" aria-label="关闭创作资产" onClick={close}><CloseIcon /></Button>
      </div>
    </Tabs>
    <div className="relative min-h-0 flex-1">
      <AnimatePresence initial={false}>
        <motion.div key={tab} className="absolute inset-0 flex min-h-0 flex-col bg-panel"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, pointerEvents: 'none' }}
          transition={{ duration: MOTION_DURATION.base }}>
          {tab === 'history' ? <HistoryPanel /> : <CreationAssetPanel {...props} ref={library} embedded />}
        </motion.div>
      </AnimatePresence>
    </div>
  </aside>;
});
