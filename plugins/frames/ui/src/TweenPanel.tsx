import { useEffect, useRef, useState } from 'react';

import { PluginRpcError, type PluginClient, type PluginInput } from '../../../sdk';
import { Button, Checkbox, NumberField, SelectField, ThumbButton } from './kit/controls';
import {
  DEFAULT_TWEEN, MAX_BETWEEN, MAX_OUTPUT, outputCount, parseTween, tweenSequence,
  type TweenMethod, type TweenOutput, type TweenState,
} from './tweenState';

const METHOD_OPTIONS: ReadonlyArray<{ value: TweenMethod; label: string }> = [
  { value: 'flow', label: '光流' }, { value: 'crossfade', label: '交叉淡化' },
];
const OUTPUT_OPTIONS: ReadonlyArray<{ value: TweenOutput; label: string }> = [
  { value: 'all', label: '原帧 + 补出的帧' }, { value: 'new', label: '只要补出的帧' },
];
const THUMB_EDGE = 256;
const PREVIEW_DELAY = 300;
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

/** 编辑面板：帧序列、补间方式与数量，预览一对帧的中间帧，补出的帧放到画布。 */
export function TweenPanel({ client }: { client: PluginClient }) {
  const [state, setState] = useState<TweenState>(DEFAULT_TWEEN);
  const [inputs, setInputs] = useState<PluginInput[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [pair, setPair] = useState(0);
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const latest = useRef(state);

  useEffect(() => {
    let active = true;
    void (async () => {
      const node = await client.node.readSelf();
      const initial = parseTween(node.payload);
      latest.current = initial;
      setState(initial);
      const list = await client.inputs.list();
      if (!active) return;
      setInputs(list);
      for (const input of list.filter(item => item.kind === 'image')) {
        const url = await thumbnail(client, input);
        if (!active) return;
        setThumbs(current => ({ ...current, [input.handle]: url }));
      }
    })().catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [client]);

  const save = (patch: Partial<TweenState>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setState(next);
    setDone(null);
    void client.node.writeSelf(next).catch(() => setError('保存失败，请重试'));
  };

  const sequence = inputs ? tweenSequence(inputs, state.swap) : null;
  const items = sequence?.items ?? [];
  const pairIndex = Math.min(pair, Math.max(0, items.length - 2));
  const handles = items.map(item => item.handle);
  const previewKey = sequence?.kind === 'none' ? '' : `${state.method}|${pairIndex}|${handles.join(',')}`;
  const total = outputCount(items.length, state);
  const tooMany = total > MAX_OUTPUT;

  useEffect(() => {
    if (!previewKey) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void client.server.call<{ url: string }>('/tween_preview', { method: latest.current.method, pair: pairIndex }, handles)
        .then(result => { if (active) setPreview({ key: previewKey, url: result.url }); })
        .catch(cause => { if (active) setError(message(cause)); });
    }, PREVIEW_DELAY);
    return () => { active = false; window.clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- previewKey 已包含方式、帧对与序列
  }, [client, previewKey]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { method, between, output, sheet, columns, frame_data: frameData } = latest.current;
      const result = await client.server.call<{ frame_count: number; frame_data_error?: string }>(
        '/tween', { method, between, output, sheet, columns, frame_data: frameData }, handles);
      setDone(result.frame_data_error ?? `已放到画布：${result.frame_count} 帧`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!inputs) return <div className="panel"><div className="empty">{error ?? '读取中'}</div></div>;
  if (!sequence || sequence.kind === 'none') {
    return <div className="panel"><div className="empty">连接两张图片，或一个结果组</div></div>;
  }
  const first = items[pairIndex];
  const second = items[pairIndex + 1];
  const shown = preview && preview.key === previewKey ? preview.url : null;
  return <div className="panel">
    <div className="main">
      <div className="stage tween-stage">
        <figure><img src={thumbs[first.handle]} alt="" /><figcaption>第 {pairIndex + 1} 帧</figcaption></figure>
        <figure className="tween-middle">
          {shown ? <img src={shown} alt="" /> : <span className="thumb-wait" />}
          <figcaption>中间帧</figcaption>
        </figure>
        <figure><img src={thumbs[second.handle]} alt="" /><figcaption>第 {pairIndex + 2} 帧</figcaption></figure>
      </div>
      <div className="strip">
        <div className="strip-frames" aria-label="帧序列">
          {items.map((item, index) => (
            <ThumbButton key={item.handle} label={`第 ${index + 1} 帧`} selected={index === pairIndex || index === pairIndex + 1}
              onClick={() => setPair(Math.min(index, items.length - 2))}>
              {thumbs[item.handle] ? <img src={thumbs[item.handle]} alt="" /> : <span className="thumb-wait" />}
              <span className="index">{index + 1}</span>
            </ThumbButton>
          ))}
        </div>
      </div>
    </div>
    <aside className="side">
      <section className="group">
        <h2>补间</h2>
        <SelectField label="方式" value={state.method} options={METHOD_OPTIONS} onChange={method => save({ method })} />
        <NumberField label="每两帧之间补" value={state.between} min={1} max={MAX_BETWEEN} onChange={between => save({ between })} />
        <SelectField label="输出" value={state.output} options={OUTPUT_OPTIONS} onChange={output => save({ output })} />
        {sequence.kind === 'pair' && <Checkbox label="交换首尾" checked={state.swap} onChange={swap => save({ swap })} />}
        <p className="count">{items.length} 帧 → {total} 帧</p>
      </section>
      <section className="group">
        <h2>输出</h2>
        <Checkbox label="拼成精灵表" checked={state.sheet} onChange={sheet => save({ sheet })} />
        {state.sheet && <>
          <NumberField label="每行帧数" value={state.columns} min={1} max={MAX_OUTPUT} onChange={columns => save({ columns })} />
          <Checkbox label="同时输出帧数据" checked={state.frame_data} onChange={frameData => save({ frame_data: frameData })} />
        </>}
      </section>
      <div className="spacer" />
      {tooMany && <p role="alert" className="error">最多输出 {MAX_OUTPUT} 帧，现在是 {total} 帧</p>}
      {!tooMany && error && <p role="alert" className="error">{error}</p>}
      {done && <p role="status" className="done">{done}</p>}
      <Button primary disabled={busy || tooMany} onClick={() => void run()}>
        {busy ? '正在补间' : `补间（${total} 帧）`}
      </Button>
    </aside>
  </div>;
}
