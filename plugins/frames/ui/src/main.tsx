import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { connect } from '../../../sdk';
import { ExtractFace } from './ExtractFace';
import { ExtractPanel } from './ExtractPanel';
import { TweenFace } from './TweenFace';
import { TweenPanel } from './TweenPanel';
import './styles.css';

// 一个界面包服务两种节点：按节点类型挑界面。
void connect().then(async client => {
  const tween = (await client.node.readSelf()).node_type === 'tween';
  const view = client.surface === 'panel'
    ? (tween ? <TweenPanel client={client} /> : <ExtractPanel client={client} />)
    : (tween ? <TweenFace client={client} /> : <ExtractFace client={client} />);
  createRoot(document.getElementById('root')!).render(<StrictMode>{view}</StrictMode>);
});
