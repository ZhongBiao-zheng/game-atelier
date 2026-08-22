import { requestJson } from './http';
import type { CharacterEntry } from '@/schema/jobs';

export function createCharacterDerivative(
  sourceCharacterId: string,
  name: string,
  sourcePaths: string[],
): Promise<CharacterEntry> {
  return requestJson(
    `/api/characters/${encodeURIComponent(sourceCharacterId)}/derivatives`,
    '新建角色衍生',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source_paths: sourcePaths }),
    },
  );
}
