import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { fetchProfile } from '@/api/teamLibraries';
import { TEAM_ASSET_ACTION_EVENT, type TeamAssetAction } from '@/lib/teamAssetActions';
import type { TeamLibraryChangeEvent } from '@/schema/teamLibrary';
import { TeamShareReminder, type TeamShareReminderHandle } from './TeamShareReminder';

vi.mock('@/api/teamLibraries', () => ({
  fetchProfile: vi.fn(),
  teamAssetThumbUrl: (libraryId: string, entryId: string, width: number) =>
    `/thumb/${libraryId}/${entryId}?w=${width}`,
}));

const REMINDED_KEY = 'atelier:team-reminded';
const mockedFetchProfile = vi.mocked(fetchProfile);

function changeEvent(overrides: Partial<TeamLibraryChangeEvent> = {}): TeamLibraryChangeEvent {
  return {
    library_id: 'lib_a',
    asset_id: 'ta_1',
    kind: 'generation',
    author: '阿岚',
    change: 'added',
    title: '雨夜城门',
    status: 'ready',
    mime_type: 'image/png',
    ...overrides,
  };
}

async function renderReminder() {
  const location = memoryLocation({ path: '/canvas', record: true });
  const ref = createRef<TeamShareReminderHandle>();
  render(
    <Router hook={location.hook}>
      <TeamShareReminder ref={ref} />
    </Router>,
  );
  await act(async () => {});
  const notify = (event: TeamLibraryChangeEvent) => act(() => { ref.current?.notify(event); });
  return { ref, location, notify };
}

const listeners: Array<(event: Event) => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  mockedFetchProfile.mockReset();
  mockedFetchProfile.mockResolvedValue({ display_name: '我' });
  window.localStorage.removeItem(REMINDED_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem(REMINDED_KEY);
  listeners.splice(0).forEach(handler => window.removeEventListener(TEAM_ASSET_ACTION_EVENT, handler));
});

