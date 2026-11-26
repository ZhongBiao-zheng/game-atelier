import { canvasMediaUrl, getCanvasDocument, pasteIntoCanvas, reproduceIntoCanvas, saveCanvasDocument } from '@/api/canvas';
import { getRemoteDocument, remoteMediaUrl, remoteProjectPath } from '@/api/collab';

import { requestJson } from '@/api/http';
import type { CanvasImageEditSavePayload } from '@/api/canvas';
import type { CanvasPoint } from '@/schema/canvas';

interface CollabCommandResult {
  node_id: string;
  op_id: string;
  revision: number;
  touched_node_ids: string[];
}

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
    wsPath: (id:string) => remoteProjectPath(peerKey,id)+'/ws',
    upload: (id:string,file:File,position:CanvasPoint) => {
      const form = new FormData();
      form.append('file',file);
      form.append('x',String(position.x));
      form.append('y',String(position.y));
      return requestJson<CollabCommandResult>(remoteProjectPath(peerKey,id)+'/uploads','上传素材',{method:'POST',body:form});
    },
    saveImageEdit: (id:string,payload:CanvasImageEditSavePayload,mask:Blob|null) => {
      const form = new FormData();
      form.append('payload',JSON.stringify(payload));
      if (mask) form.append('mask_file',mask,'mask.png');
      return requestJson<CollabCommandResult>(remoteProjectPath(peerKey,id)+'/image-edits','保存图片编辑',{method:'POST',body:form});
    },
    read: (id: string) => getRemoteDocument(peerKey, id),
    mediaUrl: (id: string, versionId: string, displayWidth?: number) =>
      remoteMediaUrl(peerKey, id, versionId, Boolean(displayWidth)),
  };
}

export type CanvasTransport = typeof localCanvasTransport | ReturnType<typeof remoteCanvasTransport>;
