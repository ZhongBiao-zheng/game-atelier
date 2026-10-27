import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { revealGatewayKey } from '@/api/gateway';

export function GatewayMemberToken({ id, name, onError }: {
  id: string; name: string; onError: (message: string) => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function read(copy: boolean) {
    setBusy(true);
    onError('');
    try {
      const result = await revealGatewayKey(id);
      if (copy) { await navigator.clipboard.writeText(result.token); setCopied(true); }
      else setToken(result.token);
    } catch (error) { onError(String(error)); }
    finally { setBusy(false); }
  }
  const button = 'inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50';
  return <>
    <button type="button" className={button} disabled={busy} title={token ? '隐藏密钥' : '查看密钥'}
      aria-label={`${token ? '隐藏' : '查看'} ${name} 的密钥`} aria-pressed={Boolean(token)}
      onClick={() => { if (token) setToken(null); else void read(false); }}>
      {token ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
    </button>
    <button type="button" className={button} disabled={busy} title={copied ? '已复制' : '复制密钥'}
      aria-label={`复制 ${name} 的密钥`} onClick={() => { setCopied(false); void read(true); }}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
    <code className="basis-full break-all text-xs select-all">{token ?? '••••••••'}</code>
  </>;
}