describe('TeamShareReminder', () => {
  it('shows author, title and thumbnail for a teammate share', async () => {
    const { notify } = await renderReminder();
    notify(changeEvent());

    expect(screen.getByText('阿岚')).toBeInTheDocument();
    expect(screen.getByText('雨夜城门')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复刻' })).toBeInTheDocument();
    expect(document.querySelector('img')).toHaveAttribute('src', '/thumb/lib_a/ta_1?w=96');
  });

  it('offers 看看 for non-generation assets and skips the thumbnail for non-images', async () => {
    const { notify } = await renderReminder();
    notify(changeEvent({ kind: 'prompt', mime_type: null }));

    expect(screen.getByRole('button', { name: '看看' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复刻' })).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it.each([
    ['own share', { author: '我' }],
    ['raw file', { kind: 'raw' }],
    ['incomplete entry', { status: 'incomplete' as const }],
    ['removed entry', { change: 'removed' as const, title: null, status: null, mime_type: null }],
    ['anonymous entry', { author: null }],
    ['blank author', { author: '  ' }],
  ])('stays silent for %s', async (_label, overrides) => {
    const { notify } = await renderReminder();
    notify(changeEvent(overrides));

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(REMINDED_KEY)).toBeNull();
  });

  it('reminds on updated entries', async () => {
    const { notify } = await renderReminder();
    notify(changeEvent({ change: 'updated' }));
    expect(screen.getByText('雨夜城门')).toBeInTheDocument();
  });

  it('reminds each asset once and remembers it across mounts', async () => {
    const { notify } = await renderReminder();
    notify(changeEvent());
    notify(changeEvent({ change: 'updated' }));

    expect(screen.getAllByText('雨夜城门')).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem(REMINDED_KEY) ?? '[]')).toEqual(['ta_1']);
  });

  it('skips assets already recorded in localStorage', async () => {
    window.localStorage.setItem(REMINDED_KEY, JSON.stringify(['ta_1']));
    const { notify } = await renderReminder();
    notify(changeEvent());

    expect(screen.queryByText('雨夜城门')).not.toBeInTheDocument();
  });

  it('keeps only the latest 500 reminded ids', async () => {
    const seeded = Array.from({ length: 500 }, (_, i) => `ta_old_${i}`);
    window.localStorage.setItem(REMINDED_KEY, JSON.stringify(seeded));
    const { notify } = await renderReminder();
    notify(changeEvent({ asset_id: 'ta_new' }));

    const stored = JSON.parse(window.localStorage.getItem(REMINDED_KEY) ?? '[]') as string[];
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe('ta_old_1');
    expect(stored[499]).toBe('ta_new');
  });

  it('still reminds and dedupes in memory when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { notify } = await renderReminder();
    notify(changeEvent());
    notify(changeEvent({ change: 'updated' }));

    expect(screen.getAllByText('雨夜城门')).toHaveLength(1);
  });

  it('ignores a corrupt reminded list', async () => {
    window.localStorage.setItem(REMINDED_KEY, '{not json');
    const { notify } = await renderReminder();
    notify(changeEvent());

    expect(screen.getByText('雨夜城门')).toBeInTheDocument();
  });

  it('shows three quick shares separately', async () => {
    const { notify } = await renderReminder();
    for (const id of ['ta_1', 'ta_2', 'ta_3']) notify(changeEvent({ asset_id: id, title: id }));

    expect(screen.getAllByRole('button', { name: '复刻' })).toHaveLength(3);
  });

  it('merges more than three shares within 3 seconds into one count', async () => {
    const { notify } = await renderReminder();
    for (const id of ['ta_1', 'ta_2', 'ta_3', 'ta_4']) {
      notify(changeEvent({ asset_id: id, title: id }));
      act(() => { vi.advanceTimersByTime(500); });
    }

    expect(screen.getByText('团队库新增 4 条')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复刻' })).not.toBeInTheDocument();

    notify(changeEvent({ asset_id: 'ta_5' }));
    expect(screen.getByText('团队库新增 5 条')).toBeInTheDocument();
  });

  it('does not merge shares spread beyond 3 seconds', async () => {
    const { notify } = await renderReminder();
    for (const id of ['ta_1', 'ta_2', 'ta_3', 'ta_4']) {
      notify(changeEvent({ asset_id: id, title: id }));
      act(() => { vi.advanceTimersByTime(1100); });
    }

    expect(screen.queryByText(/团队库新增/)).not.toBeInTheDocument();
    expect(screen.getByText('ta_4')).toBeInTheDocument();
  });

  it('disappears after 8 seconds', async () => {
    const { notify } = await renderReminder();
    notify(changeEvent());
    act(() => { vi.advanceTimersByTime(7999); });
    expect(screen.getByText('雨夜城门')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('雨夜城门')).not.toBeInTheDocument();
  });

  it('closes on demand', async () => {
    const { notify } = await renderReminder();
    notify(changeEvent());
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText('雨夜城门')).not.toBeInTheDocument();
  });

  it('hands 复刻 to a page that claims the action', async () => {
    const received: TeamAssetAction[] = [];
    const handler = (event: Event) => {
      event.preventDefault();
      received.push((event as CustomEvent<TeamAssetAction>).detail);
    };
    listeners.push(handler);
    window.addEventListener(TEAM_ASSET_ACTION_EVENT, handler);
    const { notify, location } = await renderReminder();
    notify(changeEvent());

    fireEvent.click(screen.getByRole('button', { name: '复刻' }));

    expect(received).toEqual([{ library_id: 'lib_a', asset_id: 'ta_1', action: 'reproduce' }]);
    expect(location.history).toEqual(['/canvas']);
    expect(screen.queryByText('雨夜城门')).not.toBeInTheDocument();
  });

  it('navigates to Studio when no page claims the action', async () => {
    const { notify, location } = await renderReminder();
    notify(changeEvent({ kind: 'media' }));

    fireEvent.click(screen.getByRole('button', { name: '看看' }));

    expect(location.history.at(-1)).toBe('/studio?team_asset=lib_a:ta_1&team_action=open');
  });

  it('refetches the display name when asked', async () => {
    const { ref, notify } = await renderReminder();
    expect(mockedFetchProfile).toHaveBeenCalledTimes(1);

    mockedFetchProfile.mockResolvedValue({ display_name: '新名' });
    await act(async () => { ref.current?.refreshProfile(); });
    expect(mockedFetchProfile).toHaveBeenCalledTimes(2);

    notify(changeEvent({ asset_id: 'ta_self', author: '新名', title: '自己' }));
    notify(changeEvent({ asset_id: 'ta_old_name', author: '我', title: '旧名' }));
    expect(screen.queryByText('自己')).not.toBeInTheDocument();
    expect(screen.getByText('旧名')).toBeInTheDocument();
  });

  it('keeps reminding when the profile cannot be read', async () => {
    mockedFetchProfile.mockRejectedValue(new Error('offline'));
    const { notify } = await renderReminder();
    notify(changeEvent());
    expect(screen.getByText('雨夜城门')).toBeInTheDocument();
  });
});
