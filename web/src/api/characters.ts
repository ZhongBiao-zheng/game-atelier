import { requestJson } from './http';
import type {
  AssetSlot,
  CanonicalEntry,
  CharacterAssociationItem,
  CharacterAssociationTarget,
  CharacterEntry,
} from '@/schema/jobs';
import type { ProjectGalleryMedia } from '@/api/gallery';

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

export type { CharacterAssociationItem, CharacterAssociationTarget } from '@/schema/jobs';

export interface CharacterIndexItem {
  character: CharacterEntry;
  cover_path: string | null;
  activity_at: string;
}

export interface CharacterAssetGroup {
  slot: AssetSlot;
  count: number;
  canonical: CanonicalEntry | null;
  media: ProjectGalleryMedia[];
}

export interface CharacterRelatedObject {
  target: CharacterAssociationTarget;
  title: string;
  detail: string;
  source: 'auto' | 'manual' | 'both';
  featured_path: string | null;
  count: number;
  media: ProjectGalleryMedia[];
}

export interface CharacterWorkspaceData {
  character: CharacterEntry;
  assets: CharacterAssetGroup[];
  related: CharacterRelatedObject[];
  recent_media: ProjectGalleryMedia[];
}

export async function fetchCharacterIndex(projectId: string): Promise<CharacterIndexItem[]> {
  const data = await requestJson<{ items?: CharacterIndexItem[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/characters/index`,
    '读取角色索引',
  );
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchCharacterWorkspace(
  projectId: string,
  characterId: string,
): Promise<CharacterWorkspaceData> {
  return requestJson<CharacterWorkspaceData>(
    `/api/projects/${encodeURIComponent(projectId)}/characters/${encodeURIComponent(characterId)}/workspace`,
    '读取角色工作台',
  );
}

export async function fetchManualCharacterAssociations(
  projectId: string,
): Promise<CharacterAssociationItem[]> {
  const data = await requestJson<{ items?: CharacterAssociationItem[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/character-associations`,
    '读取角色关联',
  );
  return Array.isArray(data.items) ? data.items : [];
}

export async function setCharacterAssociation(
  projectId: string,
  characterId: string,
  target: CharacterAssociationTarget,
  associated: boolean,
): Promise<CharacterAssociationItem[]> {
  const data = await requestJson<{ items: CharacterAssociationItem[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/character-associations`,
    '保存角色关联',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character_id: characterId, target, associated }),
    },
  );
  return data.items;
}
