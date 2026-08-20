import { requestJson } from './http';
import type { CharacterEntry } from '@/schema/jobs';

export function createCharacterVariant(
  parentCharacterId: string,
  name: string,
  difference: string,
  folderId?: string,
): Promise<CharacterEntry> {
  return requestJson(
    `/api/characters/${encodeURIComponent(parentCharacterId)}/variants`,
    '新建角色皮肤',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        difference,
        ...(folderId ? { folder_id: folderId } : {}),
      }),
    },
  );
}
