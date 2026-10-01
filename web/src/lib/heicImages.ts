import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { request } from '@/api/http';
import { uploadReferenceImage } from '@/api/studio';

/** iPhone 照片 / 实况图的静态帧是 HEIC。Chrome、Edge 解不了，选进来的 File 直接预览会是破图；
 *  服务端上传入口会把它转成 JPEG（见 heic_upload.py），这里借那条路把本地 File 换成 JPEG。 */
const HEIC_NAME = /\.(heic|heif)$/i;

export function isHeicFile(file: File): boolean {
  return HEIC_NAME.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif';
}

export async function heicFileAsJpeg(file: File): Promise<File> {
  const stem = file.name.replace(HEIC_NAME, '') || 'photo';
  // 服务端按扩展名认 HEIC；粘贴进来的文件可能没有扩展名，补上。
  const named = HEIC_NAME.test(file.name) ? file : new File([file], `${stem}.heic`, { type: file.type });
  const path = await uploadReferenceImage(named);
  const response = await request(`/api/raw?path=${encodeURIComponent(path)}`, '读取转换后的照片');
  return new File([await response.blob()], `${stem}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
}

/** 单个文件、文件数组，或「槽位 → 文件 / 文件数组」的对象（MJ 四组参考、首尾帧）。 */
type FileSlots = File | null | readonly File[] | object;

function filesIn(value: FileSlots): File[] {
  if (value === null) return [];
  if (value instanceof File) return [value];
  if (Array.isArray(value)) return [...value];
  return Object.values(value).flatMap(slot => filesIn(slot as FileSlots));
}

function replaceFiles<T extends FileSlots>(value: T, converted: ReadonlyMap<File, File>): T {
  if (value === null) return value;
  if (value instanceof File) return (converted.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map(file => converted.get(file) ?? file) as unknown as T;
  return Object.fromEntries(Object.entries(value).map(([slot, files]) => [
    slot, replaceFiles(files as FileSlots, converted),
  ])) as T;
}

/** 状态里一出现 HEIC 就在后台换成 JPEG，按 File 身份原位替换；不管它是从哪个入口进来的。 */
export function useHeicAsJpeg<T extends FileSlots>(
  value: T,
  setValue: Dispatch<SetStateAction<T>>,
  onError: (message: string) => void,
) {
  const seen = useRef(new WeakSet<File>());
  useEffect(() => {
    const pending = filesIn(value).filter(file => isHeicFile(file) && !seen.current.has(file));
    if (!pending.length) return;
    pending.forEach(file => seen.current.add(file));
    void Promise.all(pending.map(async file => [file, await heicFileAsJpeg(file)] as const))
      .then(pairs => setValue(current => replaceFiles(current, new Map(pairs))))
      .catch(error => onError(error instanceof Error ? error.message : 'HEIC 照片转换失败'));
  }, [value, setValue, onError]);
}
