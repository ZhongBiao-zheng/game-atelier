import * as React from 'react';
import { cn } from '@/lib/utils';
import { Input, type InputProps } from './input';

export interface SecretInputProps extends Omit<InputProps, 'type'> {
  /** true 时明文显示；默认遮挡 */
  revealed?: boolean;
}

/**
 * 密钥 / 令牌输入。不用 type="password"：Chrome 会把相邻文本框当用户名并弹出保存密码，
 * 且 autoComplete="off" 对密码框无效。改用文本框 + text-security 遮挡。
 */
export const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ className, revealed = false, ...props }, ref) => (
    <Input
      ref={ref}
      type="text"
      spellCheck={false}
      className={cn(className, !revealed && '[-webkit-text-security:disc]')}
      {...props}
    />
  ),
);
SecretInput.displayName = 'SecretInput';
