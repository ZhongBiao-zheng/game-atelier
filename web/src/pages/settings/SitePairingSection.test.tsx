import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SitePairingSection } from './SitePairingSection';

const pairing = { pairing_code: 'PAIR-CODE-123456789012', origin: 'https://atelier.example', expires_at: '2099-01-01T00:05:00Z', instance_id: 'i1' };
const siteSession = { session_id: 'site-1', kind: 'site', name: 'https://atelier.example', origin: 'https://atelier.example', expires_at: '2099-01-01T12:00:00Z' };
function server() {
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/connection/pairings') return new Response(JSON.stringify(pairing), { status: 201 });
    if (url === '/api/connection/sessions/site-1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ sessions: [siteSession, { ...siteSession, session_id: 'local-1', kind: 'local', origin: null, name: '本地页面' }] }));
  });
  vi.stubGlobal('fetch', network); return network;
}
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

describe('site pairing setting', () => {
  it('prefills the site origin from the link, generates a one-time code and lists only site sessions', async () => {
    window.history.replaceState({}, '', '/settings?section=site&site=https%3A%2F%2Fatelier.example');
    const network = server(); const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<SitePairingSection />);
    expect(screen.getByLabelText('网站地址')).toHaveValue('https://atelier.example');
    const list = await screen.findByRole('list', { name: '已连接的网站' });
    expect(list).toHaveTextContent('https://atelier.example'); expect(list).not.toHaveTextContent('本地页面');
    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }));
    expect(await screen.findByLabelText('配对码')).toHaveTextContent(pairing.pairing_code);
    const call = network.mock.calls.find(([url, init]) => url === '/api/connection/pairings' && init?.method === 'POST')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ origin: 'https://atelier.example' });
    fireEvent.click(screen.getByRole('button', { name: '复制配对码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(pairing.pairing_code));
    fireEvent.click(screen.getByRole('button', { name: '断开 https://atelier.example' }));
    await waitFor(() => expect(network.mock.calls.some(([url, init]) => url === '/api/connection/sessions/site-1' && init?.method === 'DELETE')).toBe(true));
  });
});
