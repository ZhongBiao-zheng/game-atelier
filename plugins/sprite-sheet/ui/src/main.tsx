import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { connect } from '../../../sdk';
import { NodeFace } from './NodeFace';
import { Panel } from './Panel';
import './styles.css';

void connect().then(client => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{client.surface === 'panel' ? <Panel client={client} /> : <NodeFace client={client} />}</StrictMode>,
  );
});
