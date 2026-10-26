import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnnotationLayer } from './AnnotationLayer';
import type { AnnotationElement } from './annotationModel';
export async function composeAnnotatedImage(sourceUrl: string, elements: AnnotationElement[], width: number, height: number): Promise<File> {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('读取标注原图失败');
  const sourceUrlObject = URL.createObjectURL(await response.blob());
  let overlayUrl: string | undefined;
  try {
    await document.fonts?.ready;
    const source = new Image(); source.src = sourceUrlObject; await source.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建标注合成画布');
    context.drawImage(source, 0, 0, width, height);
    const svg = renderToStaticMarkup(createElement(AnnotationLayer, { elements, imageWidth: width, imageHeight: height }));
    overlayUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const overlay = new Image(); overlay.src = overlayUrl; await overlay.decode();
    context.drawImage(overlay, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('标注合成失败')), 'image/png'));
    return new File([blob], 'annotation.png', { type: 'image/png' });
  } finally { URL.revokeObjectURL(sourceUrlObject); if (overlayUrl) URL.revokeObjectURL(overlayUrl); }
}
