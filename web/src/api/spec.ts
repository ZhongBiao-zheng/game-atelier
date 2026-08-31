import { requestJson } from '@/api/http';

export interface CharacterSpec { content: string; revision: string }
export function fetchSpec(characterId: string) {
  return requestJson<CharacterSpec>(`/api/spec/${encodeURIComponent(characterId)}`, '读取角色 spec');
}
export function saveSpec(characterId: string, content: string, revision: string) {
  return requestJson<{ ok: boolean; revision: string }>(`/api/spec/${encodeURIComponent(characterId)}`, '保存角色 spec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, expected_revision: revision }),
  });
}
