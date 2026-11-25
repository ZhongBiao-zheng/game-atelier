import { StrictMode } from 'react';
import { MotionConfig } from 'motion/react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import { App } from './App';
import { TooltipProvider } from './components/ui/tooltip';
import { applyTheme, loadTheme, startThemeSync } from './lib/theme';
import { startAccentSync } from './lib/accentTheme';

// 渲染前先落主题类，避免浅色用户刷新时闪一帧暗色
applyTheme(loadTheme());
startThemeSync();
// 本机缓存只管首帧；连上本机服务后以服务端为准。
startAccentSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 系统开了「减弱动态效果」时，motion 的位移与缩放动画一律直接到位。 */}
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </MotionConfig>
  </StrictMode>,
);
