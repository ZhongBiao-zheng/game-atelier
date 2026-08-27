import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import canvasEditorSource from './CanvasEditor.tsx?raw';

declare const process: { cwd: () => string };

const tokenSource = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf-8');
const libraryPanelSource = readFileSync(
  `${process.cwd()}/src/components/canvas/CanvasLibraryPanel.tsx`,
  'utf-8',
);

describe('canvas chrome spatial hierarchy', () => {
  it('keeps project state on top and the primary tools in a left vertical rail', () => {
    expect(canvasEditorSource).toContain('canvas-editor-top');
    expect(canvasEditorSource).toContain('canvas-tool-dock contents md:absolute');
    expect(canvasEditorSource).toContain('canvas-mobile-rail absolute left-3 top-1/2');
    // 桌面主工具条是左侧竖排，不是底部居中。
    expect(tokenSource).toMatch(
      /@media \(min-width: 48rem\) \{[\s\S]*?\.canvas-tool-dock \{[\s\S]*?left: max\(1rem, env\(safe-area-inset-left\)\)/,
    );
    expect(tokenSource).toMatch(/\.canvas-tool-dock \{[\s\S]*?transform: translateY\(-50%\)/);
  });

  it('keeps direct desktop creation actions and a compact medium/mobile add entry', () => {
    for (const label of [
      '添加节点',
      '添加文本节点',
      '添加图片节点',
      '添加视频节点',
      '添加音频节点',
      '添加生成配置节点',
      '上传素材',
    ]) {
      expect(canvasEditorSource).toContain(`label="${label}"`);
    }
    // 文本节点与生成配置合并后不再有独立的 LLM 节点入口。
    expect(canvasEditorSource).not.toContain('添加 LLM 节点');
    expect(canvasEditorSource).toContain('hidden xl:contents');
    expect(canvasEditorSource).toContain('xl:hidden');
  });

  it('anchors docks, add menu, and library panel to safe areas without collisions', () => {
    expect(tokenSource).toContain('.canvas-mobile-rail');
    expect(tokenSource).toContain('.canvas-tool-dock');
    expect(tokenSource).toContain('.canvas-add-menu');
    expect(tokenSource).toContain('.canvas-zoom-dock');
    expect(tokenSource).toContain('.canvas-library-panel');
    expect(tokenSource).toContain('.canvas-flow .react-flow__minimap.canvas-minimap');
    expect(tokenSource).toContain('left: max(15px, env(safe-area-inset-left)) !important');
    // 添加菜单贴着左侧工具条右缘展开，不压住 rail。
    expect(tokenSource).toMatch(
      /\.canvas-add-menu \{[\s\S]*?left: calc\(max\(1rem, env\(safe-area-inset-left\)\) \+ 3\.75rem\)/,
    );
    // 缩放与画布设置合并到左下同一组，创作库停靠右侧并按断点上抬避让。
    expect(tokenSource).toMatch(
      /\.canvas-zoom-dock \{\s*left: max\(0\.75rem, env\(safe-area-inset-left\)\)/,
    );
    expect(tokenSource).toMatch(
      /@media \(min-width: 48rem\) \{[\s\S]*?\.canvas-library-panel \{[\s\S]*?right: max\(1rem, env\(safe-area-inset-right\)\)[\s\S]*?\+ 3\.375rem/,
    );
    expect(tokenSource).toMatch(
      /@media \(min-width: 48rem\) and \(max-width: 63\.999rem\) \{[\s\S]*?\.canvas-library-panel \{[\s\S]*?\+ 8\.125rem/,
    );
    expect(libraryPanelSource).toContain('canvas-library-panel absolute top-20');
    expect(tokenSource).toMatch(/\.canvas-editor-region \{[\s\S]*?overscroll-behavior: none/);
    // 已删除的遗留类名不得回流。
    expect(tokenSource).not.toContain('.canvas-tool-rail');
    expect(canvasEditorSource).not.toContain('canvas-config-dock');
  });
});
