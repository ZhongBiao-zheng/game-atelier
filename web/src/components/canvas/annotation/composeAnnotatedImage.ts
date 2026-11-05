import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnnotationLayer } from './AnnotationLayer';
import type { AnnotationElement } from './annotationModel';
async function drawAnnotationOverlay(context: CanvasRenderingContext2D, elements: AnnotationElement[], width: number, height: number) {
  await document.fonts?.ready;
  const svg = renderToStaticMarkup(createElement(AnnotationLayer, { elements, imageWidth: width, imageHeight: height }));
  const overlayUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const overlay = new Image(); overlay.src = overlayUrl; await overlay.decode();
    context.drawImage(overlay, 0, 0, width, height);
  } finally { URL.revokeObjectURL(overlayUrl); }
}
function toPngFile(canvas: HTMLCanvasElement, name: string) {
  return new Promise<File>((resolve, reject) => canvas.toBlob(value => value
    ? resolve(new File([value], name, { type: 'image/png' })) : reject(new Error('标注合成失败')), 'image/png'));
}
/** 原图 + 标注一起烙进一张 PNG（合成图），给不认 markup 的模型。 */
export async function composeAnnotatedImage(sourceUrl: string, elements: AnnotationElement[], width: number, height: number): Promise<File> {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('读取标注原图失败');
  const sourceUrlObject = URL.createObjectURL(await response.blob());
  try {
    const source = new Image(); source.src = sourceUrlObject; await source.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建标注合成画布');
    context.drawImage(source, 0, 0, width, height);
    await drawAnnotationOverlay(context, elements, width, height);
    return toPngFile(canvas, 'annotation.png');
  } finally { URL.revokeObjectURL(sourceUrlObject); }
}
/** 只有标注、背景透明的同尺寸 PNG（GPT Image 2.6 的 markup 标注层）；原图另发。 */
export async function composeAnnotationMarkup(elements: AnnotationElement[], width: number, height: number): Promise<File> {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建标注合成画布');
  await drawAnnotationOverlay(context, elements, width, height);
  return toPngFile(canvas, 'markup.png');
}
