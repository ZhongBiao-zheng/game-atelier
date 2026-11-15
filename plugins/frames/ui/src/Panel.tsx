import { useEffect, useMemo, useRef, useState } from 'react';

import { PluginRpcError, type PluginClient } from '../../../sdk';
import { Button, Checkbox, NumberField, SelectField, ThumbButton } from './kit/controls';
import { LONG_EDGE_MAX, LONG_EDGE_MIN, MAX_FRAMES, outputSize, planFrames, PlanError, type Mode } from './plan';
import { DEFAULT_LONG_EDGE, DEFAULT_STATE, parseState, requestParams, type ExtractState } from './state';

interface VideoMeta { width: number; height: number; fps: number; frame_count: number; title: string }
interface Preview { key: string; frames: number[]; thumbnails: string[] }

const MODE_OPTIONS: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'count', label: '目标帧数' }, { value: 'step', label: '每隔几帧' }, { value: 'rate', label: '每秒几帧' },
];
const SIZE_OPTIONS = [{ value: 'original', label: '原尺寸' }, { value: 'long', label: '按长边' }] as const;
const PREVIEW_DELAY = 350;
const message = (error: unknown) => (error instanceof PluginRpcError && error.code === 'SERVER_ERROR' ? error.message : '处理失败，请重试');

