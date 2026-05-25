import { MainApp } from '@/MainApp';

export function CharacterDetail({ characterId }: { characterId?: string } = {}) {
  return <MainApp _routedCharacterId={characterId} />;
}
