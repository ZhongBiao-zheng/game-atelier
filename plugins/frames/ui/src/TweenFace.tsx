import { useEffect, useState } from 'react';

import type { PluginClient } from '../../../sdk';
import { methodLabel, outputCount, parseTween, tweenSequence, type TweenState } from './tweenState';

/** 节点内容面：帧数与补间设置摘要。设置与预览在面板里做（双击节点打开）。 */
export function TweenFace({ client }: { client: PluginClient }) {
  const [state, setState] = useState<TweenState | null>(null);
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const node = await client.node.readSelf();
        const parsed = parseTween(node.payload);
        const sequence = tweenSequence(await client.inputs.list(), parsed.swap);
        if (!active) return;
        setState(parsed);
        setFrames(sequence.kind === 'none' ? 0 : sequence.items.length);
      } catch {
        if (active) setFrames(0);
      }
    };
    void refresh();
    const stopNode = client.on('node.changed', () => void refresh());
    const stopInputs = client.on('inputs.changed', () => void refresh());
    return () => { active = false; stopNode(); stopInputs(); };
  }, [client]);

  if (!state || frames < 2) return <div className="face"><div className="empty">连接两张图片，或一个结果组</div></div>;
  return <div className="face">
    <div className="summary">
      <p className="summary-title">{frames} 帧 → {outputCount(frames, state)} 帧</p>
      <p className="count">{methodLabel(state.method)} · 每两帧之间补 {state.between} 帧</p>
    </div>
  </div>;
}
