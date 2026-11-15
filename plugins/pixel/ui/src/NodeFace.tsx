import { useEffect, useState } from 'react';

import type { PluginClient } from '../../../sdk';
import { parseState, summary, type PixelState } from './state';

/** 节点内容面：输入张数与像素化设置摘要。设置与预览在面板里做（双击节点打开）。 */
export function NodeFace({ client }: { client: PluginClient }) {
  const [state, setState] = useState<PixelState | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const node = await client.node.readSelf();
        const images = (await client.inputs.list()).filter(input => input.kind === 'image');
        if (!active) return;
        setState(parseState(node.payload));
        setCount(images.length);
      } catch {
        if (active) setCount(0);
      }
    };
    void refresh();
    const stopNode = client.on('node.changed', () => void refresh());
    const stopInputs = client.on('inputs.changed', () => void refresh());
    return () => { active = false; stopNode(); stopInputs(); };
  }, [client]);

  if (!state || count === 0) return <div className="face"><div className="empty">连接一张图片，或一个结果组</div></div>;
  return <div className="face">
    <div className="summary">
      <p className="summary-title">{count} 张</p>
      <p className="count">{summary(state)}</p>
    </div>
  </div>;
}
