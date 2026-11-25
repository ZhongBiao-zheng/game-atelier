import { useEffect, useState } from 'react';
import { Toggle } from '@/components/ui/toggle';
import { CheckIcon, CopyIcon, HideIcon, ShowIcon } from '@/components/ui/icons';
import { GATEWAY_TOKEN_LENGTH, revealGatewayKey } from '@/api/gateway';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { SwapIcon } from '@/components/ui/swap-icon';
import { useCopyFeedback } from '@/lib/useCopyFeedback';

export function GatewayMemberToken({ id, name, knownToken, onError }: {
  id: string; name: string; knownToken?: string; onError: (message: string) => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 复制成功的勾 1.5 秒后退回复制图标，不永远停在「已复制」。
  const [copyState, copyText] = useCopyFeedback();
  const copied = copyState === 'copied';
  useEffect(() => { if (copyState === 'failed') onError('复制失败，请手动复制'); }, [copyState, onError]);
  async function read(copy: boolean) {
    setBusy(true);
    onError('');
    try {
      const result = knownToken ? { token: knownToken } : await revealGatewayKey(id);
      if (copy) copyText(result.token);
      else setToken(result.token);
    } catch (error) { onError(String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <code className="inline-block w-[47ch] shrink-0 overflow-x-auto whitespace-nowrap font-mono text-xs select-all">{token ?? `atg_${'•'.repeat(GATEWAY_TOKEN_LENGTH - 4)}`}</code>
    <Hint label={token ? '隐藏密钥' : '查看密钥'}><Toggle size="sm" className="size-7 min-w-7 px-0" disabled={busy}
      aria-label={`${token ? '隐藏' : '查看'} ${name} 的密钥`} pressed={Boolean(token)}
      onPressedChange={pressed => { if (pressed) void read(false); else setToken(null); }}>
      <SwapIcon swapKey={Boolean(token)}>{token ? <HideIcon aria-hidden /> : <ShowIcon aria-hidden />}</SwapIcon>
    </Toggle></Hint>
    <Hint label={copied ? '已复制' : '复制密钥'}><Button variant="ghost" size="icon" className="size-7" type="button" disabled={busy}
      aria-label={`复制 ${name} 的密钥`} onClick={() => void read(true)}>
      <SwapIcon swapKey={copied} variant={copied ? 'pop' : 'subtle'}>{copied ? <CheckIcon size="sm" aria-hidden /> : <CopyIcon size="sm" aria-hidden />}</SwapIcon>
    </Button></Hint>
  </>;
}
