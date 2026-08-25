import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import canvasEditorSource from './CanvasEditor.tsx?raw';

declare const process: { cwd: () => string };

const tokenSource = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf-8');

describe('canvas chrome spatial hierarchy', () => {
  it('places project state at the top, configuration at top-right, and primary tools bottom-center', () => {
    expect(canvasEditorSource).toContain('canvas-editor-top');
    expect(canvasEditorSource).toContain('canvas-config-dock');
    expect(canvasEditorSource).toContain('canvas-config-dock contents md:absolute');
    expect(canvasEditorSource).toContain('canvas-tool-dock contents md:absolute');
    expect(tokenSource).toContain('left: 50%');
    expect(canvasEditorSource).not.toContain('canvas-tool-rail');
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
    expect(canvasEditorSource).toContain('hidden xl:contents');
    expect(canvasEditorSource).toContain('xl:hidden');
  });

  it('anchors docks, add menu, and library panel to safe areas without collisions', () => {
    expect(tokenSource).toContain('.canvas-mobile-rail');
    expect(tokenSource).toContain('.canvas-tool-dock');
    expect(tokenSource).toContain('.canvas-add-menu');
    expect(tokenSource).toContain('.canvas-config-dock');
    expect(tokenSource).toContain('.canvas-library-panel');
    expect(tokenSource).toMatch(
      /@media \(min-width: 48rem\) and \(max-width: 63\.999rem\) \{[\s\S]*?\.canvas-tool-dock \{[\s\S]*?\+ 4\.25rem[\s\S]*?\.canvas-add-menu \{[\s\S]*?\+ 8\.25rem/,
    );
    expect(tokenSource).toMatch(
      /@media \(min-width: 48rem\) \{[\s\S]*?\.canvas-library-panel \{\s*left: max\(1rem, env\(safe-area-inset-left\)\)/,
    );
    expect(canvasEditorSource).not.toContain('md:bottom-14');
    expect(tokenSource).not.toContain('.canvas-tool-rail');
  });
});
