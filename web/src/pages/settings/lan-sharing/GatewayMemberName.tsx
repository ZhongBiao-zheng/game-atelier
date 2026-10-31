import { EditableText } from '@/components/ui/editable-text';

export function GatewayMemberName({ name, disabled, onSave }: {
  name: string;
  disabled: boolean;
  onSave: (name: string) => Promise<boolean>;
}) {
  return <EditableText value={name} maxLength={40} size="sm" disabled={disabled}
    triggerLabel={`重命名 ${name}`} inputLabel={`修改 ${name} 的名称`} onSave={onSave} />;
}
