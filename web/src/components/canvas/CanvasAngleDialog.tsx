import { Orbit, RotateCcw, WandSparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';


export interface CanvasAngleParams {
  horizontalAngle: number;
  pitchAngle: number;
  cameraDistance: number;
  wideAngle: boolean;
  requestedCount: number;
}

const DEFAULT_ANGLE: CanvasAngleParams = {
  horizontalAngle: 0,
  pitchAngle: 9,
  cameraDistance: 4.8,
  wideAngle: false,
  requestedCount: 1,
};

export function CanvasAngleDialog({
  open,
  title,
  mediaUrl,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  mediaUrl: string;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: CanvasAngleParams) => void;
}) {
  const [params, setParams] = useState(DEFAULT_ANGLE);

  useEffect(() => {
    if (open) setParams(DEFAULT_ANGLE);
  }, [mediaUrl, open]);

  function update<Key extends keyof CanvasAngleParams>(
    key: Key,
    value: CanvasAngleParams[Key],
  ) {
    setParams(current => ({ ...current, [key]: value }));
  }

  const previewScale = Math.max(
    0.72,
    Math.min(1.08, 1.08 - params.cameraDistance * 0.035 - (params.wideAngle ? 0.08 : 0)),
  );
  const previewTransform = `perspective(520px) rotateY(${params.horizontalAngle * -0.45}deg) rotateX(${params.pitchAngle * 0.35}deg) scale(${previewScale})`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Orbit aria-hidden="true" />生成“{title}”的新角度</DialogTitle>
          <DialogDescription>预览只表达机位方向；真实结果由图片编辑模型生成，并保留原主体与画面风格。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-[minmax(16rem,1fr)_22rem]">
          <div className="flex min-h-72 flex-col justify-between overflow-hidden rounded-lg border border-border bg-background/70 p-4">
            <div className="grid flex-1 place-items-center overflow-hidden">
              <img
                src={mediaUrl}
                alt={title}
                draggable={false}
                className="max-h-64 max-w-full rounded-lg object-contain transition-transform duration-200"
                style={{ transform: previewTransform }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{angleSummary(params)}</p>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setParams(DEFAULT_ANGLE)}><RotateCcw />重置</Button>
            </div>
          </div>

          <div className="space-y-5 rounded-lg border border-border bg-secondary/20 p-4">
            <AngleSlider label="水平角" value={params.horizontalAngle} min={-60} max={60} step={1} suffix="°" disabled={busy} onChange={value => update('horizontalAngle', value)} />
            <AngleSlider label="俯仰" value={params.pitchAngle} min={-45} max={45} step={1} suffix="°" disabled={busy} onChange={value => update('pitchAngle', value)} />
            <AngleSlider label="距离" value={params.cameraDistance} min={1} max={10} step={0.1} disabled={busy} onChange={value => update('cameraDistance', value)} />
            <fieldset disabled={busy}>
              <legend className="mb-2 text-xs text-muted-foreground">镜头</legend>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" size="sm" variant={!params.wideAngle ? 'secondary' : 'ghost'} onClick={() => update('wideAngle', false)}>标准</Button>
                <Button type="button" size="sm" variant={params.wideAngle ? 'secondary' : 'ghost'} onClick={() => update('wideAngle', true)}>广角</Button>
              </div>
            </fieldset>
            <label className="block text-xs text-muted-foreground">候选数
              <select aria-label="多角度候选数" disabled={busy} value={params.requestedCount} onChange={event => update('requestedCount', Number(event.target.value))} className="canvas-input mt-1">
                {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value} 张</option>)}
              </select>
            </label>
            {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">{error}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={busy} onClick={() => onSubmit(params)}>
            <WandSparkles />{busy ? '提交中…' : '生成新角度'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AngleSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[4rem_1fr_4rem] items-center gap-3 text-xs text-muted-foreground">
      {label}
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))} className="accent-primary" />
      <span className="text-right text-foreground">{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</span>
    </label>
  );
}

function angleSummary(params: CanvasAngleParams) {
  const horizontal = params.horizontalAngle === 0
    ? '正面'
    : params.horizontalAngle > 0
      ? `右转 ${params.horizontalAngle}°`
      : `左转 ${Math.abs(params.horizontalAngle)}°`;
  const pitch = params.pitchAngle === 0
    ? '平视'
    : params.pitchAngle > 0
      ? `俯视 ${params.pitchAngle}°`
      : `仰视 ${Math.abs(params.pitchAngle)}°`;
  return `${horizontal} · ${pitch} · 距离 ${params.cameraDistance.toFixed(1)} · ${params.wideAngle ? '广角' : '标准'}`;
}
