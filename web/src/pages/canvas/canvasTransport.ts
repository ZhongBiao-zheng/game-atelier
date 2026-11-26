import { canvasMediaUrl, getCanvasDocument, pasteIntoCanvas, reproduceIntoCanvas, saveCanvasDocument } from '@/api/canvas';
import { getRemoteDocument, remoteMediaUrl } from '@/api/collab';

export const localCanvasTransport = {
  kind: 'local' as const,
  read: (id: string) => getCanvasDocument(id),
  mediaUrl: (...args: Parameters<typeof canvasMediaUrl>) => canvasMediaUrl(...args),
  save: (...args: Parameters<typeof saveCanvasDocument>) => saveCanvasDocument(...args),
  paste: (...args: Parameters<typeof pasteIntoCanvas>) => pasteIntoCanvas(...args),
  reproduce: (...args: Parameters<typeof reproduceIntoCanvas>) => reproduceIntoCanvas(...args),
};

export function remoteCanvasTransport(peerKey: string) {
  return {
    kind: 'remote' as const,
    peerKey,
    read: (id: string) => getRemoteDocument(peerKey, id),
    mediaUrl: (id: string, versionId: string, displayWidth?: number) =>
      remoteMediaUrl(peerKey, id, versionId, Boolean(displayWidth)),
  };
}

export type CanvasTransport = typeof localCanvasTransport | ReturnType<typeof remoteCanvasTransport>;
