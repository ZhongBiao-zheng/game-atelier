import { useEffect, useRef, useState } from 'react';

import { PluginRpcError, type PluginClient } from '../../../sdk';
import { Button, Checkbox, NumberField, SelectField } from './kit/controls';
import { DEFAULT_STATE, gridFrames, parseState, type Align, type Frame, type SheetState } from './sheetState';

const ALIGN_OPTIONS: ReadonlyArray<{ value: Align; label: string }> = [
  { value: 'bottom-center', label: '底部居中' }, { value: 'center', label: '居中' }, { value: 'top-left', label: '左上' },
];
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const message = (error: unknown) => (error instanceof PluginRpcError && error.code === 'SERVER_ERROR' ? error.message : '处理失败，请重试');

/** 编辑面板：切帧（自动识别或手动网格）、预览播放、重排并放到画布。 */
export function Panel({ client }: { client: PluginClient }) {
  const stageRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<SheetState>(DEFAULT_STATE);
  const [source, setSource] = useState<{ handle: string; bitmap: ImageBitmap } | null>(null);
  const [grid, setGrid] = useState({ columns: 4, rows: 1 });
  const [frameData, setFrameData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let held: ImageBitmap | null = null;
    void (async () => {
      const node = await client.node.readSelf();
      const loaded = parseState(node.payload);
      const image = (await client.inputs.list()).find(input => input.kind === 'image');
      const bitmap = image ? await client.inputs.readBitmap(image.handle) : null;
      if (!active) { bitmap?.close(); return; }
      held = bitmap;
      setState(loaded);
      if (loaded.grid) setGrid(loaded.grid);
      setSource(image && bitmap ? { handle: image.handle, bitmap } : null);
    })().catch(() => { if (active) setError('读取失败，请重试'); });
    return () => { active = false; held?.close(); };
  }, [client]);

  /** 改设置即保存到节点：关掉面板不丢，撤销也认得。 */
  const update = (patch: Partial<SheetState>) => {
    const next = { ...state, ...patch };
    setState(next);
    setDone(null);
    void client.node.writeSelf(next).catch(() => setError('保存失败，请重试'));
  };

  useEffect(() => {
    const canvas = stageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !source) return;
    canvas.width = source.bitmap.width;
    canvas.height = source.bitmap.height;
    context.drawImage(source.bitmap, 0, 0);
    context.strokeStyle = token('primary');
    context.lineWidth = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / 512));
    for (const frame of state.frames) context.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
  }, [source, state.frames]);

  useEffect(() => {
    const canvas = previewRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !source || state.frames.length === 0) return;
    let index = 0;
    const draw = () => {
      const frame: Frame = state.frames[index % state.frames.length];
      canvas.width = frame.w;
      canvas.height = frame.h;
      context.imageSmoothingEnabled = false;
      context.drawImage(source.bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      index += 1;
    };
    draw();
    const timer = window.setInterval(draw, 1000 / state.fps);
    return () => window.clearInterval(timer);
  }, [source, state.frames, state.fps]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try { await work(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const detect = () => run(async () => {
    const found = await client.server.call<{ frames: Frame[]; columns: number; rows: number }>('/detect', {}, [source!.handle]);
    update({ frames: found.frames, grid: null, columns: Math.max(1, Math.min(64, found.columns || state.columns)) });
  });
  const applyGrid = () => update({ frames: gridFrames(source!.bitmap.width, source!.bitmap.height, grid.columns, grid.rows), grid });
  const place = () => run(async () => {
    const result = await client.server.call<{ frame_data_error?: string }>('/repack', {
      frames: state.frames, columns: state.columns, spacing: state.spacing, align: state.align, frame_data: frameData,
    }, [source!.handle]);
    setDone(result.frame_data_error ?? '已放到画布');
  });

  if (!source) return <div className="panel"><div className="empty">{error ?? '连接一张图片'}</div></div>;
  return <div className="panel">
    <div className="stage"><canvas ref={stageRef} /></div>
    <aside className="side">
      <section className="group">
        <h2>切帧</h2>
        <Button disabled={busy} onClick={() => void detect()}>自动识别</Button>
        <div className="row">
          <NumberField label="列" value={grid.columns} min={1} max={64} onChange={columns => setGrid({ ...grid, columns })} />
          <NumberField label="行" value={grid.rows} min={1} max={64} onChange={rows => setGrid({ ...grid, rows })} />
        </div>
        <Button disabled={busy} onClick={applyGrid}>按网格切</Button>
        <p className="count">{state.frames.length} 帧</p>
      </section>
      <section className="group">
        <h2>预览</h2>
        <div className="preview">{state.frames.length > 0 && <canvas ref={previewRef} />}</div>
        <NumberField label="帧率" value={state.fps} min={1} max={60} onChange={fps => update({ fps })} />
      </section>
      <section className="group">
        <h2>重排</h2>
        <div className="row">
          <NumberField label="每行帧数" value={state.columns} min={1} max={64} onChange={columns => update({ columns })} />
          <NumberField label="间距" value={state.spacing} min={0} max={256} onChange={spacing => update({ spacing })} />
        </div>
        <SelectField label="对齐" value={state.align} options={ALIGN_OPTIONS} onChange={align => update({ align })} />
        <Checkbox label="同时输出帧数据" checked={frameData} onChange={setFrameData} />
      </section>
      <div className="spacer" />
      {error && <p role="alert" className="error">{error}</p>}
      {done && <p role="status" className="done">{done}</p>}
      <Button primary disabled={busy || state.frames.length === 0} onClick={() => void place()}>放到画布</Button>
    </aside>
  </div>;
}
