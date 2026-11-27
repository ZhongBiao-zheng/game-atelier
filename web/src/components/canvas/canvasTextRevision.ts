/** 文本节点「改写」：面板交给编辑器的请求，选区是 textarea 的 UTF-16 下标。 */
export interface CanvasTextRevisionInput {
  instruction: string;
  selection: { start: number; end: number } | null;
  alias: string | null;
  model: string;
}

/** textarea 给的是 UTF-16 下标，服务端按 Unicode 码点切片；表情等代理对会让两者错位。 */
export function codePointRange(text: string, range: { start: number; end: number }) {
  const start = Array.from(text.slice(0, range.start)).length;
  return { start, end: start + Array.from(text.slice(range.start, range.end)).length };
}

/** 「选中 N 字」按码点数，表情算一个字，换行与空格不算。 */
export function selectedCharacterCount(text: string, range: { start: number; end: number } | null) {
  return range ? Array.from(text.slice(range.start, range.end)).filter(char => !/\s/u.test(char)).length : 0;
}

/** 文本节点面板默认页：有正文看内容，空节点去生成。 */
export function defaultTextPanelTab(text: string | null | undefined): 'content' | 'generate' {
  return text?.trim() ? 'content' : 'generate';
}
