import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Trash2 } from 'lucide-react';

import { createSitePairing, fetchConnectionSessions, revokeConnectionSession, type ConnectionSession, type SitePairing } from '@/api/sitePairing';
import { SwapLabel } from '@/components/ui/swap-label';

/** 为托管网站签发一次性配对码，并列出已配对的网站。网站的配对表单会带 ?site= 跳过来预填地址。 */
export function SitePairingSection() {
  const [origin, setOrigin] = useState(() => new URLSearchParams(window.location.search).get('site') ?? '');
  const [pairing, setPairing] = useState<SitePairing | null>(null);
  const [sessions, setSessions] = useState<ConnectionSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => fetchConnectionSessions()
    .then(result => setSessions((result.sessions ?? []).filter(session => session.kind === 'site')))
    .catch(() => setSessions([]));
  useEffect(() => { void load(); }, []);

  async function generate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setCopied(false);
    try { setPairing(await createSitePairing(origin.trim())); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.pairing_code); setCopied(true); }
    catch { setError('无法访问剪贴板，请手动复制配对码。'); }
  }
  async function revoke(session: ConnectionSession) {
    setBusy(true); setError(null);
    try { await revokeConnectionSession(session.session_id); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <h2 className="text-base font-medium text-foreground">网站连接</h2>
      <div className="min-w-0 space-y-3">
        <form onSubmit={event => void generate(event)} className="flex flex-wrap items-center gap-2">
          <input required aria-label="网站地址" value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://xxx.vercel.app" autoComplete="off" spellCheck={false}
            className="min-w-64 flex-1 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          <button disabled={busy || !origin.trim()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"><SwapLabel active={busy} on="生成中…" off="生成配对码" /></button>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {pairing && <div className="flex flex-wrap items-center gap-2">
          <code aria-label="配对码" className="rounded-md bg-secondary px-3 py-2 font-mono text-sm tracking-wider">{pairing.pairing_code}</code>
          <button type="button" onClick={() => void copy()} aria-label="复制配对码" className="rounded-md p-2 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"><Copy className="size-4" aria-hidden /></button>
          <span className="text-sm text-muted-foreground">{new Date(pairing.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 前有效，只能用一次{copied && ' · 已复制'}</span>
        </div>}
        {sessions.length > 0 && <ul aria-label="已连接的网站" className="divide-y divide-border text-sm">
          {sessions.map(session => <li key={session.session_id} className="flex items-center justify-between gap-4 py-2">
            <span className="min-w-0 truncate font-mono">{session.origin ?? session.name}</span>
            <button type="button" disabled={busy} onClick={() => void revoke(session)} aria-label={`断开 ${session.origin ?? session.name}`} className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-secondary/60 hover:text-destructive"><Trash2 className="size-4" aria-hidden /></button>
          </li>)}
        </ul>}
      </div>
    </>
  );
}
