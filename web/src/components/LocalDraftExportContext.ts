import { createContext } from 'react';

export interface LocalDraftSnapshot { filename: string; document: unknown }
export type LocalDraftFactory = () => LocalDraftSnapshot | null;
export const LocalDraftExportContext = createContext<((factory: LocalDraftFactory) => () => void) | null>(null);

/** Recovery JSON deliberately excludes media bytes and is not a Canvas project package. */
export function downloadLocalDraft(snapshot: LocalDraftSnapshot) {
  const blob = new Blob([JSON.stringify({ format: 'atelier-canvas-draft/1', exported_at: new Date().toISOString(), document: snapshot.document }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = snapshot.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
