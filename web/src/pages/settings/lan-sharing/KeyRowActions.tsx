import { MoreIcon } from '@/components/ui/icons';
import type { GatewayKey, GatewayKeyInput, GatewayOptions } from '@/api/gateway';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { KeyQuotaPicker } from './KeyQuotaPicker';
import { KeyScopePicker } from './KeyScopePicker';

export function KeyRowActions({ record, options, busy, onSave, onRename, onReset, onRevoke }: {
  record: GatewayKey; options: GatewayOptions; busy: boolean;
  onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
  onRename: () => void; onReset: () => void; onRevoke: () => void;
}) {
  return <div className="flex items-center justify-end gap-1 whitespace-nowrap">
    <KeyScopePicker record={record} options={options} busy={busy} onSave={onSave} />
    <KeyQuotaPicker record={record} busy={busy} onSave={onSave} />
    <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label={`${record.name} 的更多操作`} disabled={busy}><MoreIcon /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={onRename}>重命名</DropdownMenuItem><DropdownMenuItem onSelect={onReset}>重置密钥</DropdownMenuItem><DropdownMenuItem destructive onSelect={onRevoke}>撤销</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </div>;
}


export function KeyRoleCell({ record, busy, onSave }: {
  record: GatewayKey; busy: boolean; onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
}) {
  if (record.revoked_at) return <>{record.role === 'admin' ? '管理员' : '成员'}</>;
  return <Select value={record.role ?? 'member'} onValueChange={role => { void onSave({ role: role as 'member' | 'admin' }); }} disabled={busy}>
    <SelectTrigger aria-label={`${record.name} 的角色`} size="sm" variant="inline"><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent>
  </Select>;
}
