import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { CloseIcon } from '@/components/ui/icons';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MOTION_DURATION, MOTION_EASE } from '@/lib/motion';
import { loadUiPrefs, saveUiPref } from '@/lib/uiPrefs';
import { cn } from '@/lib/utils';
import type { CreationAssetPanelProps } from './creationAssetPanelModel';
import { FolderPicker } from './FolderPicker';
import { saveToLibrary } from './saveToLibrary';
import { notify } from '@/lib/notify';
import { LibraryPanel } from './LibraryPanel';
import { OPEN_FOLDER } from '@/api/library';
import { HistoryPanel } from './HistoryPanel';

type Tab = 'history' | 'library';

export function AssetPanel(props: CreationAssetPanelProps) {
  const directed = Boolean(props.saveRequest || props.openLibrary);
  const [tab, setTab] = useState<Tab>(directed ? 'library' : 'history');
  const interacted = useRef(directed);
  const [target, setTarget] = useState<string | null>(null);
  const touchedTarget = useRef(false);
  function navigate(id: string | null) {
    touchedTarget.current = true;
    setTarget(id);
    void saveUiPref('asset-library-position', id);
  }
  useEffect(() => {
    let active = true;
    void loadUiPrefs().then(prefs => {
      const saved = prefs?.['asset-library-position'];
      if (active && !touchedTarget.current && typeof saved === 'string') setTarget(saved);
    });
    const open = (event: Event) => {
      interacted.current = true; navigate((event as CustomEvent<string>).detail);
      setTab('library'); void saveUiPref('asset-panel', 'library');
    };
    window.addEventListener(OPEN_FOLDER, open);
    return () => { active = false; window.removeEventListener(OPEN_FOLDER, open); };
  }, []);

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
  function choose(value: string) {
    if (value !== 'history' && value !== 'library') return;
    interacted.current = true;
    setTab(value); void saveUiPref('asset-panel', value);
  }
  return <aside aria-label="创作资产" className={cn('fixed bottom-56 right-4 top-24 z-40 flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-panel', props.className)}>
    <Tabs value={tab} onValueChange={choose} className="shrink-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <TabsList aria-label="资产"><TabsTrigger value="history">历史</TabsTrigger><TabsTrigger value="library">素材库</TabsTrigger></TabsList>
        <Button variant="ghost" size="icon" aria-label="关闭创作资产" onClick={props.onClose}><CloseIcon /></Button>
      </div>
    </Tabs>
    <div className="relative min-h-0 flex-1">
      <AnimatePresence initial={false}>
        <motion.div key={tab} className="absolute inset-0 flex min-h-0 flex-col bg-panel"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, pointerEvents: 'none' }}
          transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.subtle }}>
          {tab === 'history' ? <HistoryPanel onCanvas={props.projectId ? items => props.onHistoryReference(items, true) : undefined} onReference={props.onHistoryReference} /> : <LibraryPanel onSubject={props.onSubject} onCanvas={props.projectId ? items => props.onHistoryReference(items, true) : undefined} target={target} onTarget={navigate} onReference={props.onHistoryReference} />}
        </motion.div>
      </AnimatePresence>
    </div>
    {props.saveRequest && <FolderPicker open onClose={() => props.onSaveRequestHandled?.(props.saveRequest!.requestId)}
      onChoose={async folder => {
        await saveToLibrary(folder.id, props.saveRequest!);
        notify.info('已加入 ' + folder.name, { action: { label: '打开', onClick: () => navigate(folder.id) } });
      }} />}
  </aside>;
}
