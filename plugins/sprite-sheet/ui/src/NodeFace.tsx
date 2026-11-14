import { useEffect, useRef, useState } from 'react';

import type { PluginClient } from '../../../sdk';
import { parseState } from './sheetState';

/** 节点内容面：显示连入的图与已切出的帧数。编辑在面板里做（双击节点打开）。 */
export function NodeFace({ client }: { client: PluginClient }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const node = await client.node.readSelf();
        if (active) setFrameCount(parseState(node.payload).frames.length);
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
      } catch {
        if (active) setSize(null);
      }
    };
    void refresh();
    const stopNode = client.on('node.changed', () => void refresh());
    const stopInputs = client.on('inputs.changed', () => void refresh());
    return () => { active = false; stopNode(); stopInputs(); };
  }, [client]);

  return <div className="face">
    <canvas ref={canvasRef} hidden={!size} />
    {!size && <div className="empty">连接一张图片</div>}
    <footer>{size ? `${size.width} × ${size.height} · ${frameCount} 帧` : `${frameCount} 帧`}</footer>
  </div>;
}