/** 编辑面板：选区间、抽帧方式与尺寸，预览将要抽出的帧，抽成结果组放到画布。 */
export function Panel({ client }: { client: PluginClient }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ExtractState>(DEFAULT_STATE);
  const [source, setSource] = useState<{ handle: string; meta: VideoMeta } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const latest = useRef(state);

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    void (async () => {
      const node = await client.node.readSelf();
      const initial = parseState(node.payload);
      latest.current = initial;
      setState(initial);
      const input = (await client.inputs.list()).find(item => item.kind === 'video');
      if (!input) return;
      const meta = await client.server.call<VideoMeta>('/probe', {}, [input.handle]);
      if (!active) return;
      setSource({ handle: input.handle, meta });
      // 视频只在面板里预览播放；抽帧在本机服务端按帧号解码。太大的视频不读进面板，照样能抽。
      const bytes = await client.inputs.readBytes(input.handle).catch(() => null);
      if (!active || !bytes) return;
      url = URL.createObjectURL(new Blob([bytes]));
      setVideoUrl(url);
    })().catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [client]);

  const save = (patch: Partial<ExtractState>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setState(next);
    setDone(null);
    void client.node.writeSelf(next).catch(() => setError('保存失败，请重试'));
  };

  const meta = source?.meta;
  const plan = useMemo(() => {
    if (!meta) return null;
    try { return { frames: planFrames(meta.frame_count, meta.fps, state), error: null }; }
    catch (cause) { return { frames: [], error: cause instanceof PlanError ? cause.message : '抽帧参数不对' }; }
  }, [meta, state]);
  const size = meta ? outputSize(meta.width, meta.height, state.long_edge) : null;
  const previewKey = plan && !plan.error ? plan.frames.join(',') : '';

  // 参数停下来一会儿再向服务端要缩略图：缩略图就是将要抽出的那几帧，不是浏览器播放位置的近似。
  useEffect(() => {
    if (!source || !previewKey) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void client.server.call<{ frames: number[]; thumbnails: string[] }>(
        '/preview', { ...requestParams(latest.current), long_edge: null }, [source.handle],
      ).then(result => { if (active) setPreview({ key: previewKey, ...result }); })
        .catch(cause => { if (active) setError(message(cause)); });
    }, PREVIEW_DELAY);
    return () => { active = false; window.clearTimeout(timer); };
  }, [client, source, previewKey]);

  const currentFrame = () => {
    const element = videoRef.current;
    if (!element || !meta) return 0;
    return Math.min(meta.frame_count - 1, Math.max(0, Math.floor(element.currentTime * meta.fps + 1e-6)));
  };
  const seek = (frame: number) => {
    const element = videoRef.current;
    if (element && meta) { element.pause(); element.currentTime = (frame + 0.5) / meta.fps; }
  };

  const extract = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await client.server.call<{ frames: number[]; frame_data_error?: string }>(
        '/extract', requestParams(latest.current), [source.handle]);
      setDone(result.frame_data_error ?? `已放到画布：${result.frames.length} 帧`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!source || !meta) {
    return <div className="panel"><div className="empty">{error ?? (loaded ? '连接一个视频' : '读取中')}</div></div>;
  }
  const lastFrame = meta.frame_count - 1;
  const end = state.end ?? lastFrame;
  const shown = preview && preview.key === previewKey ? preview : null;
  return <div className="panel">
    <div className="main">
      <div className="stage">
        {videoUrl
          ? <video ref={videoRef} src={videoUrl} controls muted playsInline preload="auto" />
          : <div className="empty">视频过大，面板里不播放；仍可抽帧</div>}
      </div>
      <div className="strip">
        <div className="strip-frames" aria-label="将要抽出的帧">
          {plan?.frames.map((frame, index) => (
            <ThumbButton key={frame} label={`第 ${frame} 帧`} onClick={() => seek(frame)}>
              {shown?.thumbnails[index] ? <img src={shown.thumbnails[index]} alt="" /> : <span className="thumb-wait" />}
              <span className="index">{frame}</span>
            </ThumbButton>
          ))}
        </div>
      </div>
    </div>
    <aside className="side">
      <section className="group">
        <h2>区间</h2>
        <div className="row">
          <NumberField label="起始帧" value={state.start} min={0} max={lastFrame} onChange={start => save({ start })} />
          <NumberField label="结束帧" value={end} min={0} max={lastFrame}
            onChange={value => save({ end: value === lastFrame ? null : value })} />
        </div>
        {videoUrl && <div className="row">
          <Button small onClick={() => save({ start: currentFrame() })}>起点设为当前</Button>
          <Button small onClick={() => { const frame = currentFrame(); save({ end: frame === lastFrame ? null : frame }); }}>终点设为当前</Button>
        </div>}
        <p className="count">{meta.frame_count} 帧 · {meta.fps} fps · {meta.width} × {meta.height}</p>
      </section>
      <section className="group">
        <h2>抽帧</h2>
        <div className="row">
          <SelectField label="方式" value={state.mode} options={MODE_OPTIONS} onChange={mode => save({ mode })} />
          {state.mode === 'count' && <NumberField label="帧数" value={state.count} min={1} max={MAX_FRAMES}
            onChange={count => save({ count })} />}
          {state.mode === 'step' && <NumberField label="间隔" value={state.step} min={1} max={Math.max(1, lastFrame)}
            onChange={step => save({ step })} />}
          {state.mode === 'rate' && <NumberField label="每秒" value={state.rate} min={1} max={60}
            onChange={rate => save({ rate })} />}
        </div>
      </section>
      <section className="group">
        <h2>尺寸</h2>
        <div className="row">
          <SelectField label="输出" value={state.long_edge === null ? 'original' : 'long'} options={SIZE_OPTIONS}
            onChange={value => save({ long_edge: value === 'original' ? null : DEFAULT_LONG_EDGE })} />
          {state.long_edge !== null && <NumberField label="长边" value={state.long_edge} min={LONG_EDGE_MIN} max={LONG_EDGE_MAX}
            onChange={longEdge => save({ long_edge: longEdge })} />}
        </div>
        {size && <p className="count">{size[0]} × {size[1]}</p>}
      </section>
      <section className="group">
        <h2>输出</h2>
        <Checkbox label="拼成精灵表" checked={state.sheet} onChange={sheet => save({ sheet })} />
        {state.sheet && <>
          <NumberField label="每行帧数" value={state.columns} min={1} max={MAX_FRAMES} onChange={columns => save({ columns })} />
          <Checkbox label="同时输出帧数据" checked={state.frame_data} onChange={frameData => save({ frame_data: frameData })} />
        </>}
      </section>
      <div className="spacer" />
      {(plan?.error ?? error) && <p role="alert" className="error">{plan?.error ?? error}</p>}
      {done && <p role="status" className="done">{done}</p>}
      <Button primary disabled={busy || !plan || Boolean(plan.error)} onClick={() => void extract()}>
        {busy ? '正在抽帧' : `抽帧（${plan?.frames.length ?? 0} 帧）`}
      </Button>
    </aside>
  </div>;
}
