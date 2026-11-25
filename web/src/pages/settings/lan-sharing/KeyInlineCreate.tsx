import { useState } from 'react';
import { createGatewayKey, type GatewayKey } from '@/api/gateway';
import { Button } from '@/components/ui/button';
import { SwapLabel } from '@/components/ui/swap-label';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { errorText } from '@/lib/errorText';
import { Disclosure } from '@/components/ui/disclosure';
import { Label } from '@/components/ui/label';

export function KeyInlineCreate({ gatewayAlias, onCancel, onCreated }: {
  gatewayAlias?: string; onCancel: () => void; onCreated: (key: GatewayKey, token: string) => void;
}) {
  const [name, setName] = useState('');
  const [suffix, setSuffix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form autoComplete="off" aria-label="新建成员密钥" className="space-y-3 p-4" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel(); }
  }} onSubmit={event => {
    event.preventDefault(); if (!name.trim() || busy) return;
    setBusy(true); setError('');
    void createGatewayKey({ name: name.trim(), role: 'member',
      ...(suffix ? { token: suffix } : {}) }, ...(gatewayAlias ? [gatewayAlias] as const : []))
      .then(result => onCreated(result.key, result.token)).catch(cause => setError(errorText(cause))).finally(() => setBusy(false));
  }}>
    <Label className="space-y-1 sm:max-w-sm">名称<Input autoFocus required maxLength={40} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Label>
    {/* 绝大多数人用自动生成的密钥；自定义收进「更多」。 */}
    <Disclosure summary="更多">
      <Label className="mt-2 space-y-1 sm:max-w-sm">自定义密钥（可选）<InputGroup><InputGroupAddon>atg_</InputGroupAddon>
        <InputGroupInput type="text" className="font-mono" aria-label="自定义密钥（可选）" minLength={16} maxLength={64} pattern="[A-Za-z0-9_-]{16,64}" value={suffix} onChange={event => setSuffix(event.target.value)} disabled={busy} />
      </InputGroup></Label>
    </Disclosure>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
      <Button type="submit" disabled={busy || !name.trim()}><SwapLabel active={busy} on="创建中…" off="创建" /></Button></div>
  </form>;
}
