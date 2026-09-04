import { Scissors } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatCanvasBytes } from '@/components/canvas/canvasMediaFormatting';

export function CanvasMattingModelDialog({
  open,
  bytes,
  downloading,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  bytes: number;
  downloading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors aria-hidden="true" />
            下载抠图模型
          </DialogTitle>
          <DialogDescription>
            首次抠图需要下载 BiRefNet 模型（{formatCanvasBytes(bytes)}），之后在本机运行，不上传图片。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={downloading}>取消</Button>
          <Button onClick={onConfirm} disabled={downloading}>
            {downloading ? '下载中…' : '下载并抠图'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
