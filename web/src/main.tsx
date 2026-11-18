import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { App } from './App';
import { applyTheme, loadTheme, startThemeSync } from './lib/theme';
import { startAccentSync } from './lib/accentTheme';

// 渲染前先落主题类，避免浅色用户刷新时闪一帧暗色
applyTheme(loadTheme());
startThemeSync();
// 本机缓存只管首帧；连上本机服务后以服务端为准。
startAccentSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
