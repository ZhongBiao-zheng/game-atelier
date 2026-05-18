import { useEffect, useState } from 'react';
import type { CharacterEntry } from '../schema/jobs';
import { useActiveCharacter } from '../hooks/useActiveCharacter';

interface Props { sseSignal: number; onSelect: (id: string) => void }

export function LeftSidebar({ sseSignal, onSelect }: Props) {
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const activeId = useActiveCharacter(sseSignal);

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then(setCharacters);
  }, [sseSignal]);

  if (characters.length === 0) {
    return (
      <aside style={{ padding: 16, textAlign: 'center' }}>
        <p style={{ color: 'var(--color-text-muted)', marginBottom: 16 }}>
          还没有角色档案
        </p>
        <button>+ 新建第一个角色</button>
      </aside>
    );
  }

  return (
    <aside style={{ borderRight: '1px solid var(--color-border)', padding: 16 }}>
      <h2 style={{ fontSize: 'var(--fs-section)', fontWeight: 'var(--fw-semibold)', marginBottom: 12 }}>
        角色列表
      </h2>
      <ul style={{ listStyle: 'none' }}>
        {characters.map(c => (
          <li key={c.id}
              onClick={() => onSelect(c.id)}
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                cursor: 'pointer',
                background: c.id === activeId ? 'var(--color-accent)' : 'transparent',
                color: c.id === activeId ? 'white' : 'var(--color-text)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
            <StatusBadge status={c.status} />
            <span>{c.name}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function StatusBadge({ status }: { status: CharacterEntry['status'] }) {
  if (status === 'idle') return null;
  const colorVar = `var(--color-status-${status})`;
  const pulse = status === 'running' ? { animation: 'pulse 1.5s ease-in-out infinite' } : {};
  return (
    <>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: colorVar, display: 'inline-block', ...pulse,
      }} />
      <style>{`@keyframes pulse {0%,100%{opacity:1}50%{opacity:.4}}`}</style>
    </>
  );
}
