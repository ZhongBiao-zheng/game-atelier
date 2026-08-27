import type { CanvasMediaVersion } from '@/schema/canvas';

export function formatCanvasBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCanvasImageInfo(version: CanvasMediaVersion) {
  const dimensions = version.width && version.height
    ? `${version.width} × ${version.height}`
    : null;
  return [dimensions, formatCanvasBytes(version.bytes)].filter(Boolean).join(' · ');
}
