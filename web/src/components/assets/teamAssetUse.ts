import { connectionFetch } from '@/api/connection';
import type { TeamLibraryIndexEntry } from '@/schema/teamLibrary';

export type TeamUseEntry = Pick<TeamLibraryIndexEntry, 'id' | 'kind' | 'title' | 'mime_type' | 'prompt_text'>;
export type UseTeamMedia = (file: File, entry: TeamUseEntry, sourceKey: string) => void | Promise<void>;
export type UseTeamPrompt = (text: string, entry: TeamUseEntry) => void;

export async function readTeamMedia(url: string, entry: TeamUseEntry): Promise<File> {
  const response = await connectionFetch(url);
  if (!response.ok) throw new Error('读取失败');
  const blob = await response.blob();
  return new File([blob], entry.title, { type: entry.mime_type ?? blob.type });
}
