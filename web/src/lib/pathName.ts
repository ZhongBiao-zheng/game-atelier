/** 服务端给的是本机路径：macOS / Linux 用 `/`，Windows 用 `\`，两种分隔符都要拆。 */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]/);
}

/** 路径里的文件名；末尾是分隔符时返回空串，由调用处兜底。 */
export function pathFileName(path: string): string {
  return pathSegments(path).pop() ?? '';
}
