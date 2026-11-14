import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { connect, type PluginClient } from '../../../sdk';

const STYLE = `
  html, body, #root { height: 100%; margin: 0; }
  body { background: transparent; color: var(--foreground); font: 12px/1.5 var(--font-sans, sans-serif); }
  .sheet { display: flex; flex-direction: column; height: 100%; }
  .sheet canvas { flex: 1; min-height: 0; width: 100%; object-fit: contain; }
  .sheet footer { padding: 6px 10px; color: var(--muted-foreground); border-top: 1px solid var(--border);
    font-variant-numeric: tabular-nums; }
  .sheet .empty { flex: 1; display: grid; place-items: center; color: var(--muted-foreground); }
`;

interface SheetPayload { frames?: unknown[] }

/** 节点面：显示连入的图与已切出的帧数。切帧、对齐、重排在编辑面板里做。 */
function SheetNode({ client }: { client: PluginClient }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const node = await client.node.readSelf();
        const payload = (node.payload ?? {}) as SheetPayload;
        if (active) setFrameCount(Array.isArray(payload.frames) ? payload.frames.length : 0);
        const image = (await client.inputs.list()).find(input => input.kind === 'image');
        if (!image) { if (active) setSize(null); return; }
        const bitmap = await client.inputs.readBitmap(image.handle);
        if (!active) { bitmap.close(); return; }
        setSize({ width: bitmap.width, height: bitmap.height });
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
        setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const stopNode = client.on('node.changed', () => void refresh());
    const stopInputs = client.on('inputs.changed', () => void refresh());
    return () => { active = false; stopNode(); stopInputs(); };
  }, [client]);

  return <div className="sheet">
    <canvas ref={canvasRef} hidden={!size} />
    {!size && <div className="empty">{error ?? '连接一张图片'}</div>}
    <footer>{size ? `${size.width} × ${size.height} · ${frameCount} 帧` : `${frameCount} 帧`}</footer>
  </div>;
}

const style = document.createElement('style');
style.textContent = STYLE;
document.head.appendChild(style);

void connect().then(client => {
  createRoot(document.getElementById('root')!).render(<StrictMode><SheetNode client={client} /></StrictMode>);
});
