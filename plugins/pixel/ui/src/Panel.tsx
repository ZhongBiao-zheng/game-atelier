import { useEffect, useRef, useState } from 'react';

import { PluginRpcError, type PluginClient, type PluginInput } from '../../../sdk';
import { Button, Checkbox, NumberField, SelectField, Swatch, ThumbButton } from './kit/controls';
import { DEFAULT_STATE, LIMITS, parseState, requestParams, type Downsample, type PixelState, type SizeMode } from './state';

const SIZE_OPTIONS: ReadonlyArray<{ value: SizeMode; label: string }> = [
  { value: 'long_edge', label: '按长边' }, { value: 'block', label: '按像素块' },
];
const DOWNSAMPLE_OPTIONS: ReadonlyArray<{ value: Downsample; label: string }> = [
  { value: 'mode', label: '主色' }, { value: 'average', label: '平均' },
];
const THUMB_EDGE = 384;
const PREVIEW_DELAY = 250;
const message = (error: unknown) => (error instanceof PluginRpcError && error.code === 'SERVER_ERROR' ? error.message : '处理失败，请重试');

/** 把一张输入画成小图的 data URL：位图用完就关，几十帧也不常驻内存。 */
async function thumbnail(client: PluginClient, input: PluginInput): Promise<string> {
  const bitmap = await client.inputs.readBitmap(input.handle);
  const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.9);
}

interface Preview { key: string; url: string; size: [number, number]; colors: string[] }

/** 编辑面板：原图与像素化结果并排，参数一改就由服务端重算预览，确认后放到画布。 */
export function Panel({ client }: { client: PluginClient }) {
  const [state, setState] = useState<PixelState>(DEFAULT_STATE);
  const [frames, setFrames] = useState<PluginInput[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [frame, setFrame] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const latest = useRef(state);

  useEffect(() => {
    let active = true;
    void (async () => {
      const node = await client.node.readSelf();
      const initial = parseState(node.payload);
      latest.current = initial;
      setState(initial);
      const images = (await client.inputs.list()).filter(input => input.kind === 'image');
      if (!active) return;
      setFrames(images);
      for (const input of images) {
        const url = await thumbnail(client, input);
        if (!active) return;
        setThumbs(current => ({ ...current, [input.handle]: url }));
      }
    })().catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [client]);

  const save = (patch: Partial<PixelState>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setState(next);
    setDone(null);
    void client.node.writeSelf(next).catch(() => setError('保存失败，请重试'));
  };

  const handles = (frames ?? []).map(item => item.handle);
  const current = Math.min(frame, Math.max(0, handles.length - 1));
  // 放大倍数与是否另出原尺寸不影响预览本身，不触发重算。
  const previewKey = handles.length ? JSON.stringify([
    state.size_mode, state.long_edge, state.block, state.downsample, state.palette.colors, state.shared_palette,
    state.alpha_threshold, current, handles,
  ]) : '';

  useEffect(() => {
    if (!previewKey) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void client.server.call<Omit<Preview, 'key'>>('/preview', { ...requestParams(latest.current), frame: current }, handles)
        .then(result => { if (active) { setPreview({ key: previewKey, ...result }); setError(null); } })
        .catch(cause => { if (active) setError(message(cause)); });
    }, PREVIEW_DELAY);
    return () => { active = false; window.clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- previewKey 已包含参数、帧与输入
  }, [client, previewKey]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await client.server.call<{ frame_count: number }>('/pixelate', requestParams(latest.current), handles);
      setDone(`已放到画布：${result.frame_count} 张`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!frames) return <div className="panel"><div className="empty">{error ?? '读取中'}</div></div>;
  if (frames.length === 0) return <div className="panel"><div className="empty">连接一张图片，或一个结果组</div></div>;
  const source = frames[current];
  // 参数刚改、新预览还没回来时继续显示上一张，并标成过期（变淡），不闪空白。
  const stale = !preview || preview.key !== previewKey;
  const outputSize = preview ? [preview.size[0] * state.upscale, preview.size[1] * state.upscale] : null;
  return <div className="panel">
    <div className="main">
      <div className="stage compare-stage">
        <figure><img src={thumbs[source.handle]} alt="" /><figcaption>原图</figcaption></figure>
        <figure className={stale ? 'pixel-result stale' : 'pixel-result'}>
          {preview ? <img src={preview.url} alt="" /> : <span className="thumb-wait" />}
          <figcaption>{preview ? `${preview.size[0]} × ${preview.size[1]}` : '像素化'}</figcaption>
        </figure>
      </div>
      {frames.length > 1 && <div className="strip">
        <div className="strip-frames" aria-label="帧">
          {frames.map((item, index) => (
            <ThumbButton key={item.handle} label={`第 ${index + 1} 张`} selected={index === current} onClick={() => setFrame(index)}>
              {thumbs[item.handle] ? <img src={thumbs[item.handle]} alt="" /> : <span className="thumb-wait" />}
              <span className="index">{index + 1}</span>
            </ThumbButton>
          ))}
        </div>
      </div>}
    </div>
    <aside className="side">
      <section className="group">
        <h2>尺寸</h2>
        <div className="row">
          <SelectField label="方式" value={state.size_mode} options={SIZE_OPTIONS} onChange={sizeMode => save({ size_mode: sizeMode })} />
          {state.size_mode === 'long_edge'
            ? <NumberField label="长边" value={state.long_edge} min={LIMITS.longEdge[0]} max={LIMITS.longEdge[1]}
              onChange={longEdge => save({ long_edge: longEdge })} />
            : <NumberField label="几合一" value={state.block} min={LIMITS.block[0]} max={LIMITS.block[1]}
              onChange={block => save({ block })} />}
        </div>
        <SelectField label="取色" value={state.downsample} options={DOWNSAMPLE_OPTIONS} onChange={downsample => save({ downsample })} />
      </section>
      <section className="group">
        <h2>颜色</h2>
        <NumberField label="颜色数" value={state.palette.colors} min={LIMITS.colors[0]} max={LIMITS.colors[1]}
          onChange={colors => save({ palette: { kind: 'auto', colors } })} />
        {preview && <div className="swatches" aria-label="调色板">
          {preview.colors.map(color => <Swatch key={color} color={color} />)}
        </div>}
        {frames.length > 1 && <Checkbox label="整组共用调色板" checked={state.shared_palette}
          onChange={shared => save({ shared_palette: shared })} />}
        <NumberField label="透明阈值" value={state.alpha_threshold} min={LIMITS.alpha[0]} max={LIMITS.alpha[1]}
          onChange={alpha => save({ alpha_threshold: alpha })} />
      </section>
      <section className="group">
        <h2>输出</h2>
        <NumberField label="放大倍数" value={state.upscale} min={LIMITS.upscale[0]} max={LIMITS.upscale[1]}
          onChange={upscale => save({ upscale })} />
        {state.upscale > 1 && <Checkbox label="同时输出原尺寸" checked={state.keep_original_size}
          onChange={keep => save({ keep_original_size: keep })} />}
        {outputSize && <p className="count">{outputSize[0]} × {outputSize[1]}</p>}
      </section>
      <div className="spacer" />
      {error && <p role="alert" className="error">{error}</p>}
      {done && <p role="status" className="done">{done}</p>}
      <Button primary disabled={busy} onClick={() => void run()}>
        {busy ? '正在像素化' : `像素化（${frames.length} 张）`}
      </Button>
    </aside>
  </div>;
}
