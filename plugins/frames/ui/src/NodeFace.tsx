import { useEffect, useState } from 'react';

import type { PluginClient } from '../../../sdk';
import { modeSummary, parseState, type ExtractState } from './state';

/** 节点内容面：连入的视频与抽帧设置摘要。设置与预览在面板里做（双击节点打开）。 */
export function NodeFace({ client }: { client: PluginClient }) {
  const [state, setState] = useState<ExtractState | null>(null);
  const [video, setVideo] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const node = await client.node.readSelf();
        const input = (await client.inputs.list()).find(item => item.kind === 'video');
        if (!active) return;
        setState(parseState(node.payload));
        setVideo(input ? input.title : null);
      } catch {
        if (active) setVideo(null);
      }
    };
    void refresh();
    const stopNode = client.on('node.changed', () => void refresh());
    const stopInputs = client.on('inputs.changed', () => void refresh());
    return () => { active = false; stopNode(); stopInputs(); };
  }, [client]);

  if (!video || !state) return <div className="face"><div className="empty">连接一个视频</div></div>;
  return <div className="face">
    <div className="summary">
      <p className="summary-title">{video}</p>
      <p className="count">{modeSummary(state)}{state.sheet ? ' · 拼成精灵表' : ''}</p>
    </div>
  </div>;
}
