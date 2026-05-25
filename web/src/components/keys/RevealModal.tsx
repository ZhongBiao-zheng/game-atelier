import { useState } from 'react';

interface Props {
  secret: string;
  onClose: () => void;
}

export function RevealModal({ secret, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // clipboard API unavailable — silent fallback
    }
  };

  const requestClose = () => {
    if (confirmClose) onClose();
    else setConfirmClose(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reveal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="bg-card border border-border rounded-lg p-8 max-w-md w-full space-y-4">
        <h2
          id="reveal-title"
          className="text-2xl"
          style={{ fontFamily: "'Instrument Serif', serif" }}
        >
          新 Key 已创建
        </h2>
        <p className="text-sm text-muted-foreground">
          这是你最后一次看到完整 secret。
          <br />
          关闭这个窗口后将永远只显示后 4 位。
        </p>
        <div className="bg-muted rounded-md p-3 flex items-center justify-between gap-3">
          <code className="font-mono text-sm text-foreground break-all">{secret}</code>
          <button
            type="button"
            onClick={copy}
            className="text-sm bg-primary text-primary-foreground rounded-md px-3 py-1.5 min-w-[44px] hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            复制
          </button>
        </div>
        {copied && <p className="text-xs text-primary">复制成功 ✓</p>}
        {confirmClose && (
          <p className="text-xs text-destructive">确定关闭？secret 不会再出现。</p>
        )}
        <button
          type="button"
          onClick={requestClose}
          className="w-full bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {confirmClose ? '确定关闭' : '我已保存，关闭'}
        </button>
      </div>
    </div>
  );
}
