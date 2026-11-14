import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// B1 只验证构建与打包链路；节点面与编辑面板在后续批次接入沙箱运行时后实现。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main>精灵表调整</main>
  </StrictMode>,
);
