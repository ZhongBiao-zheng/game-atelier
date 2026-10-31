import { useState } from 'react';
import { Toggle } from '@/components/ui/toggle';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { revealGatewayKey } from '@/api/gateway';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

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
  return <>
    <Hint label={token ? '隐藏密钥' : '查看密钥'}><Toggle size="sm" className="size-7 min-w-7 px-0" disabled={busy}
      aria-label={`${token ? '隐藏' : '查看'} ${name} 的密钥`} pressed={Boolean(token)}
      onPressedChange={pressed => { if (pressed) void read(false); else setToken(null); }}>
      {token ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
    </Toggle></Hint>
    <Hint label={copied ? '已复制' : '复制密钥'}><Button variant="ghost" size="icon" className="size-7" type="button" disabled={busy}
      aria-label={`复制 ${name} 的密钥`} onClick={() => { setCopied(false); void read(true); }}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </Button></Hint>
    <code className="basis-full break-all text-xs select-all">{token ?? '••••••••'}</code>
  </>;
}
