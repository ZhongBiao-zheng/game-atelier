import { convertToExcalidrawElements, exportToBlob, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawFrameElement, ExcalidrawImageElement, FileId } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, BinaryFiles, DataURL } from '@excalidraw/excalidraw/types';
import type { CanvasImageAnnotation } from '@/schema/canvas';

export const ANNOTATION_SOURCE_ID = 'annotation-source';
const ANNOTATION_TYPES = new Set(['freedraw', 'rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text']);
export const ANNOTATION_COLOR = '#e03131';

export function annotationElements(elements: readonly ExcalidrawElement[]) {
  return elements.filter(element => !element.isDeleted && ANNOTATION_TYPES.has(element.type))
    .map(element => ({ ...element, link: null, frameId: null }));
}

export function serializeAnnotation(elements: readonly ExcalidrawElement[]): CanvasImageAnnotation['elements'] {
  const scene = JSON.parse(JSON.stringify(annotationElements(elements))) as CanvasImageAnnotation['elements'];
  if (scene.length > 2000 || new TextEncoder().encode(JSON.stringify(scene)).length > 2 * 1024 * 1024) {
    throw new Error('标注过多，请删除部分笔迹后再保存。');
  }
  return scene;
}

export async function loadAnnotationSource(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('源图片加载失败，请重新打开标注。');
  const blob = await response.blob();
  const dataURL = await new Promise<DataURL>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = () => reject(new Error('读取源图片失败。'));
    reader.readAsDataURL(blob);
  });
  const image = new Image();
  image.src = dataURL;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error('无法读取图片尺寸。');
  const fileId = ANNOTATION_SOURCE_ID as FileId;
  const source = convertToExcalidrawElements([{
    type: 'image', id: ANNOTATION_SOURCE_ID, x: 0, y: 0, width, height,
    fileId, status: 'saved', locked: true,
  }], { regenerateIds: false })[0] as ExcalidrawImageElement;
  const files: BinaryFiles = { [fileId]: { id: fileId, dataURL, mimeType: blob.type as BinaryFileData['mimeType'], created: Date.now() } };
  return { source, files, width, height };
}

export function restoreAnnotation(annotation?: CanvasImageAnnotation | null) {
  return annotation ? annotationElements(restoreElements(annotation.elements as unknown as ExcalidrawElement[], null)) : [];
}

export async function exportAnnotation(source: ExcalidrawImageElement, elements: readonly ExcalidrawElement[], files: BinaryFiles) {
  // An explicit frame keeps strokes crossing the image edge from changing output size or offset.
  const frameElement = convertToExcalidrawElements([{
    type: 'frame', id: 'annotation-export-frame', children: [], x: 0, y: 0, width: source.width, height: source.height,
  }], { regenerateIds: false })[0] as ExcalidrawFrameElement;
  // The converter derives frame bounds from children and adds padding even for an empty frame.
  const frame = { ...frameElement, x: 0, y: 0, width: source.width, height: source.height };
  return exportToBlob({
    elements: [source, ...annotationElements(elements)].map(element => ({ ...element, isDeleted: false as const, frameId: frame.id })),
    files, exportingFrame: frame, exportPadding: 0,
    appState: { exportBackground: false, exportWithDarkMode: false, frameRendering: { enabled: true, clip: true, name: false, outline: false } },
    getDimensions: () => ({ width: source.width, height: source.height, scale: 1 }),
  });
}
