import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { PluginRpcError, type PluginClient } from '../../../sdk';
import { createBoxReader, drawCell, token } from './draw';
import { FrameEditor } from './FrameEditor';
import { FrameStrip } from './FrameStrip';
import { Button, Checkbox, NumberField, SelectField } from './kit/controls';
import { anchorPoint, layoutFrames } from './layout';
import {
  DEFAULT_GRID, DEFAULT_STATE, MAX_OFFSET, gridFrames, moveFrame, nudgeFrame, parseState,
  type Align, type Grid, type SheetState,
} from './sheetState';

const ALIGN_OPTIONS: ReadonlyArray<{ value: Align; label: string }> = [
  { value: 'bottom-center', label: '底部居中' }, { value: 'center', label: '居中' }, { value: 'top-left', label: '左上' },
];
const NUDGE_SAVE_DELAY = 250;
const message = (error: unknown) => (error instanceof PluginRpcError && error.code === 'SERVER_ERROR' ? error.message : '处理失败，请重试');
const typing = (target: EventTarget | null) => target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);

/** 编辑面板：切帧、整理帧列表、逐帧微调与锚点、预览、重排并放到画布。 */
export function Panel({ client }: { client: PluginClient }) {
  const stageRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<SheetState>(DEFAULT_STATE);
  const [source, setSource] = useState<{ handle: string; bitmap: ImageBitmap } | null>(null);
  const [selected, setSelected] = useState(0);
  const [grid, setGrid] = useState<Grid>(DEFAULT_GRID);
  const [frameData, setFrameData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const latest = useRef(state);
  const pending = useRef<number | null>(null);

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
      latest.current = loaded;
      setState(loaded);
      if (loaded.grid) setGrid(loaded.grid);
      setSource(image && bitmap ? { handle: image.handle, bitmap } : null);
    })().catch(() => { if (active) setError('读取失败，请重试'); });
    return () => { active = false; held?.close(); };
  }, [client]);

  const write = (next: SheetState) => {
    void client.node.writeSelf(next).catch(() => setError('保存失败，请重试'));
  };
  const flush = () => {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
    write(latest.current);
  };
  /** 改设置即保存到节点。连续微调合成一次保存：撤销一步回到微调之前。 */
  const save = (patch: Partial<SheetState>, debounce = false) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setState(next);
    setDone(null);
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = null;
    if (debounce) pending.current = window.setTimeout(() => { pending.current = null; write(latest.current); }, NUDGE_SAVE_DELAY);
    else write(next);
  };

  const frames = state.frames;
  const current = Math.min(selected, Math.max(0, frames.length - 1));
  const reader = useMemo(() => (source ? createBoxReader(source.bitmap) : null), [source]);
  const layout = useMemo(() => (reader ? layoutFrames(frames, reader, { align: state.align, trim: state.trim }) : null),
    [reader, frames, state.align, state.trim]);

  const removeCurrent = () => {
    if (frames.length === 0) return;
    save({ frames: frames.filter((_, index) => index !== current) });
    setSelected(Math.max(0, current - 1));
  };

  // 键盘：方向键微调当前帧（Shift 每次 10 像素），Delete 删除当前帧。Esc 关面板由 SDK 处理，这里先把未保存的微调写出去。
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyRef.current = event => {
    if (event.key === 'Escape') { flush(); return; }
    if (typing(event.target) || event.isComposing || frames.length === 0) return;
    const step = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (delta) {
      event.preventDefault();
      save({ frames: nudgeFrame(frames, current, delta[0], delta[1]) }, true);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeCurrent();
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  useEffect(() => {
    const canvas = stageRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !source) return;
    canvas.width = source.bitmap.width;
    canvas.height = source.bitmap.height;
    context.drawImage(source.bitmap, 0, 0);
    const line = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / 512));
    const primary = token('primary');
    frames.forEach((frame, index) => {
      context.strokeStyle = primary;
      context.globalAlpha = index === current ? 1 : 0.55;
      context.lineWidth = index === current ? line * 2 : line;
      context.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
    });
    context.globalAlpha = 1;
  }, [source, frames, current]);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !source || !layout || layout.items.length === 0) return;
    let index = 0;
    const draw = () => { drawCell(canvas, source.bitmap, layout, index % layout.items.length, { fit: 88 }); index += 1; };
    draw();
    const timer = window.setInterval(draw, 1000 / state.fps);
    return () => window.clearInterval(timer);
  }, [source, layout, state.fps]);

  const pickOnStage = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * event.currentTarget.width;
    const y = (event.clientY - rect.top) / rect.height * event.currentTarget.height;
    const hit = frames.findIndex(frame => x >= frame.x && x < frame.x + frame.w && y >= frame.y && y < frame.y + frame.h);
    if (hit >= 0) setSelected(hit);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try { await work(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const detect = () => run(async () => {
    const found = await client.server.call<{ frames: SheetState['frames']; columns: number }>('/detect', {}, [source!.handle]);
    save({ frames: found.frames, grid: null, columns: Math.max(1, Math.min(64, found.columns || state.columns)) });
    setSelected(0);
  });
  const applyGrid = () => {
    save({ frames: gridFrames(source!.bitmap.width, source!.bitmap.height, grid), grid, columns: grid.columns });
    setSelected(0);
  };
  const place = () => run(async () => {
    flush();
    const result = await client.server.call<{ frame_data_error?: string }>('/repack', {
      frames, columns: state.columns, spacing: state.spacing, margin: state.margin, align: state.align,
      trim: state.trim, anchor: state.anchor, frame_data: frameData,
    }, [source!.handle]);
    setDone(result.frame_data_error ?? '已放到画布');
  });

  if (!source) return <div className="panel"><div className="empty">{error ?? '连接一张图片'}</div></div>;
  const frame = frames[current];
  const anchorPx = layout ? anchorPoint(layout.cellW, layout.cellH, state.anchor) : [0, 0];
  return <div className="panel">
    <div className="main">
      <div className="stage" tabIndex={0} aria-label="原图" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Delete">
        <canvas ref={stageRef} onPointerDown={pickOnStage} />
      </div>
      {frames.length > 0 && <div className="strip">
        <FrameStrip bitmap={source.bitmap} frames={frames} selected={current} onSelect={setSelected}
          onMove={(from, to) => { save({ frames: moveFrame(frames, from, to) }); setSelected(to); }} />
        <div className="strip-actions">
          <Button small onClick={() => { save({ frames: [...frames].reverse() }); setSelected(frames.length - 1 - current); }}>反转</Button>
          <Button small onClick={removeCurrent}>删除</Button>
        </div>
      </div>}
    </div>
    <aside className="side">
      <section className="group">
        <h2>切帧</h2>
        <Button disabled={busy} onClick={() => void detect()}>自动识别</Button>
        <div className="row">
          <NumberField label="列" value={grid.columns} min={1} max={64} onChange={columns => setGrid({ ...grid, columns })} />
          <NumberField label="行" value={grid.rows} min={1} max={64} onChange={rows => setGrid({ ...grid, rows })} />
        </div>
        <div className="row">
          <NumberField label="边距" value={grid.margin} min={0} max={512} onChange={margin => setGrid({ ...grid, margin })} />
          <NumberField label="间距" value={grid.spacing} min={0} max={512} onChange={spacing => setGrid({ ...grid, spacing })} />
        </div>
        <Button disabled={busy} onClick={applyGrid}>按网格切</Button>
        <p className="count">{frames.length} 帧</p>
      </section>
      {frame && layout && <section className="group">
        <h2>第 {current + 1} 帧</h2>
        <FrameEditor bitmap={source.bitmap} layout={layout} index={current} onion={state.onion} anchor={state.anchor}
          onAnchor={anchor => save({ anchor })} />
        <div className="row">
          <NumberField label="偏移 X" value={frame.ox ?? 0} min={-MAX_OFFSET} max={MAX_OFFSET}
            onChange={ox => save({ frames: nudgeFrame(frames, current, ox - (frame.ox ?? 0), 0) })} />
          <NumberField label="偏移 Y" value={frame.oy ?? 0} min={-MAX_OFFSET} max={MAX_OFFSET}
            onChange={oy => save({ frames: nudgeFrame(frames, current, 0, oy - (frame.oy ?? 0)) })} />
        </div>
        <div className="row">
          <NumberField label="锚点 X" value={anchorPx[0]} min={0} max={layout.cellW}
            onChange={x => save({ anchor: { ...state.anchor, x: layout.cellW ? x / layout.cellW : 0.5 } })} />
          <NumberField label="锚点 Y" value={anchorPx[1]} min={0} max={layout.cellH}
            onChange={y => save({ anchor: { ...state.anchor, y: layout.cellH ? y / layout.cellH : 1 } })} />
        </div>
        <Checkbox label="洋葱皮" checked={state.onion} onChange={onion => save({ onion })} />
      </section>}
      <section className="group">
        <h2>预览</h2>
        <div className="preview">{frames.length > 0 && <canvas ref={previewRef} />}</div>
        <NumberField label="帧率" value={state.fps} min={1} max={60} onChange={fps => save({ fps })} />
      </section>
      <section className="group">
        <h2>重排</h2>
        <div className="row">
          <NumberField label="每行帧数" value={state.columns} min={1} max={64} onChange={columns => save({ columns })} />
          <NumberField label="间距" value={state.spacing} min={0} max={256} onChange={spacing => save({ spacing })} />
        </div>
        <div className="row">
          <NumberField label="外边距" value={state.margin} min={0} max={256} onChange={margin => save({ margin })} />
          <SelectField label="对齐" value={state.align} options={ALIGN_OPTIONS} onChange={align => save({ align })} />
        </div>
        <Checkbox label="裁掉透明边" checked={state.trim} onChange={trim => save({ trim })} />
        <Checkbox label="同时输出帧数据" checked={frameData} onChange={setFrameData} />
      </section>
      <div className="spacer" />
      {error && <p role="alert" className="error">{error}</p>}
      {done && <p role="status" className="done">{done}</p>}
      <Button primary disabled={busy || frames.length === 0} onClick={() => void place()}>放到画布</Button>
    </aside>
  </div>;
}
